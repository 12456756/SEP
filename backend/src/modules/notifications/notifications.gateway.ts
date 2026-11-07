import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { RawData, Server, WebSocket } from 'ws';
import { JwtService } from '@nestjs/jwt';
import { forwardRef, Inject } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  sessionId?: string;
  authTimer?: NodeJS.Timeout;
  authenticating?: boolean;
  closed?: boolean;
}

interface NotificationWebSocketJwtPayload {
  sub?: string;
  sid?: string;
  type?: string;
}

/**
 * WebSocket 网关 - 实时推送通知
 *
 * 使用原生 WebSocket (ws)，与前端 use-websocket.ts 兼容
 * JWT 在连接建立后通过首条 `auth` JSON 消息传递，不进入 URL 或握手子协议。
 */
@WebSocketGateway({ path: '/ws/notifications' })
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private readonly clients = new Map<string, Set<AuthenticatedWebSocket>>();

  constructor(
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => NotificationsService)) private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized: /ws/notifications');
  }

  async handleConnection(client: AuthenticatedWebSocket, req: any) {
    try {
      client.closed = false;
      const origin = req.headers.origin as string | undefined;
      const allowed = (this.config.get<string>('CORS_ORIGIN') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      // 浏览器连接会带 Origin；Electron/Node 原生客户端通常不会带 Origin，
      // 但仍必须在连接建立后 5 秒内通过 JWT 认证。
      if (allowed.length > 0 && origin && !allowed.includes(origin)) {
        this.closeClient(client, 1008, 'Origin not allowed');
        return;
      }
      client.authTimer = setTimeout(
        () => this.closeClient(client, 1008, 'Authentication timeout'),
        5000,
      );
      client.on('message', async (raw) => {
        await this.handleMessage(client, raw);
      });
    } catch (error) {
      this.logger.error('Connection error:', error);
      this.closeClient(client, 1011, 'Internal error');
    }
  }

  private async handleMessage(client: AuthenticatedWebSocket, raw: RawData) {
    if (client.closed || client.readyState !== WebSocket.OPEN) return;
    let input: unknown;
    try {
      input = JSON.parse(raw.toString());
    } catch {
      this.closeClient(client, 1008, 'Invalid message');
      return;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      this.closeClient(client, 1008, 'Invalid message');
      return;
    }
    const message = input as { type?: unknown; token?: unknown };

    if (client.userId) {
      if (message.type === 'ping') await this.handlePing(client);
      return;
    }

    if (client.authenticating) return;
    if (message.type !== 'auth' || typeof message.token !== 'string' || !message.token) {
      this.closeClient(client, 1008, 'Authentication required');
      return;
    }

    let payload: NotificationWebSocketJwtPayload;
    try {
      payload = this.jwtService.verify<NotificationWebSocketJwtPayload>(message.token, {
        secret: this.jwtSecret,
      });
    } catch {
      this.closeClient(client, 1008, 'Invalid token');
      return;
    }

    if (payload?.type !== 'access' || typeof payload.sub !== 'string' || !payload.sub.trim() ||
        typeof payload.sid !== 'string' || !payload.sid.trim()) {
      this.closeClient(client, 1008, 'Invalid token');
      return;
    }

    client.authenticating = true;
    try {
      const user = await this.authService.validateUser(payload.sub, payload.sid);
      if (client.closed || client.readyState !== WebSocket.OPEN) return;
      if (!user) {
        this.closeClient(client, 1008, 'Invalid token');
        return;
      }

      const unreadCount = await this.notificationsService.countUnread(user.id);
      if (client.closed || client.readyState !== WebSocket.OPEN) return;
      this.clearAuthTimer(client);
      client.userId = user.id;
      client.sessionId = payload.sid;
      const clients = this.clients.get(user.id) ?? new Set<AuthenticatedWebSocket>();
      clients.add(client);
      this.clients.set(user.id, clients);
      this.sendToClient(client, { type: 'connected', data: { unreadCount }, timestamp: Date.now() });
    } catch (error) {
      if (client.closed || client.readyState !== WebSocket.OPEN) return;
      this.logger.error('Notification WebSocket authentication initialization failed:', error);
      this.closeClient(client, error instanceof UnauthorizedException ? 1008 : 1011,
        error instanceof UnauthorizedException ? 'Invalid token' : 'Internal error');
    } finally {
      client.authenticating = false;
    }
  }

  handleDisconnect(client: AuthenticatedWebSocket) {
    client.closed = true;
    this.clearAuthTimer(client);
    const userId = client.userId;
    if (userId) {
      const userClients = this.clients.get(userId);
      if (userClients) {
        userClients.delete(client);
        if (userClients.size === 0) {
          this.clients.delete(userId);
        }
      }
      this.logger.log(`Client disconnected: userId=${userId}`);
    }
    client.userId = undefined;
    client.sessionId = undefined;
  }

  /**
   * 心跳 ping - 前端每 30s 发送一次
   */
  async handlePing(client: AuthenticatedWebSocket) {
    if (!client.userId || !client.sessionId) return;
    try {
      const user = await this.authService.validateUser(client.userId, client.sessionId);
      if (!user) {
        this.closeClient(client, 1008, 'Session expired');
        return;
      }
    } catch (error) {
      this.closeClient(client, error instanceof UnauthorizedException ? 1008 : 1011,
        error instanceof UnauthorizedException ? 'Session expired' : 'Internal error');
      return;
    }
    this.sendToClient(client, { type: 'pong', timestamp: Date.now() });
  }

  /**
   * 推送通知给指定用户（所有在线客户端）
   */
  async pushToUser(userId: string, notification: any) {
    const userClients = this.clients.get(userId);
    if (!userClients || userClients.size === 0) {
      this.logger.debug(`User ${userId} not connected, skipping push`);
      return;
    }

    await this.sendToActiveClients(userId, {
      type: 'notification',
      data: notification,
      timestamp: Date.now(),
    });
  }

  /**
   * 推送未读数更新
   */
  async pushUnreadCount(userId: string, count: number) {
    const userClients = this.clients.get(userId);
    if (!userClients || userClients.size === 0) return;

    await this.sendToActiveClients(userId, {
      type: 'unread_count',
      data: { count },
      timestamp: Date.now(),
    });
  }

  private async sendToActiveClients(userId: string, message: any): Promise<void> {
    const userClients = this.clients.get(userId);
    if (!userClients) return;
    await Promise.all([...userClients].map(async (client) => {
      if (!client.sessionId) {
        this.closeClient(client, 1008, 'Session expired');
        return;
      }
      try {
        const user = await this.authService.validateUser(userId, client.sessionId);
        if (!user) {
          this.closeClient(client, 1008, 'Session expired');
          return;
        }
        this.sendToClient(client, message);
      } catch (error) {
        this.closeClient(client, error instanceof UnauthorizedException ? 1008 : 1011,
          error instanceof UnauthorizedException ? 'Session expired' : 'Internal error');
      }
    }));
  }

  private sendToClient(client: AuthenticatedWebSocket, message: any) {
    if (client.closed) return;
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(message), (error) => {
          if (error) this.closeClient(client, 1011, 'Internal error');
        });
      } catch {
        this.logger.warn('Notification WebSocket send failed');
        this.closeClient(client, 1011, 'Internal error');
      }
    }
  }

  private clearAuthTimer(client: AuthenticatedWebSocket) {
    if (client.authTimer) {
      clearTimeout(client.authTimer);
      client.authTimer = undefined;
    }
  }

  private closeClient(client: AuthenticatedWebSocket, code: number, reason: string) {
    if (client.closed) return;
    this.handleDisconnect(client);
    try {
      client.close(code, reason);
    } catch {
      this.logger.warn('Notification WebSocket close failed');
    }
  }

  private get jwtSecret(): string {
    return this.config.get<string>('ACCESS_JWT_SECRET') ?? this.config.getOrThrow<string>('JWT_SECRET');
  }
}
