import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkillVersion } from '@prisma/client';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import matter from 'gray-matter';
import { ClientSkillArtifactAvailableSchema, SkillArtifactFrontmatterSchema } from 'shared';
import { ClientSkillArtifactService } from './client-skill-artifact.service';
import { SkillPackageService } from '../skill-package/skill-package.service';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const params = { subscriptionId: 'sub-1', capabilityId: 'cap-1', versionId: 'sv-1' };
const makeVersion = (changes: Partial<SkillVersion> = {}): SkillVersion => ({
  id: 'sv-1', capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
  content: 'Make a product image.\n', version: '1.0.0', packageKey: null, packageSha256: null,
  ...changes,
} as SkillVersion);

describe('ClientSkillArtifactService', () => {
  const prisma = { subscription: { findFirst: jest.fn() } };
  const ctx = { enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-1', role: 'MEMBER' };
  const enterprise = { resolve: jest.fn() };
  const versions = { resolveEffectiveVersion: jest.fn() };
  const packages = { readInstallablePackage: jest.fn() };
  let service: ClientSkillArtifactService;

  beforeEach(() => {
    jest.resetAllMocks();
    enterprise.resolve.mockResolvedValue(ctx);
    prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-1', employee: { bindings: [{ capabilityId: 'cap-1' }] } });
    versions.resolveEffectiveVersion.mockResolvedValue(makeVersion());
    service = new ClientSkillArtifactService(prisma as any, enterprise as any, versions as any, packages as any);
  });

  it('builds deterministic legal UTF-8 SKILL.md without changing approved content', async () => {
    const version = makeVersion();
    const descriptor = await service.describe('sub-1', 'cap-1', version);
    const artifact = await service.download('user-1', params);
    expect(artifact.descriptor).toEqual(descriptor);
    expect(ClientSkillArtifactAvailableSchema.safeParse(descriptor).success).toBe(true);
    expect(artifact.descriptor.approvedContentSha256).toBe(digest(version.content));
    expect(artifact.descriptor.artifactSha256).toBe(digest(artifact.buffer));
    expect(artifact.descriptor.entrySha256).toBe(digest(artifact.buffer));
    expect(artifact.descriptor.byteLength).toBe(artifact.buffer.length);
    const parsed = matter(artifact.buffer.toString('utf8'));
    expect(SkillArtifactFrontmatterSchema.safeParse(parsed.data).success).toBe(true);
    expect(parsed.data.name).toBe(artifact.descriptor.installationDirectory);
    expect(parsed.content).toBe(version.content);
    expect(packages.readInstallablePackage).not.toHaveBeenCalled();
  });

  it('preserves an already legal single-file entry byte for byte', async () => {
    const content = '---\nname: product-image\ndescription: "Make a product image"\nmetadata:\n  category: ecommerce\n---\n\nMake an image.\n';
    versions.resolveEffectiveVersion.mockResolvedValue(makeVersion({ content }));
    const artifact = await service.download('user-1', params);
    expect(artifact.buffer.toString()).toBe(content);
    expect(artifact.descriptor.installationDirectory).toBe('product-image');
  });

  it.each(['\ufeff\n', '\n\t\n', '\r'])('retains approved Unicode names and source bytes with compatibility prefix %j', async (prefix) => {
    const content = prefix + '---\nname: 中文-ＡＩ\ndescription: 2026-10-14\nmetadata:\n  version: 1\n  date: 2026-10-14\ndisable-model-invocation: true\n---\n做图';
    versions.resolveEffectiveVersion.mockResolvedValue(makeVersion({ content }));
    const artifact = await service.download('user-1', params);
    expect(artifact.buffer.toString('utf8')).toBe(content);
    expect(artifact.descriptor).toMatchObject({ installationDirectory: '中文-ＡＩ', approvedContentSha256: digest(content), entrySha256: digest(content), artifactSha256: digest(content) });
  });

  it.each([
    ['', 'INVALID_ENTRY'],
    ['broken surrogate \ud800', 'INVALID_ENTRY'],
    ['x'.repeat(2 * 1024 * 1024 + 1), 'INVALID_ENTRY'],
  ])('blocks unsafe or incomplete single-file content (case %#)', async (content, reason) => {
    const version = makeVersion({ content });
    expect(await service.describe('sub-1', 'cap-1', version)).toMatchObject({ status: 'BLOCKED', reason });
    versions.resolveEffectiveVersion.mockResolvedValue(version);
    await expect(service.download('user-1', params)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    '---\nname: Bad_Name\ndescription: test\n---\nbody',
    '---\nname: valid\ndescription: test\ncompatibility: 2\n---\nbody',
  ])('distributes compatible entries despite metadata or reference warnings: %s', async (content) => {
    versions.resolveEffectiveVersion.mockResolvedValue(makeVersion({ content }));
    const artifact = await service.download('user-1', params);
    expect(artifact.descriptor.status).toBe('AVAILABLE');
    expect(SkillArtifactFrontmatterSchema.safeParse(matter(artifact.buffer.toString()).data).success).toBe(true);
  });

  it.each(['Read references/checklist.md', '[Checklist](<../checklist.md>)'])(
    'requires a package for concrete local input references: %s', async (content) => {
      expect(await service.describe('sub-1', 'cap-1', makeVersion({ content })))
        .toMatchObject({ status: 'BLOCKED', reason: 'PACKAGE_REQUIRED' });
    },
  );

  it.each([
    '[Policy](https://example.com/policy) and [Details](#details)',
    '[Policy](<https://example.com/policy>) and [Details](<#details>)',
    '[Policy](<//example.com/policy>)',
    '[Policy][policy]\n\n[policy]: <https://example.com/policy>',
    '[Details][details]\n\n[details]: <#details>',
    '[Policy][policy]\n\n[policy]: <//example.com/policy>',
  ])('does not mistake remote or anchor references for missing local files: %s', async (content) => {
    const descriptor = await service.describe('sub-1', 'cap-1', makeVersion({ content }));
    expect(descriptor.status).toBe('AVAILABLE');
  });

  it('selects only an active, unexpired enterprise subscription with a current member or department grant', async () => {
    await service.download('user-1', params);
    const where = prisma.subscription.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'sub-1', enterpriseId: 'ent-1', status: 'ACTIVE',
      grants: { some: { OR: [{ memberId: 'member-1' }, { departmentId: 'dept-1' }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }] } },
      OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }],
    });
    expect(prisma.subscription.findFirst.mock.calls[0][0].select.employee.select.bindings.where).toEqual({
      enabled: true, capabilityId: 'cap-1', capability: { type: 'SKILL', status: 'APPROVED' },
    });
  });

  it('does not create a null-department grant alternative', async () => {
    enterprise.resolve.mockResolvedValue({ ...ctx, departmentId: null });
    await service.download('user-1', params);
    expect(prisma.subscription.findFirst.mock.calls[0][0].where.grants.some.OR).toEqual([{ memberId: 'member-1' }]);
  });

  it.each([null, { id: 'sub-1', employee: { bindings: [] } }])('rejects revoked, expired, foreign or disabled subscriptions before reading versions/packages', async (subscription) => {
    prisma.subscription.findFirst.mockResolvedValue(subscription);
    await expect(service.download('user-1', params)).rejects.toBeInstanceOf(NotFoundException);
    expect(versions.resolveEffectiveVersion).not.toHaveBeenCalled();
    expect(packages.readInstallablePackage).not.toHaveBeenCalled();
  });

  it.each([
    null,
    makeVersion({ id: 'contribution-version-1' }),
    makeVersion({ capabilityId: 'other-cap' }),
    makeVersion({ scope: 'PERSONAL', status: 'PERSONAL_ACTIVE' }),
    makeVersion({ status: 'DRAFT' }),
    makeVersion({ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', enterpriseId: 'other-ent' }),
  ])('rejects any version other than the currently effective approved version', async (version) => {
    versions.resolveEffectiveVersion.mockResolvedValue(version);
    await expect(service.download('user-1', params)).rejects.toBeInstanceOf(NotFoundException);
    expect(packages.readInstallablePackage).not.toHaveBeenCalled();
  });

  it('allows the current enterprise-approved version of the authenticated enterprise', async () => {
    versions.resolveEffectiveVersion.mockResolvedValue(makeVersion({ scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', enterpriseId: 'ent-1' }));
    await expect(service.download('user-1', params)).resolves.toMatchObject({ descriptor: { status: 'AVAILABLE' } });
  });

  it('rechecks authorization on every download, even after a descriptor was issued', async () => {
    await service.describe('sub-1', 'cap-1', makeVersion());
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expect(service.download('user-1', params)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['platform update', 'enterprise approval withdrawn'])(
    'rejects the previously downloaded version after %s and distributes only the current approved bytes', async (transition) => {
      const previous = makeVersion(transition === 'enterprise approval withdrawn'
        ? { scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', enterpriseId: ctx.enterpriseId }
        : {});
      versions.resolveEffectiveVersion.mockResolvedValue(previous);
      const installed = await service.download('user-1', params);
      const originalBytes = Buffer.from(installed.buffer);
      const originalDescriptor = structuredClone(installed.descriptor);
      const next = makeVersion({ id: 'sv-2', version: '2.0.0', content: 'Updated approved product image instructions.\n' });
      versions.resolveEffectiveVersion.mockResolvedValue(next);
      await expect(service.download('user-1', params)).rejects.toBeInstanceOf(NotFoundException);
      const current = await service.download('user-1', { ...params, versionId: next.id });
      expect(current.descriptor.versionId).toBe(next.id);
      expect(current.descriptor.approvedContentSha256).toBe(digest(next.content));
      expect(current.descriptor.artifactSha256).toBe(digest(current.buffer));
      expect(current.descriptor.artifactSha256).not.toBe(originalDescriptor.artifactSha256);
      expect(installed.buffer).toEqual(originalBytes);
      expect(installed.descriptor).toEqual(originalDescriptor);
      expect(versions.resolveEffectiveVersion).toHaveBeenCalledTimes(3);
      expect(packages.readInstallablePackage).not.toHaveBeenCalled();
    },
  );

  it.each([null, makeVersion({ status: 'DRAFT' })])(
    'does not reuse an issued artifact after approval is revoked (case %#)', async (effective) => {
      const installed = await service.download('user-1', params);
      expect(installed.descriptor.status).toBe('AVAILABLE');
      versions.resolveEffectiveVersion.mockResolvedValue(effective);
      await expect(service.download('user-1', params)).rejects.toBeInstanceOf(NotFoundException);
      expect(versions.resolveEffectiveVersion).toHaveBeenCalledTimes(2);
      expect(packages.readInstallablePackage).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ packageKey: 'skills/bad.zip', packageSha256: 'a'.repeat(64) }, 'PACKAGE_UNAVAILABLE'],
    [{ packageKey: null, packageSha256: 'a'.repeat(64) }, 'PACKAGE_UNAVAILABLE'],
  ])('never accepts an arbitrary storage key', async (fields, reason) => {
    expect(await service.describe('sub-1', 'cap-1', makeVersion(fields))).toMatchObject({ status: 'BLOCKED', reason });
    expect(packages.readInstallablePackage).not.toHaveBeenCalled();
  });

  it.each([
    [new NotFoundException(), 'PACKAGE_UNAVAILABLE'],
    [new BadRequestException(), 'INVALID_ENTRY'],
  ])('turns package validation failures into explicit blocked descriptors', async (error, reason) => {
    const hash = 'a'.repeat(64);
    packages.readInstallablePackage.mockRejectedValue(error);
    expect(await service.describe('sub-1', 'cap-1', makeVersion({ packageKey: `skills/${hash}.zip`, packageSha256: hash })))
      .toMatchObject({ status: 'BLOCKED', reason });
  });

  it.each([
    [{ byteLength: 1024, fileCount: 821 }, { reason: 'INVALID_ENTRY' }],
    [{ byteLength: 20 * 1024 * 1024 + 1, fileCount: 42 }, { reason: 'INVALID_ENTRY' }],
  ])('blocks a valid stored package outside the SEP client limits', async (packageMeta, expected) => {
    const hash = 'a'.repeat(64);
    const entry = Buffer.from('---\nname: product-image\ndescription: Make a product image\n---\nApproved body.\n');
    const version = makeVersion({ packageKey: `skills/${hash}.zip`, packageSha256: hash });
    packages.readInstallablePackage.mockResolvedValue({
      buffer: Buffer.alloc(packageMeta.byteLength), content: version.content, skillName: 'product-image',
      entryPath: 'product-image/SKILL.md', entrySha256: digest(entry), fileCount: packageMeta.fileCount,
    });
    expect(await service.describe('sub-1', 'cap-1', version)).toMatchObject({
      status: 'BLOCKED', capabilityId: 'cap-1', versionId: 'sv-1', ...expected,
    });
    const descriptor = await service.describe('sub-1', 'cap-1', version);
    expect(descriptor).not.toHaveProperty('byteLength');
    expect(descriptor).not.toHaveProperty('fileCount');
  });

  it('allows a package at the inclusive SEP client size and file-count limits', async () => {
    const hash = 'b'.repeat(64);
    const entry = Buffer.from('---\nname: product-image\ndescription: Make a product image\n---\nApproved body.\n');
    const version = makeVersion({ packageKey: `skills/${hash}.zip`, packageSha256: hash });
    packages.readInstallablePackage.mockResolvedValue({
      buffer: Buffer.alloc(20 * 1024 * 1024), content: version.content, skillName: 'product-image',
      entryPath: 'product-image/SKILL.md', entrySha256: digest(entry), fileCount: 500,
    });
    expect(await service.describe('sub-1', 'cap-1', version)).toMatchObject({
      status: 'AVAILABLE', byteLength: 20 * 1024 * 1024, fileCount: 500,
    });
  });

  it('reports temporary storage failure without exposing raw upstream exceptions', async () => {
    const hash = 'a'.repeat(64);
    packages.readInstallablePackage.mockRejectedValue(new Error('storage unavailable'));
    await expect(service.describe('sub-1', 'cap-1', makeVersion({ packageKey: `skills/${hash}.zip`, packageSha256: hash })))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('blocks a real ZIP with conflicting local and central paths without returning bytes', async () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: safe\ndescription: safe\n---\nApproved body.\n'));
    zip.addFile('aa/resource.txt', Buffer.from('payload'));
    const buffer = zip.toBuffer();
    const entry = new AdmZip(buffer).getEntry('aa/resource.txt')!;
    buffer.write('../resource.txt', entry.header.offset + 30, 'utf8');
    const hash = digest(buffer);
    const packageService = new SkillPackageService({ get: () => '/unused' } as unknown as ConfigService);
    jest.spyOn(packageService, 'readBytes').mockResolvedValue(buffer);
    service = new ClientSkillArtifactService(prisma as any, enterprise as any, versions as any, packageService);
    const version = makeVersion({ content: 'Approved body.\n', packageKey: `skills/${hash}.zip`, packageSha256: hash });
    versions.resolveEffectiveVersion.mockResolvedValue(version);
    expect(await service.describe('sub-1', 'cap-1', version)).toMatchObject({ status: 'BLOCKED', reason: 'INVALID_ENTRY' });
    await expect(service.download('user-1', params)).rejects.toMatchObject({
      response: { code: 'SKILL_ARTIFACT_BLOCKED', reason: 'INVALID_ENTRY' }, status: 409,
    });
  });

  it('keeps the full real ZIP and original entry hash, and rejects stale package content', async () => {
    const zip = new AdmZip();
    const entry = Buffer.from('---\nname: product-image\ndescription: Make a product image\n---\nRead references/check.md.\n');
    zip.addFile('product-image/SKILL.md', entry);
    zip.addFile('product-image/references/check.md', Buffer.from('Check product consistency.'));
    const buffer = zip.toBuffer();
    const hash = digest(buffer);
    const packageService = new SkillPackageService({ get: () => '/unused' } as unknown as ConfigService);
    jest.spyOn(packageService, 'readBytes').mockResolvedValue(buffer);
    service = new ClientSkillArtifactService(prisma as any, enterprise as any, versions as any, packageService);
    const version = makeVersion({ content: matter(entry.toString()).content.trimStart(), packageKey: `skills/${hash}.zip`, packageSha256: hash });
    versions.resolveEffectiveVersion.mockResolvedValue(version);
    const artifact = await service.download('user-1', params);
    expect(artifact.buffer.equals(buffer)).toBe(true);
    expect(artifact.descriptor).toMatchObject({ format: 'zip', installationDirectory: 'product-image',
      entryPath: 'product-image/SKILL.md', entrySha256: digest(entry), artifactSha256: hash, fileCount: 2 });
    expect(JSON.stringify(artifact.descriptor)).not.toMatch(/packageKey|\/unused|upstream|apiKey/);
    expect(await service.describe('sub-1', 'cap-1', { ...version, content: 'New approved body' })).toMatchObject({
      status: 'BLOCKED', reason: 'PACKAGE_CONTENT_MISMATCH',
    });
  });
});
