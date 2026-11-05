import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, SkillVersionStatus } from '@prisma/client';
import { AdminSkillVersionQuerySchema, AdoptEnterpriseVersionDtoSchema, SubmitAdminPlatformReviewDtoSchema } from 'shared';
import { SkillVersionService } from './skill-version.service';
import { CapabilityValidatorService } from '../capability-contribution/capability-validator.service';
import { platformMonitorClassifications, validatePlatformSource } from './promote-to-platform';
import { AdminSkillVersionController } from './skill-version.controller';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PersonalWalletService } from '../personal-wallet/personal-wallet.service';

const content = '---\nname: complete-skill\ndescription: Complete workflow\n---\n# Role\nRole description\n# Input\nInput data\n# Output\nOutput data\n# Steps\nExecute the workflow\n';
const time = new Date('2026-10-09T01:00:00.000Z');
const capability = {
  id: 'private-skill', name: 'Skill', description: 'Description', type: 'SKILL',
  enterpriseId: 'enterprise-1', visibility: 'ENTERPRISE_PRIVATE', status: 'PENDING',
  platformReviewStatus: 'NOT_SUBMITTED', contributorId: 'source-author', industry: ['Tech'], position: ['Engineer'],
  inputSchema: {}, outputSchema: {}, metadata: { privateConfig: 'must not copy' },
  skillConfig: { modelId: 'relay-model', temperature: 0.4, maxTokens: 1200 },
  _count: { bindings: 0 },
};
const source = {
  id: 'source-1', capabilityId: capability.id, capability, scope: 'ENTERPRISE', status: 'ENTERPRISE_REJECTED',
  enterpriseId: capability.enterpriseId, enterprise: { id: 'enterprise-1', name: 'Enterprise' },
  content, version: '1.0.1', changeSummary: 'Source changes', createdById: 'source-author', ownerId: null,
  parentVersionId: 'old-enterprise-version', sourceVersionId: null, workingCopyId: null, workingCopyUpdatedAt: null,
  packageKey: null, packageSha256: null, packageFileCount: null, packageFilename: null,
  enterpriseReviewedById: 'enterprise-reviewer', enterpriseReviewedAt: time, rejectionReason: 'Enterprise rejected',
  createdAt: time, updatedAt: time, submittedAt: time, promotedVersions: [], reviewSnapshots: [],
  _count: { enterpriseDefaults: 0, defaultBindings: 0 },
};

const member = { id: 'member', name: 'Member' };
const admin = { id: 'admin', name: 'Admin' };
const reviewer = { id: 'reviewer', name: 'Reviewer' };
const enterprisePublication = { id: 'enterprise-published', version: '1.2.0', isEnterpriseCurrent: true };
const adoption = {
  adoptedAt: time, adoptedBy: reviewer,
  targetVersion: { ...enterprisePublication, scope: 'ENTERPRISE', enterpriseReviewedBy: reviewer,
    _count: { enterpriseDefaults: 1 } },
};
const personalLineage = {
  ...source, id: 'personal', scope: 'PERSONAL', status: 'ENTERPRISE_APPROVED', ownerId: member.id,
  owner: member, createdBy: member, enterpriseReviewedBy: reviewer,
  adoptedSources: [], adoptedInto: [adoption], reviewSnapshots: [], sourceVersion: null, workingCopy: null,
};
const enterpriseLineage = {
  ...source, id: enterprisePublication.id, version: enterprisePublication.version, status: 'ENTERPRISE_APPROVED',
  capability: { ...capability, _count: { bindings: 0 } }, createdBy: admin, enterpriseReviewedBy: reviewer,
  adoptedSources: [{ adoptedBy: reviewer, sourceVersion: personalLineage }], adoptedInto: [],
  sourceVersion: null, workingCopy: null, _count: { enterpriseDefaults: 1, defaultBindings: 0 },
};
const enterpriseSnapshot = {
  id: 'review-snapshot', status: 'ENTERPRISE_APPROVED', createdAt: time, workingCopyUpdatedAt: time,
  enterpriseReviewedAt: time, enterpriseReviewedBy: reviewer, adoptedInto: [adoption],
  reviews: [{ id: 'enterprise-audit' }], promotedVersions: [],
};
const workingCopyLineage = {
  ...personalLineage, status: 'PERSONAL_ACTIVE', submittedAt: null, adoptedInto: [],
  enterpriseReviewedBy: null, reviewSnapshots: [enterpriseSnapshot],
};
const publishedLineage = {
  originalSubmitters: [member], enterprisePublisher: reviewer, enterprisePublishedVersions: [enterprisePublication],
};
const unpublishedLineage = {
  originalSubmitters: [member], enterprisePublisher: null, enterprisePublishedVersions: [],
};

function monitorRow<T extends Record<string, unknown>>(row: T) {
  return { capability: { ...capability, _count: { bindings: 0 } }, ...row };
}

function lineageFields(row: Record<string, unknown>) {
  return { originalSubmitters: row.originalSubmitters, enterprisePublisher: row.enterprisePublisher,
    enterprisePublishedVersions: row.enterprisePublishedVersions };
}

