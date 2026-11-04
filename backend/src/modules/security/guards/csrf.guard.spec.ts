import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';

describe('CsrfGuard', () => {
  let guard: CsrfGuard;
  let reflector: Reflector;
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, CORS_ORIGIN: process.env.CORS_ORIGIN };

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    reflector = new Reflector();
    process.env.CORS_ORIGIN = 'https://example.com,https://app.example.com';
    process.env.NODE_ENV = 'production';
    guard = new CsrfGuard(reflector);
  });

  const createMockContext = (method: string, path: string, headers: Record<string, string> = {}): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          path,
          headers,
        }),
      }),
    } as ExecutionContext;
  };

  describe('幂等方法（GET/HEAD/OPTIONS）', () => {
    it('应该放行 GET 请求', () => {
      const context = createMockContext('GET', '/api/users');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('应该放行 HEAD 请求', () => {
      const context = createMockContext('HEAD', '/api/users');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('应该放行 OPTIONS 请求', () => {
      const context = createMockContext('OPTIONS', '/api/users');
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('健康检查端点', () => {
    it('应该放行 /health', () => {
      const context = createMockContext('POST', '/health');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('应该放行 /api/health', () => {
      const context = createMockContext('POST', '/api/health');
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('CSRF 保护（POST/PUT/DELETE）', () => {
    it('来自允许源的 POST 请求应该通过', () => {
      const context = createMockContext('POST', '/api/users', {
        origin: 'https://example.com',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('配置域名含大写字母时应匹配浏览器规范化的小写 Origin', () => {
      process.env.CORS_ORIGIN = 'https://longdaoSEP.cn';
      guard = new CsrfGuard(reflector);
      const context = createMockContext('POST', '/api/auth/login', {
        origin: 'https://longdaosep.cn',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('配置中的默认端口应与浏览器 Origin 匹配', () => {
      process.env.CORS_ORIGIN = 'https://EXAMPLE.com:443/';
      guard = new CsrfGuard(reflector);
      const context = createMockContext('POST', '/api/users', {
        origin: 'https://example.com',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('来自允许源的 Referer 应该通过', () => {
      const context = createMockContext('POST', '/api/users', {
        referer: 'https://app.example.com/dashboard',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('来自未授权源应该抛出 ForbiddenException', () => {
      const context = createMockContext('POST', '/api/users', {
        origin: 'https://evil.com',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('相似但不同的域名不能通过', () => {
      const context = createMockContext('POST', '/api/users', {
        origin: 'https://example.com.evil.com',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('无效 Origin 应拒绝而不是返回服务器错误', () => {
      const context = createMockContext('POST', '/api/users', {
        origin: 'not-a-url',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('带 Bearer 凭证的原生客户端模型请求无需 Origin，由客户端鉴权 Guard 验签', () => {
      const context = createMockContext('POST', '/api/gateway/v1/chat/completions', {
        authorization: 'Bearer employment-token',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('模型接口无 Bearer 凭证时交给认证 Guard 拒绝和统计失败', () => {
      const context = createMockContext('POST', '/api/gateway/v1/chat/completions');
      expect(guard.canActivate(context)).toBe(true);
    });

    it('其他接口带 Bearer 凭证也不能跳过 CSRF 来源校验', () => {
      const context = createMockContext('POST', '/api/auth/logout', {
        authorization: 'Bearer employment-token',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('生产环境客户端认证接口无 Origin/Referer 应该放行', () => {
      for (const path of [
        '/api/client/auth/login',
        '/api/client/auth/refresh',
        '/api/client/auth/token',
        '/api/client/auth/logout',
      ]) {
        const context = createMockContext('POST', path);
        expect(guard.canActivate(context)).toBe(true);
      }
    });

    it('客户端认证放行不应扩大到其他客户端写接口', () => {
      const context = createMockContext('POST', '/api/client/employees');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('生产环境缺少 Origin/Referer 应该抛出异常', () => {
      const context = createMockContext('POST', '/api/users');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  it.each([
    '/api/gateway/v1/chat/completions/',
    '/API/GATEWAY/V1/CHAT/COMPLETIONS/',
    '/api/client/auth/login/', '/api/client/auth/refresh/',
    '/api/client/auth/token/', '/api/client/auth/logout/',
  ])('allows only known POST paths with a trailing slash: %s', (path) => {
    expect(guard.canActivate(createMockContext('POST', path))).toBe(true);
  });

  it.each(['', 'Basic invalid', 'Bearer invalid', 'Bearer '])(
    'routes malformed model credentials to authentication: %s', (authorization) => {
      expect(guard.canActivate(createMockContext('POST', '/api/gateway/v1/chat/completions/', {
        authorization,
      }))).toBe(true);
    },
  );

  it.each([
    ['POST', '/api/gateway/v1/chat/completions-other'],
    ['POST', '/api/gateway/v1/chat/completions//'],
    ['POST', '/api/gateway/v1/models'],
    ['PATCH', '/api/gateway/v1/chat/completions/'],
    ['POST', '/api/client/auth/token-extra/'],
    ['POST', '/api/client/tasks/'],
    ['PUT', '/api/client/auth/login/'],
    ['POST', '/api/auth/logout/'],
  ])('retains source validation for %s %s', (method, path) => {
    expect(() => guard.canActivate(createMockContext(method, path, { authorization: 'Bearer token' })))
      .toThrow(ForbiddenException);
  });

  describe.each([
    ['POST', '/api/client/tasks'],
    ['PATCH', '/api/client/tasks/mirror-1/status'],
    ['POST', '/api/client/tasks/mirror-1/events'],
    ['POST', '/api/client/tasks/mirror-1/heartbeat'],
  ])('生产客户端监控 %s %s', (method, path) => {
    it('允许配置的 Web 来源，同时不为 Bearer 监控请求绕过来源校验', () => {
      const headers = { authorization: 'Bearer test-monitor-token' };
      expect(() => guard.canActivate(createMockContext(method, path, headers)))
        .toThrow('Missing Origin or Referer header');
      expect(guard.canActivate(createMockContext(method, path, {
        ...headers, origin: 'https://app.example.com', referer: 'https://app.example.com/',
      }))).toBe(true);
      expect(() => guard.canActivate(createMockContext(method, path, {
        ...headers, origin: 'https://evil.com', referer: 'https://app.example.com/',
      }))).toThrow(ForbiddenException);
    });
  });

  describe('原生 Skills connector', () => {
    it.each([
      ['POST', '/api/skill-import/connector/pairings'],
      ['POST', '/api/skill-import/connector/challenges/'],
      ['POST', '/api/skill-import/connector/grants'],
      ['POST', '/api/skill-import/connector/sessions/Session_1/events'],
      ['POST', '/api/skill-import/connector/sessions/Session_1/package/'],
      ['POST', '/api/skill-import/connector/sessions/Session_1/operations/Op_1/upload-grant'],
      ['POST', '/api/skill-import/connector/devices/Device_1/revoke'],
      ['DELETE', '/api/skill-import/connector/sessions/Session_1'],
    ])('无 Cookie 来源的 %s %s 交给独立协议鉴权', (method, path) => {
      expect(guard.canActivate(createMockContext(method, path))).toBe(true);
      expect(() => guard.canActivate(createMockContext(method, path, { origin: 'https://evil.com' })))
        .toThrow(ForbiddenException);
      expect(guard.canActivate(createMockContext(method, path, { origin: 'https://example.com' }))).toBe(true);
    });

    it.each([
      ['POST', '/api/skill-import/sessions'],
      ['POST', '/api/skill-import/sessions/session_1/confirm-device'],
      ['DELETE', '/api/skill-import/devices/device_1'],
      ['POST', '/api/skill-import/connector/pairings-extra'],
      ['POST', '/api/skill-import/connector/pairings//'],
      ['POST', '/api/skill-import/connector/sessions/session_1/unknown'],
      ['PATCH', '/api/skill-import/connector/grants'],
      ['DELETE', '/api/skill-import/connector/devices/device_1'],
    ])('未扩大来源豁免到 %s %s', (method, path) => {
      expect(() => guard.canActivate(createMockContext(method, path))).toThrow(ForbiddenException);
    });
  });

  describe('开发环境', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      guard = new CsrfGuard(reflector);
    });

    it('应该放行 localhost 源', () => {
      const context = createMockContext('POST', '/api/users', {
        origin: 'http://localhost:3000',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('缺少 Origin/Referer 应该放行', () => {
      const context = createMockContext('POST', '/api/users');
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
