import { ForbiddenException, INestApplication, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { KnowledgeAccessPolicy } from './knowledge-access-policy';
import { KnowledgeAuthGuard } from './knowledge-auth.guard';
import { KnowledgeRateLimitGuard } from './knowledge-rate-limit.guard';
import { KnowledgeRateLimitService } from './knowledge-rate-limit.service';
import { KnowledgeSearchService } from './knowledge-search.service';
import { KnowledgeTelemetryInterceptor } from './knowledge-telemetry.interceptor';
import { KnowledgeTelemetryService } from './knowledge-telemetry.service';
import { SearchController } from './search.controller';

describe('Knowledge search HTTP authentication, limiting and audit contract', () => {
  const secret = 'knowledge-http-test-only-signing-secret';
  const searchPath = '/api/knowledge-bases/search';
  const sourcePath = '/api/knowledge-bases/kb-a/sources/source-a';
  const viewer = { enterpriseId: 'enterprise-real', memberId: 'member-real', role: 'MEMBER', departmentId: null };
  const actor = { actorId: 'user-real', enterpriseId: viewer.enterpriseId, memberId: viewer.memberId };
  const result = {
    searchId: 'search-a', status: 'NO_MATCH', actualStrategy: 'LEXICAL', degraded: true,
    degradationReason: 'QUERY_EMBEDDING_UNAVAILABLE', durationMs: 2, count: 0, partial: true, results: [],
  };
  const source = {
    sourceId: 'source-a', knowledgeBaseId: 'kb-a', documentId: 'doc-a', documentName: 'private-document.txt',
    versionId: 'version-a', chunkId: 'chunk-a', content: 'private document content',
    location: { pageStart: null, pageEnd: null, sectionPath: [], blockStart: 0, blockEnd: 1 }, isCurrent: true,
  };
  let app: INestApplication;
  let jwt: JwtService;
  let token: string;
  const auth = { validateUser: jest.fn() };
  const policy = { resolve: jest.fn() };
  const limiter = { consume: jest.fn() };
  const search = { searchForMember: jest.fn(), getSource: jest.fn() };
  const telemetry = { resolveActor: jest.fn(), record: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({ secret })],
      controllers: [SearchController],
      providers: [
        JwtStrategy, KnowledgeAuthGuard, KnowledgeRateLimitGuard,
        { provide: ConfigService, useValue: new ConfigService({ ACCESS_JWT_SECRET: secret }) },
        { provide: AuthService, useValue: auth },
        { provide: KnowledgeAccessPolicy, useValue: policy },
        { provide: KnowledgeRateLimitService, useValue: limiter },
        { provide: KnowledgeSearchService, useValue: search },
        { provide: KnowledgeTelemetryService, useValue: telemetry },
        { provide: APP_INTERCEPTOR, useClass: KnowledgeTelemetryInterceptor },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    jwt = module.get(JwtService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    auth.validateUser.mockReset().mockResolvedValue({ id: 'user-real', role: 'USER' });
    policy.resolve.mockReset().mockResolvedValue(viewer);
    limiter.consume.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    search.searchForMember.mockReset().mockResolvedValue(result);
    search.getSource.mockReset().mockResolvedValue(source);
    telemetry.resolveActor.mockReset().mockResolvedValue(actor);
    telemetry.record.mockReset().mockResolvedValue(undefined);
    token = jwt.sign({ sub: 'jwt-subject', sid: 'session-real', type: 'access', userId: 'spoofed-user',
      enterpriseId: 'spoofed-enterprise', memberId: 'spoofed-member' }, { expiresIn: '5m' });
  });

  afterAll(async () => { await app?.close(); });

  function call(kind: 'search' | 'source', bearer: string | null = token) {
    const req = kind === 'search' ? request(app.getHttpServer()).post(searchPath) : request(app.getHttpServer()).get(sourcePath);
    if (bearer !== null) req.set('Authorization', `Bearer ${bearer}`);
    return kind === 'search' ? req.send({ query: 'private question' }) : req;
  }

  it.each(['search', 'source'] as const)('rejects missing token for %s with no-store before membership and quota checks', async kind => {
    const response = await call(kind, null).expect(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auth.validateUser).not.toHaveBeenCalled();
    expect(policy.resolve).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(search.searchForMember).not.toHaveBeenCalled();
    expect(search.getSource).not.toHaveBeenCalled();
  });

  it.each(['search', 'source'] as const)('rejects expired signed JWT for %s with no-store', async kind => {
    const expired = jwt.sign({ sub: 'jwt-subject', type: 'access' }, { expiresIn: -1 });
    const response = await call(kind, expired).expect(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auth.validateUser).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it.each(['wrong-signature', 'refresh', 'malformed'] as const)('rejects %s tokens through the real JWT strategy', async kind => {
    const invalid = kind === 'malformed' ? 'not-a-jwt'
      : jwt.sign({ sub: 'jwt-subject', type: kind === 'refresh' ? 'refresh' : 'access' },
        { secret: kind === 'wrong-signature' ? 'wrong-secret' : secret });
    const response = await call('search', invalid).expect(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auth.validateUser).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it('rejects a JWT whose user no longer exists', async () => {
    auth.validateUser.mockResolvedValueOnce(null);
    const response = await call('search').expect(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auth.validateUser).toHaveBeenCalledWith('jwt-subject', 'session-real');
    expect(policy.resolve).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it.each(['search', 'source'] as const)('returns membership rejection for %s without consuming quota', async kind => {
    policy.resolve.mockRejectedValueOnce(new ForbiddenException({
      code: 'ENTERPRISE_MEMBERSHIP_REQUIRED', message: 'Enterprise membership required',
    }));
    const response = await call(kind).expect(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(policy.resolve).toHaveBeenCalledWith('user-real');
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(search.searchForMember).not.toHaveBeenCalled();
    expect(search.getSource).not.toHaveBeenCalled();
  });

  it.each([['search', 'search'], ['source', 'source']] as const)('returns stable 429 and Retry-After for %s', async (kind, operation) => {
    limiter.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7, exceeded: ['enterprise'] });
    const response = await call(kind).expect(429);
    expect(response.headers['retry-after']).toBe('7');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ statusCode: 429, code: 'KNOWLEDGE_RATE_LIMIT_EXCEEDED' });
    expect(limiter.consume).toHaveBeenCalledWith({ enterpriseId: viewer.enterpriseId, memberId: viewer.memberId }, operation);
    expect(JSON.stringify(response.body)).not.toMatch(/enterprise-real|member-real|spoofed/);
    expect(search.searchForMember).not.toHaveBeenCalled();
    expect(search.getSource).not.toHaveBeenCalled();
  });

  it.each(['search', 'source'] as const)('fails closed with stable 503 for %s when Redis limiting is unavailable', async kind => {
    limiter.consume.mockRejectedValueOnce(new ServiceUnavailableException({
      code: 'KNOWLEDGE_RATE_LIMIT_UNAVAILABLE', message: 'Knowledge rate limiting is temporarily unavailable. Please retry later.',
    }));
    const response = await call(kind).expect(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).toMatchObject({ statusCode: 503, code: 'KNOWLEDGE_RATE_LIMIT_UNAVAILABLE' });
    expect(JSON.stringify(response.body)).not.toMatch(/redis:\/\/|stack|enterprise-real|member-real/);
    expect(search.searchForMember).not.toHaveBeenCalled();
    expect(search.getSource).not.toHaveBeenCalled();
  });

  it('rejects an extra enterpriseId instead of forwarding it to search', async () => {
    const response = await request(app.getHttpServer()).post(searchPath).set('Authorization', `Bearer ${token}`)
      .send({ query: 'private question', enterpriseId: 'spoofed-enterprise' }).expect(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(search.searchForMember).not.toHaveBeenCalled();
    expect(telemetry.record).toHaveBeenCalledWith(actor, expect.objectContaining({
      action: 'KNOWLEDGE_SEARCH', statusCode: 400, resultCode: 'VALIDATION_ERROR',
    }));
  });

  it('passes only the validated DTO and authenticated database user ID to search', async () => {
    const response = await request(app.getHttpServer()).post(searchPath).set('Authorization', `Bearer ${token}`)
      .set('x-user-id', 'spoofed-header-user').set('x-enterprise-id', 'spoofed-header-enterprise')
      .query({ userId: 'spoofed-query-user', enterpriseId: 'spoofed-query-enterprise' })
      .send({ query: 'private question', knowledgeBaseIds: ['kb-a'], topK: 3 }).expect(200);
    expect(response.body).toEqual(result);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auth.validateUser).toHaveBeenCalledWith('jwt-subject', 'session-real');
    expect(policy.resolve).toHaveBeenCalledWith('user-real');
    expect(limiter.consume).toHaveBeenCalledWith({ enterpriseId: viewer.enterpriseId, memberId: viewer.memberId }, 'search');
    expect(search.searchForMember).toHaveBeenCalledTimes(1);
    expect(search.searchForMember).toHaveBeenCalledWith('user-real', { query: 'private question', knowledgeBaseIds: ['kb-a'], topK: 3 });
  });

  it('audits successful search without query, token or result content and replaces untrusted request IDs', async () => {
    const response = await request(app.getHttpServer()).post(searchPath).set('Authorization', `Bearer ${token}`)
      .set('x-request-id', 'spoofed-request-id').send({ query: 'private question' }).expect(200);
    expect(telemetry.resolveActor).toHaveBeenCalledWith('user-real');
    expect(telemetry.record).toHaveBeenCalledTimes(1);
    expect(telemetry.record).toHaveBeenCalledWith(actor, expect.objectContaining({
      action: 'KNOWLEDGE_SEARCH', statusCode: 200, resultCode: 'NO_MATCH', searchId: 'search-a', count: 0,
      actualStrategy: 'LEXICAL', degraded: true, partial: true, durationMs: expect.any(Number),
      requestId: response.headers['x-request-id'],
    }));
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('spoofed-request-id');
    const audit = JSON.stringify(telemetry.record.mock.calls);
    expect(audit).not.toContain('private question');
    expect(audit).not.toContain(token);
    expect(audit).not.toContain('spoofed');
    expect(search.searchForMember).toHaveBeenCalledWith('user-real', { query: 'private question', topK: 5 });
  });

  it('audits search business failure without converting it into success or exposing backend metadata', async () => {
    search.searchForMember.mockRejectedValueOnce(new ServiceUnavailableException({
      code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', message: 'Knowledge search temporarily unavailable',
      internalHost: 'private-search-host', query: 'private question',
    }));
    const response = await call('search').expect(503);
    expect(response.body.code).toBe('KNOWLEDGE_SERVICE_UNAVAILABLE');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(telemetry.record).toHaveBeenCalledWith(actor, expect.objectContaining({
      action: 'KNOWLEDGE_SEARCH', statusCode: 503, resultCode: 'KNOWLEDGE_SERVICE_UNAVAILABLE',
    }));
    expect(JSON.stringify(response.body)).not.toMatch(/private-search-host|private question|internalHost/);
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toMatch(/private-search-host|private question|internalHost/);
  });

  it('returns a non-disclosing source 404 and audits the failed read', async () => {
    search.getSource.mockRejectedValueOnce(new NotFoundException({
      code: 'KNOWLEDGE_RESOURCE_NOT_FOUND', message: 'Knowledge resource unavailable',
      documentName: source.documentName, content: source.content, enterpriseId: 'other-enterprise',
    }));
    const response = await call('source').expect(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ statusCode: 404, code: 'KNOWLEDGE_RESOURCE_NOT_FOUND' });
    expect(search.getSource).toHaveBeenCalledWith('user-real', 'kb-a', 'source-a');
    expect(telemetry.record).toHaveBeenCalledWith(actor, expect.objectContaining({
      action: 'KNOWLEDGE_SOURCE_READ', statusCode: 404, resultCode: 'KNOWLEDGE_RESOURCE_NOT_FOUND',
      knowledgeBaseId: 'kb-a', sourceId: 'source-a', resourceId: 'source-a',
    }));
    for (const output of [response.body, telemetry.record.mock.calls]) {
      expect(JSON.stringify(output)).not.toMatch(/private-document|private document content|other-enterprise/);
    }
  });

  it('audits successful source reads using route IDs without recording source content', async () => {
    const response = await call('source').expect(200);
    expect(response.body).toEqual(source);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(search.getSource).toHaveBeenCalledWith('user-real', 'kb-a', 'source-a');
    expect(telemetry.record).toHaveBeenCalledWith(actor, expect.objectContaining({
      action: 'KNOWLEDGE_SOURCE_READ', statusCode: 200, resultCode: 'SUCCESS',
      knowledgeBaseId: 'kb-a', sourceId: 'source-a', versionId: 'version-a',
    }));
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toMatch(/private-document|private document content/);
  });
});
