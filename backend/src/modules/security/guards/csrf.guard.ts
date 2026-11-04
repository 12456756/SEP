import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

/**
 * CSRF Guard - 防止跨站请求伪造攻击
 *
 * 策略：
 * 1. GET/HEAD/OPTIONS 请求：放行（幂等操作）
 * 2. POST/PUT/DELETE/PATCH 请求：验证 Origin/Referer 头
 * 3. 允许的源从环境变量 CORS_ORIGIN 读取
 * 4. 开发环境（localhost）放宽限制
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private allowedOrigins: Set<string>;
  private isProduction: boolean;

  constructor(private reflector: Reflector) {
    this.isProduction = process.env.NODE_ENV === 'production';
    const origins = (process.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    // 开发环境添加 localhost
    if (!this.isProduction) {
      origins.push('http://localhost:3000', 'http://localhost:4173');
    }

    this.allowedOrigins = new Set(
      origins.map((origin) => new URL(origin).origin)
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();

    // 幂等方法放行
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return true;
    }

    // 健康检查端点放行
    if (request.path === '/health' || request.path === '/api/health') {
      return true;
    }

    // Pure Bearer authentication also handles missing/malformed credentials and
    // counts failures; CSRF must not reject those before the route guard runs.
    const path = request.path.replace(/\/$/, '').toLowerCase();
    if (
      method === 'POST' && path === '/api/gateway/v1/chat/completions'
    ) {
      return true;
    }

    // 桌面客户端认证使用请求体中的凭证，不依赖浏览器 Cookie，因此 Electron/Node
    // 请求没有 Origin/Referer 时也应允许认证流程通过。仅精确放行认证端点，
    // 其他 /api/client/* 写接口仍继续执行来源校验。
    if (
      method === 'POST' && [
        '/api/client/auth/login',
        '/api/client/auth/refresh',
        '/api/client/auth/token',
        '/api/client/auth/logout',
      ].includes(path)
    ) {
      return true;
    }

    // Connector routes never authenticate with browser cookies. Native requests
    // use signed challenges or scoped grants; browser requests still validate Origin.
    const connectorRoute = method === 'POST' && (
      /^\/api\/skill-import\/connector\/(?:pairings|challenges|grants)$/.test(path)
      || /^\/api\/skill-import\/connector\/sessions\/[a-z0-9_-]{1,160}\/(?:events|package)$/.test(path)
      || /^\/api\/skill-import\/connector\/sessions\/[a-z0-9_-]{1,160}\/operations\/[a-z0-9_-]{1,160}\/upload-grant$/.test(path)
      || /^\/api\/skill-import\/connector\/devices\/[a-z0-9_-]{1,160}\/revoke$/.test(path)
    ) || method === 'DELETE' && /^\/api\/skill-import\/connector\/sessions\/[a-z0-9_-]{1,160}$/.test(path);
    if (connectorRoute && !request.headers.origin && !request.headers.referer) return true;

    // 验证来源
    const origin = request.headers.origin || request.headers.referer;

    if (!origin) {
      // 生产环境严格要求 Origin/Referer
      if (this.isProduction) {
        throw new ForbiddenException('Missing Origin or Referer header');
      }
      return true; // 开发环境放行
    }

    // URL.origin 规范化主机名大小写、默认端口，并去掉 Referer 路径。
    let originHost: string;
    try {
      originHost = new URL(origin).origin;
    } catch {
      throw new ForbiddenException('Invalid Origin or Referer header');
    }

    if (!this.allowedOrigins.has(originHost)) {
      throw new ForbiddenException(
        `Origin ${originHost} not allowed. CSRF protection.`
      );
    }

    return true;
  }
}