function setup() {
  const prisma = {
    skillVersion: {
      findUnique: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null : source)),
      findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data, id: `created-${data.scope}`, updatedAt: time })),
      update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    capability: {
      findUnique: jest.fn().mockResolvedValue(capability), create: jest.fn().mockResolvedValue({ id: 'platform-skill' }),
      update: jest.fn().mockResolvedValue({ id: 'platform-skill' }),
    },
    skillConfig: { upsert: jest.fn(), findUnique: jest.fn() }, skillVersionReview: { create: jest.fn() },
    employeeCapabilityBinding: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    enterpriseSkillDefault: { updateMany: jest.fn() }, subscriptionSkillVersion: { updateMany: jest.fn() },
    contributionRewardEvent: { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    personalWallet: { upsert: jest.fn().mockResolvedValue({ id: 'wallet-1', balance: new Prisma.Decimal(0), version: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    personalWalletTransaction: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    $queryRaw: jest.fn().mockImplementation((parts: TemplateStringsArray) =>
      String(parts?.join?.(' ') ?? '').includes('FROM users')
        ? Promise.resolve([{ id: 'member', status: 'ACTIVE' }])
        : Promise.resolve([])), $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  const security = { assertReviewable: jest.fn().mockResolvedValue(undefined) };
  const packages = { readBytes: jest.fn(), read: jest.fn(), readInstallablePackage: jest.fn() };
  const validator = new CapabilityValidatorService();
  const settings = { getEffectiveValue: jest.fn().mockResolvedValue('false') };
  const wallet = new PersonalWalletService(prisma as never);
  const service = new SkillVersionService(prisma as never, {} as never, {} as never, {} as never,
    validator, security as never, packages as never, wallet, settings as never);
  return { prisma, service, security, packages, validator, settings };
}

describe('Platform selected-source publishing', () => {
  it('collects a client business template without altering its source and stores structure warnings', async () => {
    const { prisma, service } = setup();
    const businessContent = '# 多平台经营协同\n你是国内电商场景的能力模块。\n## 能力边界\n统一多平台口径。\n## 工作要求\n使用授权数据。\n## 输出格式\n风险及待确认动作\n姚瑞泉测试';
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId
      ? null : { ...source, content: businessContent, scope: 'PERSONAL', status: 'ENTERPRISE_APPROVED' }));

    const result = await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' });
    expect(result).toMatchObject({ content: businessContent, status: 'PENDING_PLATFORM_REVIEW',
      validationResult: { valid: true, issues: [], warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'SECTION_ROLE' }),
      ]) } });
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED', 'ARCHIVED'])(
    'selects enterprise %s without modifying source status or defaults', async (status) => {
      const { prisma, service } = setup();
      prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null : { ...source, status }));
      const result = await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' });
      expect(result).toMatchObject({ capabilityId: 'platform-skill', scope: 'PLATFORM', sourceVersionId: source.id,
        status: 'PENDING_PLATFORM_REVIEW', content, parentVersionId: null, version: '1.0.0', createdById: 'platform-admin' });
      expect(prisma.capability.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
        enterpriseId: null, visibility: 'ENTERPRISE_PRIVATE', status: 'PENDING', contributorId: 'source-author',
        skillConfig: { create: { template: content, modelId: 'relay-model', temperature: 0.4, maxTokens: 1200 } },
      }) }));
      expect(prisma.capability.create.mock.calls[0][0].data.metadata).toBeUndefined();
      expect(prisma.skillVersion.update).not.toHaveBeenCalled();
      expect(prisma.capability.update).not.toHaveBeenCalled();
      expect(prisma.enterpriseSkillDefault.updateMany).not.toHaveBeenCalled();
      expect(prisma.subscriptionSkillVersion.updateMany).not.toHaveBeenCalled();
      expect(prisma.employeeCapabilityBinding.updateMany).not.toHaveBeenCalled();
      expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
      expect(prisma.$queryRaw.mock.calls[0][1]).toBe(capability.id);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.capability.create.mock.invocationCallOrder[0]);
    },
  );

  it.each(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_REJECTED', 'ARCHIVED'])('selects a personal %s submission with immutable ownership', async (status) => {
    const { prisma, service } = setup();
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null
      : { ...source, scope: 'PERSONAL', ownerId: 'personal-owner', status }));
    await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' });
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.create.mock.calls[0][0].data.sourceVersionId).toBe(source.id);
    expect(prisma.skillVersion.create.mock.calls[0][0].data.ownerId).toBeUndefined();
  });

  it('reuses the source capability mapping for subsequent versions and numbers the platform lineage', async () => {
    const { prisma, service } = setup();
    prisma.skillVersion.findFirst.mockResolvedValueOnce({ capabilityId: 'mapped-platform-skill' }).mockResolvedValueOnce({ id: 'platform-head' });
    prisma.skillVersion.findMany.mockResolvedValue([{ version: '2.0.4' }]);
    const result = await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' });
    expect(prisma.capability.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ capabilityId: 'mapped-platform-skill', version: '2.0.5', parentVersionId: 'platform-head' });
    expect(prisma.skillVersion.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({
      sourceVersion: { capabilityId: capability.id }, capabilityId: { not: capability.id }, capability: { enterpriseId: null, type: 'SKILL' },
    }) }));
  });

  it.each(['PENDING_PLATFORM_REVIEW', 'PLATFORM_REJECTED', 'PLATFORM_APPROVED'])('returns an existing %s processing record without duplicating capability or rewards', async (status) => {
    const { prisma, service } = setup();
    const existing = { id: 'existing-copy', capabilityId: 'platform-skill', status };
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? existing : source));
    expect(await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' })).toBe(existing);
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.capability.create).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
  });

  it.each(['PERSONAL_ACTIVE', 'DRAFT'])('freezes a legacy %s personal working copy before selecting it', async (status) => {
    const { prisma, service } = setup();
    const working = { ...source, scope: 'PERSONAL', status, ownerId: 'personal-owner', submittedAt: null };
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null : working));
    const result = await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT', expectedUpdatedAt: time.toISOString() });
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(2);
    expect(prisma.skillVersion.create.mock.calls[0][0].data).toMatchObject({
      workingCopyId: source.id, workingCopyUpdatedAt: time, content, status, ownerId: 'personal-owner',
      enterpriseId: source.enterpriseId, createdById: source.createdById,
    });
    expect(result.sourceVersionId).toBe('created-PERSONAL');
    expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
  });

  it('reuses an existing platform working-copy snapshot for the same revision', async () => {
    const { prisma, service } = setup();
    const existing = { id: 'existing-copy', capabilityId: 'platform-skill' };
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? existing
      : { ...source, scope: 'PERSONAL', status: 'PERSONAL_ACTIVE', submittedAt: null }));
    prisma.skillVersion.findFirst.mockResolvedValueOnce({ id: 'snapshot' });
    expect(await service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' })).toBe(existing);
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
  });

  it('keeps a legacy same-capability promotion and its defaults intact while creating a mapped independent copy', async () => {
    const { prisma, service } = setup();
    const legacy = { id: 'old-platform-copy', capabilityId: source.capabilityId, status: 'PLATFORM_APPROVED' };
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? legacy : source));
    const result = await service.adoptEnterpriseVersion('platform-admin', source.id, { mode: 'DRAFT' });
    expect(result).toMatchObject({ capabilityId: 'platform-skill', sourceVersionId: 'created-ENTERPRISE', status: 'PENDING_PLATFORM_REVIEW' });
    expect(prisma.skillVersion.create.mock.calls[0][0].data).toMatchObject({ workingCopyId: source.id, status: source.status });
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(prisma.enterpriseSkillDefault.updateMany).not.toHaveBeenCalled();
  });

  it('does not clone a public capability, and preserves selected body and platform parent', async () => {
    const { prisma, service } = setup();
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null
      : { ...source, capability: { ...capability, visibility: 'MARKET_PUBLIC' } }));
    prisma.skillVersion.findFirst.mockResolvedValueOnce({ id: 'platform-head' });
    expect(await service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' })).toMatchObject({ capabilityId: source.capabilityId, content, parentVersionId: 'platform-head' });
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('refuses PUBLISH both at the HTTP DTO and direct service boundary', async () => {
    const { prisma, service } = setup();
    expect(AdoptEnterpriseVersionDtoSchema.safeParse({ mode: 'PUBLISH' }).success).toBe(false);
    await expect(service.adoptEnterpriseVersion('admin', source.id, { mode: 'PUBLISH' } as never)).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([['PLATFORM', BadRequestException], ['MISSING', NotFoundException]])('does not select %s as another platform copy', async (scope, error) => {
    const { prisma, service } = setup();
    prisma.skillVersion.findUnique.mockResolvedValue(scope === 'MISSING' ? null : { ...source, scope });
    await expect(service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' })).rejects.toThrow(error);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('refuses a stale selection preview without freezing or publishing', async () => {
    const { prisma, service } = setup();
    await expect(service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT', expectedUpdatedAt: '2026-10-08T00:00:00Z' })).rejects.toThrow(ConflictException);
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
  });

  it('reuses one capability and one copy per source under serialized source-capability transactions', async () => {
    const { prisma, service } = setup();
    const copies: Array<Record<string, any>> = [];
    let queue = Promise.resolve();
    // Model the source Capability lock; real PostgreSQL concurrency is an E2E responsibility.
    prisma.$transaction.mockImplementation((fn) => {
      const result = queue.then(() => fn(prisma));
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId
      ? copies.find((row) => row.sourceVersionId === where.sourceVersionId) ?? null
      : { ...source, id: where.id }));
    prisma.skillVersion.findFirst.mockImplementation(({ where }) => Promise.resolve(where.sourceVersion
      ? copies[0] ?? null : null));
    prisma.skillVersion.findMany.mockImplementation(() => Promise.resolve(copies));
    prisma.skillVersion.create.mockImplementation(({ data }) => {
      const row = { ...data, id: `copy-${copies.length + 1}` };
      copies.push(row);
      return Promise.resolve(row);
    });
    const [first, repeated, next] = await Promise.all([
      service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' }),
      service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' }),
      service.adoptEnterpriseVersion('admin', 'source-2', { mode: 'DRAFT' }),
    ]);
    expect(first.id).toBe(repeated.id);
    expect(next).toMatchObject({ capabilityId: first.capabilityId, version: '1.0.1' });
    expect(prisma.capability.create).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(2);
    expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
  });

  it('fails validation before creating a frozen snapshot or independent capability', async () => {
    const { prisma, service } = setup();
    prisma.skillVersion.findUnique.mockImplementation(({ where }) => Promise.resolve(where.sourceVersionId ? null
      : { ...source, scope: 'PERSONAL', status: 'PERSONAL_ACTIVE', content: '   ' }));
    await expect(service.adoptEnterpriseVersion('admin', source.id, { mode: 'DRAFT' })).rejects.toThrow(BadRequestException);
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });
});

describe('Platform review and first creation', () => {
  function reviewing(status = 'PENDING_PLATFORM_REVIEW', rewardsEnabled: unknown = 'false') {
    const state = setup();
    state.settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? rewardsEnabled : undefined);
    const version = { ...source, id: 'platform-copy', scope: 'PLATFORM', status, capabilityId: 'platform-skill',
      capability: { ...capability, id: 'platform-skill', enterpriseId: null }, sourceVersionId: source.id,
      sourceVersion: { capability } };
    state.prisma.skillVersion.findUnique.mockResolvedValue(version);
    state.prisma.skillVersion.findFirst.mockResolvedValue(version);
    return { ...state, version };
  }

  it('publishes exactly the reviewed version, creates audit, fills adapter config, and advances only PLATFORM bindings', async () => {
    const { prisma, service } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    await service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE', expectedUpdatedAt: time.toISOString() });
    expect(prisma.skillVersion.update).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'platform-copy' }, data: expect.objectContaining({ status: 'PLATFORM_APPROVED' }) }));
    expect(prisma.capability.update).toHaveBeenCalledWith({ where: { id: 'platform-skill' }, data: expect.objectContaining({
      status: 'APPROVED', platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC',
    }) });
    expect(prisma.skillConfig.upsert).toHaveBeenCalledWith({ where: { capabilityId: 'platform-skill' },
      create: { capabilityId: 'platform-skill', template: content }, update: { template: content } });
    expect(prisma.skillVersionReview.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ versionId: 'platform-copy', decision: 'APPROVE', reviewerId: 'admin' }) }));
    expect(prisma.employeeCapabilityBinding.updateMany).toHaveBeenCalledWith({ where: {
      capabilityId: 'platform-skill', defaultSkillVersion: { scope: 'PLATFORM' }, NOT: { defaultSkillVersionId: 'platform-copy' },
    }, data: { defaultSkillVersionId: 'platform-copy' } });
    expect(prisma.enterpriseSkillDefault.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscriptionSkillVersion.updateMany).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({
      dedupeKey: 'platform-approved:private-skill', capabilityId: 'private-skill', enterpriseId: 'enterprise-1',
      recipientId: 'source-author', versionId: 'platform-copy', eventType: 'PLATFORM_APPROVED',
      points: 50, amount: new Prisma.Decimal(50), status: 'AVAILABLE',
    })], skipDuplicates: true });
    expect(prisma.personalWalletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      amount: new Prisma.Decimal(50), relatedType: 'contribution_reward', relatedId: 'platform-approved:private-skill',
    }) });
  });

  it('keeps the old origin dedupe across later selected versions and credits only the first approval', async () => {
    const { prisma, service, version } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    const keys = new Set<string>();
    prisma.contributionRewardEvent.createMany.mockImplementation(({ data }) => {
      const fresh = !keys.has(data[0].dedupeKey);
      keys.add(data[0].dedupeKey);
      return Promise.resolve({ count: fresh ? 1 : 0 });
    });
    await service.reviewPlatformVersion('admin', version.id, { decision: 'APPROVE' });
    version.id = 'platform-next';
    version.sourceVersionId = 'source-2';
    await service.reviewPlatformVersion('admin', version.id, { decision: 'APPROVE' });
    expect([...keys]).toEqual(['platform-approved:private-skill']);
    expect(prisma.personalWalletTransaction.create).toHaveBeenCalledTimes(1);
  });

  it('does not credit an origin already rewarded by the legacy contribution path', async () => {
    const { prisma, service } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    prisma.contributionRewardEvent.createMany.mockResolvedValue({ count: 0 });
    await service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE' });
    expect(prisma.personalWallet.upsert).not.toHaveBeenCalled();
    expect(prisma.personalWalletTransaction.create).not.toHaveBeenCalled();
  });

  it('reuses the legacy wallet dedupe id even if the existing ledger predates the reward event', async () => {
    const { prisma, service } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    prisma.personalWalletTransaction.findFirst.mockResolvedValue({ id: 'old-credit' } as never);
    await service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE' });
    expect(prisma.personalWalletTransaction.findFirst).toHaveBeenCalledWith({ where: {
      walletId: 'wallet-1', relatedType: 'contribution_reward', relatedId: 'platform-approved:private-skill',
    }, select: { id: true } });
    expect(prisma.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('honors the existing reward setting and fails the approval transaction on wallet conflicts', async () => {
    const { prisma, service, settings } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : '75');
    prisma.personalWallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE' })).rejects.toThrow(ConflictException);
    expect(settings.getEffectiveValue).toHaveBeenCalledWith('CONTRIBUTION_PLATFORM_REWARD_CNY');
    expect(prisma.contributionRewardEvent.createMany.mock.calls[0][0].data[0].amount).toEqual(new Prisma.Decimal(75));
    expect(prisma.personalWalletTransaction.create).not.toHaveBeenCalled();
  });

  it('retains an independent platform capability origin mapping when approving a platform-created successor', async () => {
    const { prisma, service, version } = reviewing('PENDING_PLATFORM_REVIEW', 'true');
    version.sourceVersion = null as never;
    prisma.skillVersion.findFirst.mockResolvedValueOnce(version).mockResolvedValueOnce({ sourceVersion: { capability } } as never);
    await service.reviewPlatformVersion('admin', version.id, { decision: 'APPROVE' });
    expect(prisma.contributionRewardEvent.createMany.mock.calls[0][0].data[0].dedupeKey).toBe('platform-approved:private-skill');
  });

  it.each([undefined, null, 'false', '', 'TRUE', '1', true])('publishes the reviewed version without events or wallet writes when rewards are %p', async (value) => {
    const { prisma, service, settings } = reviewing('PENDING_PLATFORM_REVIEW', value);
    settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? value : '75');
    await expect(service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE', expectedUpdatedAt: time.toISOString() }))
      .resolves.toEqual(expect.objectContaining({ status: 'PLATFORM_APPROVED' }));
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'APPROVED', platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC' }),
    }));
    expect(prisma.skillVersionReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ versionId: 'platform-copy', decision: 'APPROVE', reviewerId: 'admin' }),
    }));
    expect(prisma.skillConfig.upsert).toHaveBeenCalled();
    expect(prisma.employeeCapabilityBinding.updateMany).toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
    expect(prisma.personalWallet.upsert).not.toHaveBeenCalled();
    expect(prisma.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.personalWalletTransaction.create).not.toHaveBeenCalled();
    expect(settings.getEffectiveValue).not.toHaveBeenCalledWith('CONTRIBUTION_PLATFORM_REWARD_CNY');
  });

  it('rejects only the platform copy without touching the source or a previously public capability', async () => {
    const { prisma, service, version } = reviewing();
    version.capability.visibility = 'MARKET_PUBLIC';
    await service.reviewPlatformVersion('admin', version.id, { decision: 'REJECT', comment: 'Needs changes' });
    expect(prisma.skillVersion.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: version.id }, data: expect.objectContaining({ status: 'PLATFORM_REJECTED' }) }));
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.employeeCapabilityBinding.updateMany).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
  });

  it.each(['PLATFORM_APPROVED', 'PLATFORM_REJECTED', 'DRAFT'])('refuses repeat/non-pending review of %s without audit or rewards', async (status) => {
    const { prisma, service } = reviewing(status);
    await expect(service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'APPROVE' })).rejects.toThrow(ConflictException);
    expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.create).not.toHaveBeenCalled();
    expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
  });

  it('requires a reason at direct rejection boundary', async () => {
    const { service, prisma } = reviewing();
    await expect(service.reviewPlatformVersion('admin', 'platform-copy', { decision: 'REJECT', comment: ' ' })).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('blocks a private legacy platform copy from making the source enterprise capability public', async () => {
    const { service, prisma, version } = reviewing();
    version.capability.enterpriseId = 'enterprise-1';
    await expect(service.reviewPlatformVersion('admin', version.id, { decision: 'APPROVE' })).rejects.toThrow(ConflictException);
    expect(prisma.capability.update).not.toHaveBeenCalled();
  });

  it('does not approve invalid selected Markdown or let an unrelated historic draft affect validation', async () => {
    const { service, prisma, version } = reviewing();
    version.content = '   ';
    await expect(service.reviewPlatformVersion('admin', version.id, { decision: 'APPROVE' })).rejects.toThrow(BadRequestException);
    expect(prisma.skillVersion.findMany).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
  });

  it('creates only the first platform body and starts mandatory review immediately', async () => {
    const { prisma, service } = setup();
    prisma.capability.findUnique.mockResolvedValue({ ...capability, enterpriseId: null });
    expect(await service.createPlatformVersion('admin', 'new-skill', { content })).toMatchObject({ status: 'PENDING_PLATFORM_REVIEW', version: '1.0.0' });
    prisma.skillVersion.count.mockResolvedValue(1);
    await expect(service.createPlatformVersion('admin', 'new-skill', { content })).rejects.toThrow(ConflictException);
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(1);
  });

  it('rechecks the reviewed legacy template hash under the capability lock before creating a version', async () => {
    const { prisma, service } = setup();
    prisma.capability.findUnique.mockResolvedValue({ ...capability, enterpriseId: null });
    prisma.skillConfig.findUnique.mockResolvedValue({ template: content });
    const expectedTemplateSha256 = createHash('sha256').update(content).digest('hex');
    await service.createPlatformVersion('admin', 'new-skill', { content }, { expectedTemplateSha256 });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.skillConfig.findUnique.mock.invocationCallOrder[0]);
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(1);
    prisma.skillConfig.findUnique.mockResolvedValue({ template: `${content}\nchanged` });
    await expect(service.createPlatformVersion('admin', 'new-skill', { content }, { expectedTemplateSha256 }))
      .rejects.toThrow('历史模板已变化');
    expect(prisma.skillVersion.create).toHaveBeenCalledTimes(1);
  });

  it('re-submits the same rejected record after revalidating, without duplicating review history', async () => {
    const { prisma, service } = reviewing('PLATFORM_REJECTED');
    const result = await service.submitAdminPlatformReview('platform-copy');
    expect(result).toMatchObject({ id: 'platform-copy', status: 'PENDING_PLATFORM_REVIEW', rejectionReason: null });
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
  });

  it('rejects stale resubmission without validating or writing the version', async () => {
    const { prisma, service, validator } = reviewing('PLATFORM_REJECTED');
    const validate = jest.spyOn(validator, 'validateSkill');
    await expect(service.submitAdminPlatformReview('platform-copy', { expectedUpdatedAt: '2026-10-08T01:00:00Z' }))
      .rejects.toThrow(ConflictException);
    expect(validate).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
  });

  it('validates resubmission previews and forwards the unchanged admin contract', async () => {
    expect(() => new ZodValidationPipe(SubmitAdminPlatformReviewDtoSchema).transform({ expectedUpdatedAt: 'yesterday' }))
      .toThrow(BadRequestException);
    const { service } = setup();
    const submit = jest.spyOn(service, 'submitAdminPlatformReview').mockResolvedValue({} as never);
    const controller = new AdminSkillVersionController(service);
    const dto = SubmitAdminPlatformReviewDtoSchema.parse({ expectedUpdatedAt: time.toISOString() });
    await controller.submitReview('platform-copy', dto);
    expect(submit).toHaveBeenCalledWith('platform-copy', dto);
  });
});

