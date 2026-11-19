import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, WebSocket } from 'ws';
import { EnterpriseService } from './enterprise.service';
import { ConfigService } from '@nestjs/config';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

interface Client extends WebSocket { userId?: string; authTimer?: NodeJS.Timeout }

type EmployeeStatuses = Awaited<ReturnType<EnterpriseService['getEmployeeStatuses']>>;
type StatusCacheEntry = { expiresAt: number; value: EmployeeStatuses };

const STATUS_BROADCAST_INTERVAL_MS = 3_000;
const STATUS_CACHE_TTL_MS = 2_500;
const MAX_CONCURRENT_STATUS_QUERIES = 8;

@WebSocketGateway({ path: '/ws/employee-status' })
export class EmployeeStatusGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EmployeeStatusGateway.name);
  private readonly clients = new Map<string, Set<Client>>();
  private readonly statusCache = new Map<string, StatusCacheEntry>();
  private readonly statusRequests = new Map<string, Promise<EmployeeStatuses>>();
  private readonly statusQueryWaiters: Array<() => void> = [];
  private activeStatusQueries = 0;
  private broadcastInProgress = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly jwt: JwtService, private readonly enterprise: EnterpriseService, private readonly config: ConfigService) {}

  onModuleInit() { this.timer = setInterval(() => void this.broadcast(), STATUS_BROADCAST_INTERVAL_MS); }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.statusCache.clear();
    this.statusRequests.clear();
    this.statusQueryWaiters.length = 0;
  }

  async handleConnection(client: Client, req: any) {
    try {
      const origin = req.headers.origin as string | undefined;
      const allowed = (this.config.get<string>('CORS_ORIGIN') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      if (allowed.length > 0 && (!origin || !allowed.includes(origin))) {
        return client.close(1008, 'Origin not allowed');
      }
      client.authTimer = setTimeout(() => client.close(1008, 'Authentication timeout'), 5000);
      client.on('message', async (raw) => {
        if (client.userId) return;
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; token?: string };
          if (message.type !== 'auth' || !message.token) return client.close(1008, 'Authentication required');
          const userId = this.jwt.verify<{ sub?: string }>(message.token).sub;
          if (!userId) return client.close(1008, 'Invalid token');
          clearTimeout(client.authTimer);
          client.userId = userId;
          const set = this.clients.get(userId) ?? new Set<Client>();
          set.add(client); this.clients.set(userId, set);
          await this.sendStatuses(client, userId);
        } catch (error) {
          if (!client.userId) client.close(1008, 'Invalid token');
          else {
            const diagnostic = exceptionDetails(error);
            this.logger.error({ event: 'employee_status_failed', diagnostic });
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', error: diagnostic }));
            client.close(1011, 'Employee status query failed');
          }
        }
      });
    } catch (error) {
      this.logger.error({ event: 'employee_status_connection_failed', diagnostic: exceptionDetails(error) });
      client.close(1011, 'Employee status connection failed');
    }
  }

  handleDisconnect(client: Client) {
    clearTimeout(client.authTimer);
    if (!client.userId) return;
    const set = this.clients.get(client.userId);
    set?.delete(client);
    if (!set || set.size === 0) {
      this.clients.delete(client.userId);
      this.statusCache.delete(client.userId);
    }
  }

  private async broadcast() {
    if (this.broadcastInProgress) return;
    this.broadcastInProgress = true;
    try {
      const entries = Array.from(this.clients.entries());
      await Promise.all(entries.map(async ([userId, clients]) => {
        try {
          const statuses = await this.getStatuses(userId);
          const payload = JSON.stringify({ type: 'status_update', data: statuses, timestamp: Date.now() });
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN && this.clients.get(userId)?.has(client)) client.send(payload);
          }
        } catch (error) {
          const diagnostic = exceptionDetails(error);
          this.logger.warn({ event: 'employee_status_broadcast_failed', diagnostic });
          for (const client of clients) if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'error', error: diagnostic }));
          }
        }
      }));
    } finally {
      this.broadcastInProgress = false;
    }
  }

  private async sendStatuses(client: Client, userId: string) {
    const statuses = await this.getStatuses(userId);
    if (client.readyState === WebSocket.OPEN && this.clients.get(userId)?.has(client)) {
      client.send(JSON.stringify({ type: 'status_update', data: statuses, timestamp: Date.now() }));
    }
  }

  private getStatuses(userId: string): Promise<EmployeeStatuses> {
    const cached = this.statusCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    const inFlight = this.statusRequests.get(userId);
    if (inFlight) return inFlight;

    const request = this.runStatusQuery(async () => {
      const value = await this.enterprise.getEmployeeStatuses(userId);
      // A disconnected user must not leave a cache entry behind when its slow
      // request resolves after the last socket has gone away.
      if (this.clients.has(userId)) {
        this.statusCache.set(userId, { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
      }
      return value;
    }).finally(() => {
      this.statusRequests.delete(userId);
    });
    this.statusRequests.set(userId, request);
    return request;
  }

  private async runStatusQuery<T>(query: () => Promise<T>): Promise<T> {
    if (this.activeStatusQueries >= MAX_CONCURRENT_STATUS_QUERIES) {
      await new Promise<void>((resolve) => this.statusQueryWaiters.push(resolve));
    }

    this.activeStatusQueries += 1;
    try {
      return await query();
    } finally {
      this.activeStatusQueries -= 1;
      this.statusQueryWaiters.shift()?.();
    }
  }
}
