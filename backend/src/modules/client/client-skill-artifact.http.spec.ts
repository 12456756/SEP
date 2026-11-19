import { ConflictException, ExecutionContext, INestApplication, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SkillVersion } from '@prisma/client';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientSkillArtifactController } from './client-skill-artifact.controller';
import { ClientSkillArtifactService } from './client-skill-artifact.service';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { SkillPackageService } from '../skill-package/skill-package.service';

describe('approved skill artifact HTTP contract', () => {
  let app: INestApplication;
  const artifacts = { download: jest.fn() };
  const path = '/api/client/subscriptions/sub-1/skills/cap-1/versions/sv-1/artifact';
  const binaryParser = (res: any, callback: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
    res.on('error', callback);
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ClientSkillArtifactController],
      providers: [{ provide: ClientSkillArtifactService, useValue: artifacts }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: (context: ExecutionContext) => {
      const req = context.switchToHttp().getRequest();
      if (req.headers.authorization !== 'Bearer access-test-token') throw new UnauthorizedException();
      req.user = { id: 'user-1' };
      return true;
    } }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  beforeEach(() => jest.resetAllMocks());
  afterAll(async () => app.close());

  it('requires authentication before resolving an artifact', async () => {
    await request(app.getHttpServer()).get(path).expect(401);
    expect(artifacts.download).not.toHaveBeenCalled();
  });

  it.each(['single-file', 'zip'])('sends %s as exact raw bytes without a JSON envelope', async (format) => {
    const buffer = format === 'zip' ? Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]) : Buffer.from('---\nname: test\ndescription: test\n---\nProduct image.\n');
    const hash = createHash('sha256').update(buffer).digest('hex');
    artifacts.download.mockResolvedValue({ descriptor: { format, artifactSha256: hash }, buffer });
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer access-test-token')
      .buffer(true).parse(binaryParser).expect(200);
    expect(response.body.equals(buffer)).toBe(true);
    expect(response.headers['content-length']).toBe(String(buffer.length));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-sha256']).toBe(hash);
    expect(response.headers['content-type']).toMatch(format === 'zip' ? /application\/zip/ : /text\/markdown; charset=utf-8/);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${format === 'zip' ? 'skill.zip' : 'SKILL.md'}"`);
    expect(artifacts.download).toHaveBeenCalledWith('user-1', { subscriptionId: 'sub-1', capabilityId: 'cap-1', versionId: 'sv-1' });
  });

  it('validates all path params before calling the service', async () => {
    await request(app.getHttpServer()).get(path.replace('sv-1', 'sv%20bad'))
      .set('Authorization', 'Bearer access-test-token').expect(400);
    expect(artifacts.download).not.toHaveBeenCalled();
  });

  it('does not send bytes or cache headers when authorization is revoked', async () => {
    artifacts.download.mockRejectedValue(new NotFoundException('Skill artifact unavailable'));
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer access-test-token').expect(404);
    expect(response.headers['x-sha256']).toBeUndefined();
    expect(response.body.message).toBe('Skill artifact unavailable');
  });

  it('preserves 409 diagnostics without internal storage keys through the production exception filter', async () => {
    artifacts.download.mockRejectedValue(new ConflictException({ message: 'Skill artifact is not installable',
      code: 'SKILL_ARTIFACT_BLOCKED', reason: 'PACKAGE_CONTENT_MISMATCH', storageKey: 'private/mock.zip' }));
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer access-test-token').expect(409);
    expect(response.body).toMatchObject({ statusCode: 409, code: 'SKILL_ARTIFACT_BLOCKED', reason: 'PACKAGE_CONTENT_MISMATCH' });
    expect(response.body.storageKey).toBeUndefined();
    expect(response.headers['x-sha256']).toBeUndefined();
  });

  it('rejects a real ambiguous ZIP through validation, artifact service and HTTP without sending bytes', async () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: safe\ndescription: safe\n---\nApproved body.\n'));
    zip.addFile('aa/resource.txt', Buffer.from('payload'));
    const buffer = zip.toBuffer();
    const entry = new AdmZip(buffer).getEntry('aa/resource.txt')!;
    buffer.write('../resource.txt', entry.header.offset + 30, 'utf8');
    const hash = createHash('sha256').update(buffer).digest('hex');
    const packages = new SkillPackageService({ get: () => '/unused' } as unknown as ConfigService);
    jest.spyOn(packages, 'readBytes').mockResolvedValue(buffer);
    const version = { id: 'sv-1', capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
      content: 'Approved body.\n', packageKey: `skills/${hash}.zip`, packageSha256: hash } as SkillVersion;
    const service = new ClientSkillArtifactService(
      { subscription: { findFirst: jest.fn().mockResolvedValue({ id: 'sub-1', employee: { bindings: [{ capabilityId: 'cap-1' }] } }) } } as any,
      { resolve: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', memberId: 'member-1', departmentId: null }) } as any,
      { resolveEffectiveVersion: jest.fn().mockResolvedValue(version) } as any,
      packages,
    );
    artifacts.download.mockImplementation((userId, params) => service.download(userId, params));
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer access-test-token').expect(409);
    expect(response.body).toMatchObject({ statusCode: 409, code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' });
    expect(response.headers['x-sha256']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it.each([
    `${path}/`,
    `${path}/?retry=1`,
    path.toUpperCase(),
    path.replace('sv-1', '%73v-1'),
  ])('preserves the blocked contract for accepted artifact URL variants: %s', async (url) => {
    artifacts.download.mockRejectedValue(new ConflictException({ message: 'Skill artifact is not installable',
      code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' }));
    const response = await request(app.getHttpServer()).get(url).set('Authorization', 'Bearer access-test-token').expect(409);
    expect(response.body).toMatchObject({ code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' });
    expect(artifacts.download).toHaveBeenCalledTimes(1);
  });

  it.each(['PRIVATE_STORAGE_ERROR', 'unknown-reason'])('preserves new business codes and reasons (%s)', async (value) => {
    artifacts.download.mockRejectedValue(new ConflictException({ message: 'Not installable', code: value === 'unknown-reason' ? 'SKILL_ARTIFACT_BLOCKED' : value,
      reason: value === 'unknown-reason' ? value : 'INVALID_ENTRY' }));
    const response = await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer access-test-token').expect(409);
    expect(response.body.code).toBe(value === 'unknown-reason' ? 'SKILL_ARTIFACT_BLOCKED' : value);
    expect(response.body.reason).toBe(value === 'unknown-reason' ? value : 'INVALID_ENTRY');
  });
});