describe('Selected skill package security', () => {
  const bytes = Buffer.from('exact stored package bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const packaged = { ...source, packageKey: `skills/${sha256}.zip`, packageSha256: sha256,
    packageFilename: 'skill.zip', packageFileCount: 2 };

  it('allows the client business template and appended note with structure warnings', async () => {
    const { validator, security } = setup();
    const content = '# 多平台经营协同\n你是国内电商场景的能力模块。\n## 能力边界\n统一多平台口径。\n## 工作要求\n使用授权数据。\n## 输出格式\n风险及待确认动作\n姚瑞泉测试';
    const result = await validatePlatformSource({ ...source, content }, validator, security as never);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'SECTION_ROLE', 'SECTION_INPUT', 'SECTION_STEPS',
    ]));
  });

  it('keeps credential findings as non-blocking warnings without echoing the source', async () => {
    const { validator, security } = setup();
    const result = await validatePlatformSource({ ...source, content: 'api_key = live-secret-value-123456789' }, validator, security as never);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('SECRET_API_KEY');
  });

  it('checks the scan, stored bytes, content identity and actual package installability', async () => {
    const { validator, security, packages } = setup();
    const body = content.split('---\n')[2];
    const selected = { ...packaged, content: body };
    packages.readBytes.mockResolvedValue(bytes);
    packages.read.mockResolvedValue({ key: packaged.packageKey, fileCount: 2, content: body });
    packages.readInstallablePackage.mockResolvedValue({ fileCount: 2, content: body });
    await expect(validatePlatformSource(selected, validator, security as never, packages as never)).resolves.toMatchObject({ valid: true });
    expect(security.assertReviewable).toHaveBeenCalledWith(sha256, 'SKILL');
    expect(packages.readBytes).toHaveBeenCalledWith(packaged.packageKey);
    expect(packages.readInstallablePackage).toHaveBeenCalledWith(sha256);
  });

  it('accepts a package whose normalized installable artifact is available', async () => {
    const { validator, security, packages } = setup();
    packages.readBytes.mockResolvedValue(bytes);
    packages.read.mockResolvedValue({ key: packaged.packageKey, fileCount: 2, content: content.split('---\n')[2] });
    packages.readInstallablePackage.mockResolvedValue({ fileCount: 2, content: content.split('---\n')[2], buffer: bytes, sha256 });
    await expect(validatePlatformSource({ ...packaged, content: content.split('---\n')[2] }, validator, security as never, packages as never)).resolves.toMatchObject({ valid: true });
  });

  it('approves missing resources and persists their paths as review warnings', async () => {
    const { prisma, service, packages } = setup();
    const body = content.split('---\n')[2];
    const warning = { code: 'RESOURCE_REFERENCE', path: 'references/missing.md',
      message: '资源引用未匹配到包内文件：references/missing.md。不影响审核通过。' };
    const selected = { ...packaged, content: body, scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW',
      capability: { ...capability, enterpriseId: null } };
    prisma.skillVersion.findFirst.mockResolvedValue(selected);
    packages.readBytes.mockResolvedValue(bytes);
    packages.read.mockResolvedValue({ key: selected.packageKey, fileCount: 2, content: body, warnings: [warning] });
    packages.readInstallablePackage.mockResolvedValue({ fileCount: 2, content: body, warnings: [warning] });
    await service.reviewPlatformVersion('admin', selected.id, { decision: 'APPROVE' });
    expect(prisma.skillVersion.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'PLATFORM_APPROVED', validationResult: expect.objectContaining({
        valid: true, warnings: expect.arrayContaining([warning]),
      }),
    }) }));
  });

  it('returns current package warnings before review for existing uploads', async () => {
    const { prisma, service, packages } = setup();
    const warning = { code: 'RESOURCE_REFERENCE', path: 'references/missing.md', message: '未匹配：references/missing.md' };
    prisma.skillVersion.findUnique.mockResolvedValue(packaged);
    packages.read.mockResolvedValue({ warnings: [warning] });
    await expect(service.getAdminVersion(packaged.id)).resolves.toMatchObject({ packageWarnings: [warning] });
    expect(packages.read).toHaveBeenCalledWith(sha256);
  });

  it('accepts short Chinese instructions, BOM and output examples and warns about local dependencies', async () => {
    const { validator, security } = setup();
    for (const content of ['汇总订单', '\ufeff\n---\nname: 订单汇总\ndescription: 中文\n---\n汇总订单',
      '输出 `result.md`；保存到 assets/output.png；访问 https://example.com/assets/logo.png']) {
      await expect(validatePlatformSource({ ...source, content }, validator, security as never)).resolves.toMatchObject({ valid: true });
    }
    await expect(validatePlatformSource({ ...source, content: '读取 references/policy.md 后汇总订单' }, validator, security as never))
      .resolves.toMatchObject({ valid: true, warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'RESOURCE_REFERENCE', path: 'references/policy.md' }),
      ]) });
    await expect(validatePlatformSource({ ...source, content: '---\nname: ../unsafe\ndescription: invalid\n---\n汇总订单' }, validator, security as never))
      .resolves.toMatchObject({ valid: true });
  });

  it.each(['scan', 'hash', 'body', 'key', 'count', 'incomplete'])('fails closed for %s mismatch', async (failure) => {
    const { validator, security, packages } = setup();
    packages.readBytes.mockResolvedValue(failure === 'hash' ? Buffer.from('other') : bytes);
    packages.read.mockResolvedValue({ key: failure === 'key' ? 'skills/wrong.zip' : packaged.packageKey,
      fileCount: failure === 'count' ? 3 : 2, content: failure === 'body' ? '# Wrong body' : content.split('---\n')[2] });
    if (failure === 'scan') security.assertReviewable.mockRejectedValue(new BadRequestException('scan failed'));
    await expect(validatePlatformSource({ ...packaged, ...(failure === 'incomplete' ? { packageSha256: null } : {}) },
      validator, security as never, packages as never)).rejects.toThrow(BadRequestException);
  });

  it('validates body-only and reports malformed frontmatter as HTTP 400', async () => {
    const { validator, security, packages } = setup();
    await expect(validatePlatformSource(source, validator, security as never, packages as never)).resolves.toMatchObject({ valid: true });
    expect(security.assertReviewable).not.toHaveBeenCalled();
    await expect(validatePlatformSource({ ...source, content: '---\nx: [invalid\n---\n' }, validator, security as never)).resolves.toMatchObject({ valid: true });
  });
});

