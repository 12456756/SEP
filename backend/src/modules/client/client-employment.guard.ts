import { HttpException, Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { SessionService } from '../auth/session.service';
import { GatewayAuthRateLimitService } from '../gateway/gateway-auth-rate-limit.service';

export interface ClientEmploymentClaims {
  sub: string;         // userId
  sid: string;
  enterpriseId: string;
  subscriptionId: string;
  memberId: string;
  type: 'client-employment';
  iat: number;
  exp: number;
}

@Injectable()
export class ClientEmploymentGuard implements CanActivate {
  private readonly maxTokenBytes: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly authRateLimit: GatewayAuthRateLimitService,
  ) {
    const configured = config.get<string | number>('GATEWAY_AUTH_TOKEN_MAX_BYTES') ?? 4096;
    const limit = typeof configured === 'number' || /^\d+$/.test(configured) ? Number(configured) : NaN;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 65_536) {
      throw new InternalServerErrorException('GATEWAY_AUTH_TOKEN_MAX_BYTES must be between 1 and 65536');
    }
    this.maxTokenBytes = limit;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { clientEmployment?: ClientEmploymentClaims }>();
    delete req.clientEmployment;
    const auth = req.headers.authorization;
    if (typeof auth !== 'string') return this.reject(context, 'missing-or-invalid-header');
    if (auth.length > this.maxTokenBytes + 7 || Buffer.byteLength(auth, 'utf8') > this.maxTokenBytes + 7) {
      return this.reject(context, 'oversized-header');
    }
    const match = /^Bearer (\S+)$/i.exec(auth);
    if (!match) return this.reject(context, 'invalid-bearer-format');

    const token = match[1];
    const fingerprint = createHash('sha256').update(token).digest('hex');
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      return this.reject(context, fingerprint);
    }
    const secret = this.config.get<string>('ACCESS_JWT_SECRET') ?? this.config.getOrThrow<string>('JWT_SECRET');

    let payload: any;
    try {
      payload = this.jwtService.verify(token, { secret, algorithms: ['HS256'] });
    } catch {
      return this.reject(context, fingerprint);
    }

    if (!payload || payload.type !== 'client-employment') {
      return this.reject(context, fingerprint);
    }

    if (['sub', 'sid', 'enterpriseId', 'memberId', 'subscriptionId'].some((field) =>
      typeof payload[field] !== 'string' || !payload[field].trim(),
    ) || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      return this.reject(context, fingerprint);
    }

    try {
      await this.sessions.assertActiveSession(payload.sid, payload.sub, 'DESKTOP');
      await this.sessions.assertEnterpriseActive(payload.enterpriseId);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      return this.reject(context, fingerprint);
    }

    req.clientEmployment = payload as ClientEmploymentClaims;
    return true;
  }

  private async reject(context: ExecutionContext, fingerprint: string): Promise<never> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const rateLimit = await this.authRateLimit.consumeFailure(fingerprint, req.socket.remoteAddress ?? 'unknown');
    if (!rateLimit.allowed) {
      http.getResponse<Response>().setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      throw new HttpException({
        error: {
          message: 'Too many failed authentication attempts', type: 'rate_limit_error',
          code: 'GATEWAY_AUTH_RATE_LIMIT_EXCEEDED', source: 'platform', param: null, rateLimit,
        },
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      }, 429);
    }
    throw new UnauthorizedException('Invalid or expired employment token; obtain a new employment token');
  }
}
