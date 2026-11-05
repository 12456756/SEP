import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CapabilityCreateDto, CapabilityService } from './capability.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterFactory } from './adapters/adapter.factory';
import { SkillVersionService } from '../skill-version/skill-version.service';

const sha256 = 'a'.repeat(64);
const packageMetadata = {
  zipPath: `skills/${sha256}.zip`, sha256, fileCount: 2, totalSize: 1234,
  filename: 'initial.zip',
};
const body = '# Role\nReview this skill';
const dto: CapabilityCreateDto = {
  name: 'Initial skill', description: 'Initial skill description', type: 'skill',
  industry: [], position: [], inputSchema: {}, outputSchema: {},
  skillConfig: { template: `---\nname: Initial\n---\n${body}`, metadata: packageMetadata },
};
const updatedAt = new Date('2026-10-09T00:00:00.000Z');

function harness(type = 'SKILL') {
  const cap = { id: 'cap-1', type, contributorId: 'owner-1', metadata: { note: 'keep' } };
  const prisma = {
    capability: {
      create: jest.fn().mockResolvedValue(cap),
      findUnique: jest.fn().mockResolvedValue(cap),
      update: jest.fn().mockResolvedValue(cap),
    },
    skillVersion: {
      findMany: jest.fn().mockResolvedValue([{ id: 'pending-1', updatedAt }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    skillVersionReview: { createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback) => callback(prisma));
  const versions = { reviewPlatformVersion: jest.fn().mockResolvedValue({ id: 'pending-1' }) };
  const service = new CapabilityService(
    prisma as unknown as PrismaService, {} as AdapterFactory,
    versions as unknown as SkillVersionService,
  );
  return { service, prisma, versions, cap };
}

describe('CapabilityService write security', () => {
  it.each(['USER', 'CONTRIBUTOR', 'ENTERPRISE_ADMIN', undefined])(
    'forbids initial SKILL creation for role %s at service level', async (role) => {
      const { service, prisma } = harness();
      await expect(service.create('owner-1', dto, role)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.capability.create).not.toHaveBeenCalled();
    },
  );

  it('creates an admin initial pending version with exact package and source metadata', async () => {
    const { service, prisma } = harness();
    await service.create('admin-1', dto, 'ADMIN');
    expect(prisma.capability.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'SKILL', contributorId: 'admin-1',
        metadata: { ...packageMetadata, source: 'ADMIN_CREATED' },
        platformReviewStatus: 'PENDING_REVIEW', platformSubmittedById: 'admin-1',
        platformSubmittedAt: expect.any(Date),
        skillVersions: { create: expect.objectContaining({
          scope: 'PLATFORM', version: '1.0.0', content: body,
          status: 'PENDING_PLATFORM_REVIEW', createdById: 'admin-1',
          packageKey: packageMetadata.zipPath, packageSha256: sha256,
          packageFileCount: 2, packageFilename: 'initial.zip',
        }) },
      }),
    }));
  });

  it('also binds legacy top-level package metadata instead of making a text-only version', async () => {
    const { service, prisma } = harness();
    await service.create('admin-1', {
      ...dto, skillConfig: { template: body }, metadata: packageMetadata,
    }, 'ADMIN');
    expect(prisma.capability.create.mock.calls[0][0].data.skillVersions.create)
      .toMatchObject({ packageKey: packageMetadata.zipPath, packageSha256: sha256 });
  });

  it('preserves an extracted package body that begins with another YAML block', async () => {
    const { prisma, versions } = harness();
    const content = '---\nexample: value\n---\n# Instructions';
    const packages = { read: jest.fn().mockResolvedValue({ key: packageMetadata.zipPath,
      fileCount: 2, totalBytes: 1234, content }) };
    const service = new CapabilityService(prisma as never, {} as never, versions as never,
      undefined, packages as never);
    await service.create('admin-1', { ...dto,
      skillConfig: { template: content, metadata: packageMetadata } }, 'ADMIN');
    expect(prisma.capability.create.mock.calls[0][0].data.skillVersions.create.content).toBe(content);
    await expect(service.create('admin-1', { ...dto,
      skillConfig: { template: '# Different body', metadata: packageMetadata } }, 'ADMIN'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.capability.create).toHaveBeenCalledTimes(1);
  });

  it('keeps text-only admin creation pending and without fabricated package fields', async () => {
    const { service, prisma } = harness();
    await service.create('admin-1', { ...dto, skillConfig: { template: body } }, 'ADMIN');
    const version = prisma.capability.create.mock.calls[0][0].data.skillVersions.create;
    expect(version.status).toBe('PENDING_PLATFORM_REVIEW');
    expect(version).not.toHaveProperty('packageKey');
  });

  it.each([
    { zipPath: packageMetadata.zipPath },
    { ...packageMetadata, sha256: 'invalid' },
    { ...packageMetadata, zipPath: `skills/${'b'.repeat(64)}.zip` },
    { ...packageMetadata, fileCount: 0 },
    { ...packageMetadata, totalSize: -1 },
  ])('rejects incomplete or invalid package metadata %j without writing', async (metadata) => {
    const { service, prisma } = harness();
    await expect(service.create('admin-1', {
      ...dto, skillConfig: { template: body, metadata } as any,
    }, 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('admin-1', {
      ...dto, skillConfig: { template: body }, metadata,
    }, 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('rejects conflicting top-level and nested package metadata', async () => {
    const { service, prisma } = harness();
    await expect(service.create('admin-1', {
      ...dto, metadata: { ...packageMetadata, fileCount: 3 },
    }, 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('requires initial skill content and rejects skillConfig injection into other types', async () => {
    const { service, prisma } = harness();
    await expect(service.create('admin-1', { ...dto, skillConfig: undefined }, 'ADMIN'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('owner-1', { ...dto, type: 'agent' }, 'USER'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('still allows non-SKILL contributor creation without creating a skill version', async () => {
    const { service, prisma } = harness('AGENT');
    await service.create('owner-1', {
      ...dto, type: 'agent', skillConfig: undefined, agentConfig: { platform: 'coze' },
    }, 'USER');
    const data = prisma.capability.create.mock.calls[0][0].data;
    expect(data.type).toBe('AGENT');
    expect(data).not.toHaveProperty('skillVersions');
    expect(data).not.toHaveProperty('platformReviewStatus');
  });

  it.each([
    ['AGENT', 'skill', 'USER'], ['AGENT', 'skill', 'ADMIN'],
    ['SKILL', 'agent', 'USER'], ['SKILL', 'rpa', 'ADMIN'],
  ])('blocks type conversion from %s to %s by %s', async (type, target, role) => {
    const { service, prisma } = harness(type);
    await expect(service.update('cap-1', 'owner-1', role, { type: target as any }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.capability.update).not.toHaveBeenCalled();
  });

  it('allows same-type metadata updates without changing skill content', async () => {
    const { service, prisma } = harness();
    await service.update('cap-1', 'owner-1', 'USER', { type: 'skill', name: 'Renamed' });
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { type: 'SKILL', name: 'Renamed' },
    }));
  });

  it.each(['approve', 'reject'] as const)('delegates %s only to the exact pending version', async (method) => {
    const { service, prisma, versions, cap } = harness();
    const result = method === 'approve'
      ? await service.approve('cap-1', 'admin-1', 'ADMIN')
      : await service.reject('cap-1', 'admin-1', 'ADMIN', 'Unsafe package');
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith({
      where: { capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' },
      select: { id: true, updatedAt: true }, take: 2,
    });
    expect(versions.reviewPlatformVersion).toHaveBeenCalledWith('admin-1', 'pending-1', {
      decision: method === 'approve' ? 'APPROVE' : 'REJECT',
      ...(method === 'reject' && { comment: 'Unsafe package' }),
      expectedUpdatedAt: updatedAt.toISOString(),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
    expect(prisma.skillVersionReview.createMany).not.toHaveBeenCalled();
    expect(result).toBe(cap);
  });

  it('prevents legacy generic approval from publishing an RPA without its reviewed version', async () => {
    const { service, prisma } = harness('RPA');

    await expect(service.approve('cap-1', 'admin-1', 'ADMIN')).rejects.toThrow('投稿审核队列');

    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'] as const)('refuses %s with zero or multiple pending versions', async (method) => {
    for (const pending of [[], [{ id: 'v1', updatedAt }, { id: 'v2', updatedAt }]]) {
      const { service, prisma, versions } = harness();
      prisma.skillVersion.findMany.mockResolvedValue(pending);
      await expect(service[method]('cap-1', 'admin-1', 'ADMIN'))
        .rejects.toBeInstanceOf(ConflictException);
      expect(versions.reviewPlatformVersion).not.toHaveBeenCalled();
      expect(prisma.capability.update).not.toHaveBeenCalled();
      expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
    }
  });

  it('propagates precise-version security failures without publishing through the generic path', async () => {
    const { service, prisma, versions } = harness();
    const failure = new BadRequestException('Package scan blocked');
    versions.reviewPlatformVersion.mockRejectedValue(failure);
    await expect(service.approve('cap-1', 'admin-1', 'ADMIN')).rejects.toBe(failure);
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
  });

  it.each(['nested', 'legacy'])('initial %s package creation reaches the real version security gate', async (source) => {
    let version: any;
    const cap = { id: 'cap-1', type: 'SKILL', contributorId: 'admin-1', enterpriseId: null };
    const prisma = {
      capability: {
        create: jest.fn().mockImplementation(({ data }) => {
          version = { ...data.skillVersions.create, id: 'pending-1', capabilityId: cap.id,
            updatedAt, capability: cap };
          return Promise.resolve(cap);
        }),
        findUnique: jest.fn().mockResolvedValue(cap),
        update: jest.fn(),
      },
      skillVersion: {
        findMany: jest.fn().mockResolvedValue([{ id: 'pending-1', updatedAt }]),
        findUnique: jest.fn().mockResolvedValue({ capabilityId: cap.id }),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(version)),
        update: jest.fn(), updateMany: jest.fn(),
      },
      skillVersionReview: { create: jest.fn(), createMany: jest.fn() },
      $queryRaw: jest.fn(), $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const failure = new BadRequestException('Package scan blocked');
    const security = { assertReviewable: jest.fn().mockRejectedValue(failure) };
    const versions = new SkillVersionService(prisma as never, {} as never, undefined, undefined,
      { validateSkill: jest.fn().mockReturnValue({ valid: true }) } as never,
      security as never, {} as never);
    const service = new CapabilityService(prisma as never, {} as never, versions);
    await service.create('admin-1', source === 'nested' ? dto : {
      ...dto, skillConfig: { template: body }, metadata: packageMetadata,
    }, 'ADMIN');

    await expect(service.approve('cap-1', 'admin-1', 'ADMIN')).rejects.toBe(failure);

    expect(security.assertReviewable).toHaveBeenCalledWith(sha256, 'SKILL');
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
    expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    expect(prisma.skillVersionReview.createMany).not.toHaveBeenCalled();
  });

  it('retains the precise-version rejection reason requirement', async () => {
    const { prisma } = harness();
    const versions = new SkillVersionService(prisma as never, {} as never);
    const service = new CapabilityService(prisma as never, {} as never, versions);
    await expect(service.reject('cap-1', 'admin-1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.capability.update).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'] as const)('retains the legacy non-SKILL %s transaction', async (method) => {
    const { service, prisma, versions } = harness('AGENT');
    await service[method]('cap-1', 'admin-1', 'ADMIN');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: method === 'approve' ? 'APPROVED' : 'REJECTED' }),
    }));
    expect(prisma.skillVersion.updateMany).toHaveBeenCalledTimes(1);
    expect(versions.reviewPlatformVersion).not.toHaveBeenCalled();
  });

  it.each(['approve', 'reject'] as const)('denies non-admin %s before querying versions', async (method) => {
    const { service, prisma, versions } = harness();
    await expect(service[method]('cap-1', 'owner-1', 'USER')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    expect(versions.reviewPlatformVersion).not.toHaveBeenCalled();
  });
});