describe('Admin monitor lineage', () => {
  const later = new Date(time.getTime() + 60_000);
  const earlier = new Date(time.getTime() - 60_000);
  const cases = [
    { name: 'ordinary member behind an administrator-created enterprise version',
      row: enterpriseLineage, expected: publishedLineage },
    { name: 'administrator personal submission without inventing an enterprise publisher',
      row: { ...personalLineage, createdBy: admin, owner: admin, ownerId: admin.id, enterpriseReviewedBy: null, adoptedInto: [] },
      expected: { ...unpublishedLineage, originalSubmitters: [admin] } },
    { name: 'personal creator even when a historical owner is missing',
      row: { ...personalLineage, owner: null, ownerId: null }, expected: publishedLineage },
    { name: 'personal creator rather than a different owner',
      row: { ...personalLineage, owner: admin, ownerId: admin.id }, expected: publishedLineage },
    { name: 'platform enterprise source rather than platform administrator',
      row: { ...personalLineage, id: 'platform-enterprise', scope: 'PLATFORM', createdBy: admin,
        sourceVersionId: enterpriseLineage.id, sourceVersion: enterpriseLineage }, expected: publishedLineage },
    { name: 'platform personal source',
      row: { ...personalLineage, id: 'platform-personal', scope: 'PLATFORM', createdBy: admin,
        sourceVersionId: personalLineage.id, sourceVersion: personalLineage }, expected: publishedLineage },
    { name: 'platform with no source may use its own creator, but not an enterprise publisher',
      row: { ...personalLineage, id: 'platform-native', scope: 'PLATFORM', createdBy: admin },
      expected: { ...unpublishedLineage, originalSubmitters: [admin] } },
    { name: 'historical platform with a missing source relation does not guess its author',
      row: { ...personalLineage, scope: 'PLATFORM', createdBy: admin, sourceVersionId: 'missing', sourceVersion: null },
      expected: { ...unpublishedLineage, originalSubmitters: [] } },
    { name: 'historical enterprise without adoption or reviewer retains only its own version',
      row: { ...enterpriseLineage, adoptedSources: [], enterpriseReviewedBy: null },
      expected: { originalSubmitters: [], enterprisePublisher: null, enterprisePublishedVersions: [enterprisePublication] } },
    { name: 'multiple adopted authors deduplicated by id including unnamed users',
      row: { ...enterpriseLineage, adoptedSources: [
        ...enterpriseLineage.adoptedSources, ...enterpriseLineage.adoptedSources,
        { adoptedBy: reviewer, sourceVersion: { createdBy: { id: 'member-2', name: null } } },
      ] }, expected: { ...publishedLineage, originalSubmitters: [member, { id: 'member-2', name: null }] } },
    { name: 'multiple enterprise publications deduplicated by id with independent current flags',
      row: { ...personalLineage, adoptedInto: [adoption, adoption, { ...adoption, targetVersion: {
        ...adoption.targetVersion, id: 'older-enterprise', version: '1.1.0', _count: { enterpriseDefaults: 0 },
      } }] }, expected: { ...publishedLineage, enterprisePublishedVersions: [enterprisePublication,
        { id: 'older-enterprise', version: '1.1.0', isEnterpriseCurrent: false }] } },
    { name: 'matching working-copy revision even if snapshot creation predates the edit transaction',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, createdAt: earlier }] },
      expected: publishedLineage },
    { name: 'edited working copy cannot reuse stale reviewer, adoption or snapshot',
      row: { ...workingCopyLineage, updatedAt: later, enterpriseReviewedBy: reviewer, adoptedInto: [adoption] },
      expected: unpublishedLineage },
    { name: 'historical snapshot without revision compatible by creation time',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, workingCopyUpdatedAt: null, createdAt: later }] },
      expected: publishedLineage },
    { name: 'historical snapshot predating the working-copy edit',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, workingCopyUpdatedAt: null, createdAt: earlier }] },
      expected: unpublishedLineage },
    { name: 'explicit snapshot revision mismatch cannot fall back to newer creation time',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, workingCopyUpdatedAt: earlier, createdAt: later }] },
      expected: unpublishedLineage },
    { name: 'rejected working-copy snapshot retains the enterprise reviewer, not a publication',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, status: 'ENTERPRISE_REJECTED', adoptedInto: [] }] },
      expected: { ...unpublishedLineage, enterprisePublisher: reviewer } },
    { name: 'rejected explicit personal version retains the enterprise reviewer',
      row: { ...personalLineage, status: 'ENTERPRISE_REJECTED', adoptedInto: [] },
      expected: { ...unpublishedLineage, enterprisePublisher: reviewer } },
    { name: 'platform promotion snapshot with copied reviewer is not enterprise-review evidence',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, adoptedInto: [], reviews: [],
        promotedVersions: [{ id: 'platform-promotion' }] }] }, expected: unpublishedLineage },
    { name: 'legacy direct adoption without snapshots is usable only before another edit',
      row: { ...workingCopyLineage, reviewSnapshots: [], adoptedInto: [adoption] }, expected: publishedLineage },
    { name: 'legacy adoption predating a working-copy edit',
      row: { ...workingCopyLineage, updatedAt: later, reviewSnapshots: [], adoptedInto: [adoption] },
      expected: unpublishedLineage },
    { name: 'working copy without historical associations clears copied reviewer',
      row: { ...workingCopyLineage, enterpriseReviewedBy: reviewer, reviewSnapshots: [] }, expected: unpublishedLineage },
    { name: 'legacy DRAFT working copy uses the same revision gate',
      row: { ...workingCopyLineage, status: 'DRAFT' }, expected: publishedLineage },
    { name: 'edited legacy DRAFT working copy clears its old review',
      row: { ...workingCopyLineage, status: 'DRAFT', updatedAt: later, enterpriseReviewedBy: reviewer },
      expected: unpublishedLineage },
    { name: 'platform frozen personal source follows the frozen revision rather than later origin edits',
      row: { ...personalLineage, id: 'platform-frozen', scope: 'PLATFORM', createdBy: admin,
        sourceVersionId: 'frozen-personal', sourceVersion: { ...workingCopyLineage, id: 'frozen-personal',
          workingCopyId: workingCopyLineage.id, workingCopyUpdatedAt: time, createdAt: time,
          workingCopy: { ...workingCopyLineage, updatedAt: later } } }, expected: publishedLineage },
    { name: 'frozen personal source cannot inherit a review that happened after the platform freeze',
      row: { ...personalLineage, id: 'platform-before-review', scope: 'PLATFORM', createdBy: admin,
        sourceVersionId: 'frozen-personal', sourceVersion: { ...workingCopyLineage, id: 'frozen-personal',
          workingCopyId: workingCopyLineage.id, workingCopyUpdatedAt: time, createdAt: time,
          workingCopy: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, createdAt: later }] } } },
      expected: unpublishedLineage },
    { name: 'platform frozen DRAFT source follows matching enterprise snapshot',
      row: { ...personalLineage, id: 'platform-frozen-draft', scope: 'PLATFORM', createdBy: admin,
        sourceVersionId: 'frozen-draft', sourceVersion: { ...workingCopyLineage, id: 'frozen-draft', status: 'DRAFT',
          workingCopyId: workingCopyLineage.id, workingCopyUpdatedAt: time, createdAt: time,
          workingCopy: workingCopyLineage } }, expected: publishedLineage },
    { name: 'historical genuine enterprise review without audit/adoption keeps only reviewer',
      row: { ...workingCopyLineage, reviewSnapshots: [{ ...enterpriseSnapshot, adoptedInto: [], reviews: [] }] },
      expected: { ...unpublishedLineage, enterprisePublisher: reviewer } },
    { name: 'enterprise publication actor from adoption is valid when reviewer is missing',
      row: { ...enterpriseLineage, enterpriseReviewedBy: null }, expected: publishedLineage },
  ];

  it.each(cases)('returns identical list/detail lineage for $name', async ({ row, expected }) => {
    const { prisma, service } = setup();
    const resultRow = monitorRow(row);
    prisma.skillVersion.findMany.mockImplementation(({ select, where }) => {
      if (select.adoptedSources) return Promise.resolve(where.id.in.includes(row.id) ? [resultRow] : []);
      return Promise.resolve(select.capability ? [resultRow] : []);
    });
    prisma.skillVersion.findUnique.mockResolvedValue(resultRow);
    prisma.skillVersion.count.mockResolvedValue(1);
    const list = await service.listAdminVersions({ page: 1, limit: 20 });
    const detail = await service.getAdminVersion(row.id);
    expect(lineageFields(list.items[0])).toEqual(expected);
    expect(lineageFields(detail)).toEqual(expected);
    expect(lineageFields(list.items[0])).toEqual(lineageFields(detail));
  });

  it('loads lineage for the entire page in one batch instead of one query per row', async () => {
    const { prisma, service } = setup();
    const rows = [monitorRow(enterpriseLineage), monitorRow(personalLineage),
      monitorRow({ ...personalLineage, id: 'platform', scope: 'PLATFORM', sourceVersionId: enterpriseLineage.id,
        sourceVersion: enterpriseLineage })];
    prisma.skillVersion.findMany.mockImplementation(({ select }) => Promise.resolve(select.adoptedSources || select.capability ? rows : []));
    const result = await service.listAdminVersions({ page: 1, limit: 20 });
    expect(result.items.map(lineageFields)).toEqual([publishedLineage, publishedLineage, publishedLineage]);
    expect(prisma.skillVersion.findMany).toHaveBeenCalledTimes(3);
    const lineageQuery = prisma.skillVersion.findMany.mock.calls[2][0];
    expect(lineageQuery.where).toEqual({ id: { in: [enterpriseLineage.id, personalLineage.id, 'platform'] } });
    expect(lineageQuery.select).toMatchObject({ adoptedSources: expect.anything(), adoptedInto: expect.anything(),
      enterpriseReviewedBy: expect.anything(), sourceVersion: expect.anything(), workingCopy: expect.anything(),
      reviewSnapshots: { where: { status: { in: ['ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] } } } });
  });

  it('batches unresolved platform source chains and follows them to original submitters', async () => {
    const { prisma, service } = setup();
    const middle = { ...personalLineage, id: 'middle-platform', scope: 'PLATFORM', createdBy: admin,
      sourceVersionId: enterpriseLineage.id, sourceVersion: null };
    const root = monitorRow({ ...middle, id: 'root-platform', sourceVersionId: middle.id, sourceVersion: middle });
    prisma.skillVersion.findUnique.mockResolvedValue(root);
    prisma.skillVersion.findMany.mockImplementation(({ where }) => Promise.resolve(
      where.id.in.includes(root.id) ? [root] : [enterpriseLineage]));
    expect(lineageFields(await service.getAdminVersion(root.id))).toEqual(publishedLineage);
    expect(prisma.skillVersion.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.skillVersion.findMany.mock.calls[1][0].where).toEqual({ id: { in: [enterpriseLineage.id] } });
  });

  it('does not loop or invent authors for a cyclic historical platform source chain', async () => {
    const { prisma, service } = setup();
    const root = monitorRow({ ...personalLineage, scope: 'PLATFORM', sourceVersionId: personalLineage.id });
    prisma.skillVersion.findUnique.mockResolvedValue(root);
    prisma.skillVersion.findMany.mockResolvedValue([root]);
    expect(lineageFields(await service.getAdminVersion(personalLineage.id))).toEqual({ ...unpublishedLineage, originalSubmitters: [] });
    expect(prisma.skillVersion.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('Admin monitor contract', () => {
  it.each(Object.values(SkillVersionStatus))('monitors every state including personal %s with stable pagination', async (status) => {
    const { prisma, service } = setup();
    const query = AdminSkillVersionQuerySchema.parse({ scope: 'PERSONAL', status, page: '2', limit: '5' });
    await service.listAdminVersions(query);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      { capability: { type: 'SKILL' } }, { scope: 'PERSONAL' }, { status },
    ] }, skip: 5, take: 5, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }));
  });

  it('defaults to every scope and returns source ownership, independent processing, enablement and market flags', async () => {
    const { prisma, service } = setup();
    const row = { ...source, scope: 'PLATFORM', status: 'PLATFORM_APPROVED', enterprise: null,
      sourceVersionId: source.id, sourceVersion: { ...source, owner: { id: 'owner', name: 'Owner' } },
      _count: { enterpriseDefaults: 1, defaultBindings: 2 }, capability: { ...capability,
        visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED', status: 'APPROVED', _count: { bindings: 3 } } };
    prisma.skillVersion.count.mockResolvedValue(1);
    prisma.skillVersion.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ id: row.id, capabilityId: row.capabilityId }]);
    const result = await service.listAdminVersions({ page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({ enterprise: source.enterprise, owner: { id: 'owner', name: 'Owner' },
      enterpriseReviewStatus: 'REJECTED', platformProcessingStatus: 'APPROVED', generationType: 'PLATFORM_SELECTED',
      isEnterpriseCurrent: true, isPlatformLatest: true, marketBindingCount: 3, defaultBindingCount: 2, isMarketPublic: true });
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where: { AND: [{ capability: { type: 'SKILL' } }] } });
  });

  it('filters source tenant/owner/capability, independent statuses, generation and time before pagination', async () => {
    const { prisma, service } = setup();
    const query = AdminSkillVersionQuerySchema.parse({ enterpriseId: 'e', ownerId: 'o', capabilityId: 'c',
      enterpriseReviewStatus: 'REJECTED', platformProcessingStatus: 'PENDING_REVIEW', generationType: 'CLIENT_SUBMISSION',
      createdFrom: time.toISOString(), createdTo: '2026-10-10T01:00:00Z', page: 3 });
    await service.listAdminVersions(query);
    const where = prisma.skillVersion.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(expect.arrayContaining([
      { OR: [{ enterpriseId: 'e' }, { sourceVersion: { enterpriseId: 'e' } }] },
      { OR: [{ ownerId: 'o' }, { sourceVersion: { ownerId: 'o' } }] },
      { createdAt: { gte: time, lte: new Date('2026-10-10T01:00:00Z') } },
      expect.objectContaining({ OR: expect.arrayContaining([{ scope: 'PLATFORM', sourceVersion: { status: { equals: 'ENTERPRISE_REJECTED' } } }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' }]) }),
    ]));
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where });
  });

  it.each(['enterpriseName', 'ownerName', 'search'] as const)('trims and bounds the %s query without requiring IDs', (field) => {
    expect(AdminSkillVersionQuerySchema.parse({ [field]: '  Name  ' })).toEqual({ [field]: 'Name', page: 1, limit: 20 });
    expect(AdminSkillVersionQuerySchema.parse({ [field]: `  ${'a'.repeat(200)}  ` })[field]).toHaveLength(200);
    expect(() => new ZodValidationPipe(AdminSkillVersionQuerySchema).transform({ [field]: 'a'.repeat(201) }))
      .toThrow(BadRequestException);
  });

  it.each([
    { field: 'enterpriseName', matches: [
      { enterprise: { name: { contains: 'Name', mode: 'insensitive' } } },
      { sourceVersion: { enterprise: { name: { contains: 'Name', mode: 'insensitive' } } } },
    ] },
    { field: 'ownerName', matches: [
      { owner: { name: { contains: 'Name', mode: 'insensitive' } } },
      { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } },
      { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } },
      { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } },
      { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } } } },
      { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } } } } },
    ] },
  ])('filters direct and selected-source $field before counting and pagination', async ({ field, matches }) => {
    const { prisma, service } = setup();
    prisma.skillVersion.count.mockResolvedValue(17);
    const result = await service.listAdminVersions(AdminSkillVersionQuerySchema.parse({ [field]: '  Name  ', page: 3, limit: 5 }));
    const where = { AND: [{ capability: { type: 'SKILL' } }, { OR: matches }] };
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 10, take: 5 }));
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where });
    expect(result).toMatchObject({ total: 17, page: 3, limit: 5 });
  });

  it('searches skill, direct/selected-source names and adopted original creators/owners with an exact where', async () => {
    const { prisma, service } = setup();
    await service.listAdminVersions(AdminSkillVersionQuerySchema.parse({ search: '  Name  ' }));
    const where = { AND: [{ capability: { type: 'SKILL' } }, { OR: [
      { capability: { name: { contains: 'Name', mode: 'insensitive' } } },
      { enterprise: { name: { contains: 'Name', mode: 'insensitive' } } },
      { owner: { name: { contains: 'Name', mode: 'insensitive' } } },
      { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } },
      { sourceVersion: { enterprise: { name: { contains: 'Name', mode: 'insensitive' } } } },
      { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } },
      { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } },
      { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } } } },
      { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { createdBy: { name: { contains: 'Name', mode: 'insensitive' } } } } } } },
      { sourceVersion: { adoptedSources: { some: { sourceVersion: { owner: { name: { contains: 'Name', mode: 'insensitive' } } } } } } },
    ] }] };
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 0, take: 20 }));
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where });
  });

  it('combines advanced names and search with independent enterprise/platform review filters', async () => {
    const { prisma, service } = setup();
    await service.listAdminVersions(AdminSkillVersionQuerySchema.parse({ enterpriseName: 'Enterprise', ownerName: 'Owner',
      search: 'Skill', enterpriseReviewStatus: 'REJECTED', platformProcessingStatus: 'APPROVED', page: 2, limit: 5 }));
    const query = prisma.skillVersion.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ skip: 5, take: 5 });
    expect(query.where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({ OR: expect.arrayContaining([{ enterprise: { name: { contains: 'Enterprise', mode: 'insensitive' } } }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ owner: { name: { contains: 'Owner', mode: 'insensitive' } } }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ capability: { name: { contains: 'Skill', mode: 'insensitive' } } }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ scope: 'PLATFORM', sourceVersion: { status: { equals: 'ENTERPRISE_REJECTED' } } }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ scope: 'PLATFORM', status: 'PLATFORM_APPROVED' }]) }),
    ]));
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where: query.where });
  });

  it('ignores whitespace-only name and search filters', async () => {
    const { prisma, service } = setup();
    await service.listAdminVersions(AdminSkillVersionQuerySchema.parse({ enterpriseName: '  ', ownerName: '  ', search: '  ' }));
    expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where: { AND: [{ capability: { type: 'SKILL' } }] } });
  });

  it('validates pagination, category and time bounds and does not silently allow PUBLISH', () => {
    expect(AdminSkillVersionQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    for (const invalid of [{ page: 0 }, { page: 'abc' }, { limit: 101 }, { platformProcessingStatus: 'foo' },
      { createdFrom: 'yesterday' }, { createdFrom: '2026-10-10T00:00:00Z', createdTo: '2026-10-09T00:00:00Z' }]) {
      expect(() => new ZodValidationPipe(AdminSkillVersionQuerySchema).transform(invalid)).toThrow(BadRequestException);
    }
    expect(AdoptEnterpriseVersionDtoSchema.parse({})).toEqual({ mode: 'DRAFT' });
    expect(Reflect.getMetadata(ROLES_KEY, AdminSkillVersionController)).toEqual(['ADMIN']);
  });

  it('classifies working-copy processing through immutable snapshots separately from enterprise review', () => {
    expect(platformMonitorClassifications({ scope: 'PERSONAL', status: 'PERSONAL_ACTIVE',
      reviewSnapshots: [{ promotedVersions: [{ status: 'PLATFORM_APPROVED' }] }] })).toMatchObject({
      enterpriseReviewStatus: 'NOT_SUBMITTED', platformProcessingStatus: 'APPROVED', generationType: 'LEGACY_WORKING_COPY',
    });
  });

  it.each(['NOT_SUBMITTED', 'APPROVED', 'REJECTED'] as const)(
    'uses normalized legacy enterprise %s for both filtering and paginated results', async (enterpriseReviewStatus) => {
      const { prisma, service } = setup();
      const state = { id: source.id, enterpriseReviewStatus,
        enterpriseReviewedAt: enterpriseReviewStatus === 'NOT_SUBMITTED' ? null : time,
        rejectionReason: enterpriseReviewStatus === 'REJECTED' ? 'Rejected revision' : null };
      const row = { ...source, scope: 'PERSONAL', status: 'PERSONAL_ACTIVE', submittedAt: null,
        capability: { ...capability, _count: { bindings: 0 } },
        reviewSnapshots: [{ promotedVersions: [{ status: 'PLATFORM_APPROVED' }] }] };
      prisma.$queryRaw.mockResolvedValue([state]);
      prisma.skillVersion.count.mockResolvedValue(1);
      prisma.skillVersion.findMany.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
      const result = await service.listAdminVersions({ enterpriseReviewStatus, page: 2, limit: 5 });
      expect(result).toMatchObject({ total: 1, page: 2, limit: 5, items: [{
        id: source.id, enterpriseReviewStatus, enterpriseReviewedAt: state.enterpriseReviewedAt,
        rejectionReason: state.rejectionReason, platformProcessingStatus: 'APPROVED',
      }] });
      const query = prisma.skillVersion.findMany.mock.calls[0][0];
      expect(query).toMatchObject({ skip: 5, take: 5 });
      expect(query.where.AND).toEqual(expect.arrayContaining([expect.objectContaining({
        OR: expect.arrayContaining([
          { scope: 'PERSONAL', id: { in: [source.id] } },
          { scope: 'PLATFORM', sourceVersionId: { in: [source.id] } },
        ]),
      })]));
      expect(prisma.skillVersion.count).toHaveBeenCalledWith({ where: query.where });
      expect(prisma.$queryRaw.mock.calls[0][0].values).toContain(enterpriseReviewStatus);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.skillVersion.count.mock.invocationCallOrder[0]);
    },
  );

  it.each(['NOT_SUBMITTED', 'APPROVED', 'REJECTED'] as const)(
    'keeps normalized source enterprise %s independent of published platform detail', async (enterpriseReviewStatus) => {
      const { prisma, service } = setup();
      const state = { id: source.id, enterpriseReviewStatus,
        enterpriseReviewedAt: enterpriseReviewStatus === 'NOT_SUBMITTED' ? null : time,
        rejectionReason: enterpriseReviewStatus === 'REJECTED' ? 'Rejected revision' : null };
      prisma.$queryRaw.mockResolvedValue([state]);
      prisma.skillVersion.findUnique.mockResolvedValue({ ...source, id: 'platform-copy', scope: 'PLATFORM',
        status: 'PLATFORM_APPROVED', rejectionReason: null, sourceVersionId: source.id,
        sourceVersion: { ...source, scope: 'PERSONAL', status: 'PERSONAL_ACTIVE' },
        capability: { ...capability, _count: { bindings: 0 } } });
      expect(await service.getAdminVersion('platform-copy')).toMatchObject({
        id: 'platform-copy', enterpriseReviewStatus, platformProcessingStatus: 'APPROVED', rejectionReason: null,
        sourceVersion: { id: source.id, ...state },
      });
    },
  );

  it('keeps explicit client submissions pending while platforms independently reject them', () => {
    expect(platformMonitorClassifications({ scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW',
      promotedVersions: [{ status: 'PLATFORM_REJECTED' }] })).toMatchObject({
      enterpriseReviewStatus: 'PENDING', platformProcessingStatus: 'REJECTED', generationType: 'CLIENT_SUBMISSION',
    });
  });

  it('returns admin detail including source, snapshots, original enterprise and no invented market product', async () => {
    const { prisma, service } = setup();
    prisma.skillVersion.findUnique.mockResolvedValue({ ...source, scope: 'PLATFORM', sourceVersionId: source.id,
      sourceVersion: source, enterprise: null });
    const detail = await service.getAdminVersion(source.id);
    expect(detail).toMatchObject({ enterprise: source.enterprise, isEnterpriseCurrent: false,
      isMarketPublic: false, marketBindingCount: 0, enterpriseReviewStatus: 'REJECTED' });
    expect(prisma.skillVersion.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      owner: expect.anything(), createdBy: expect.anything(), reviews: expect.anything(), packageSha256: true,
    }) }));
  });

  it('previews the published head of the independently mapped platform skill for a private source', async () => {
    const { prisma, service } = setup();
    const head = { id: 'public-head', capabilityId: 'platform-skill', version: '1.0.3', content: 'Published baseline', updatedAt: time };
    prisma.skillVersion.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.sourceVersion ? { capabilityId: 'platform-skill' } : where.capabilityId === 'platform-skill' ? head : null,
    ));
    expect(await service.getAdminVersion(source.id)).toMatchObject({ currentPlatformVersion: head });
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { capabilityId: 'platform-skill', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      select: { id: true, capabilityId: true, version: true, content: true, updatedAt: true },
      orderBy: [{ platformReviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it('reports no platform baseline for an unmapped private source rather than using its enterprise version', async () => {
    const { prisma, service } = setup();
    expect(await service.getAdminVersion(source.id)).toMatchObject({ currentPlatformVersion: null });
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ content: true }),
    }));
  });
});
