import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CapabilityContributionService } from './capability-contribution.service';
import { CapabilityValidatorService } from './capability-validator.service';

describe('CapabilityContributionService', () => {
  const capability = {
    id: 'cap-1',
    name: '销售分析',
    description: '分析销售数据',
    type: 'SKILL',
    enterpriseId: 'enterprise-1',
    contributorId: 'user-1',
    enterpriseReviewStatus: 'NOT_SUBMITTED',
    platformReviewStatus: 'NOT_SUBMITTED',
    visibility: 'ENTERPRISE_PRIVATE',
    status: 'PENDING',
  } as any;

  const enterpriseContext = {
    resolveOrNull: jest.fn(),
    resolve: jest.fn(),
    assertCanApprove: jest.fn(),
    assertEnterpriseAdmin: jest.fn(),
  };
  const prisma = {
    capability: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    skillVersion: { updateMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    skillVersionReview: { create: jest.fn(), createMany: jest.fn(), findMany: jest.fn() },
    employeeCapabilityBinding: { updateMany: jest.fn() },
    agentConfig: { findUnique: jest.fn() },
    rPAConfig: { findUnique: jest.fn() },
    rpaVersion: { updateMany: jest.fn(), findMany: jest.fn() },
    contributionRewardEvent: { createMany: jest.fn(), findMany: jest.fn(), aggregate: jest.fn() },
    personalWallet: { upsert: jest.fn(), updateMany: jest.fn() },
    personalWalletTransaction: { findFirst: jest.fn(), create: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    enterpriseMember: { findMany: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'contributor-1', status: 'ACTIVE' }]),
    $transaction: jest.fn(),
  };
  const validator = new CapabilityValidatorService();
  const skillPackage = { read: jest.fn(), store: jest.fn(), resolveStoredPath: jest.fn() };
  const rpaPackage = { read: jest.fn() };
  const settings = { getEffectiveValue: jest.fn() };
  const notifications = { create: jest.fn(), createBatch: jest.fn() };
  const service = new CapabilityContributionService(
    prisma as never,
    enterpriseContext as never,
    validator,
    skillPackage as never,
    settings as never,
    notifications as never,
    rpaPackage as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ id: 'contributor-1', status: 'ACTIVE' }]);
    enterpriseContext.assertCanApprove.mockImplementation(() => undefined);
    enterpriseContext.assertEnterpriseAdmin.mockImplementation(() => undefined);
    enterpriseContext.resolveOrNull.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'MEMBER' });
    enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'MEMBER' });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
    prisma.capability.create.mockResolvedValue(capability);
    prisma.capability.findFirst.mockResolvedValue(capability);
    prisma.capability.update.mockResolvedValue(capability);
    prisma.skillVersion.updateMany.mockResolvedValue({ count: 1 });
    prisma.contributionRewardEvent.createMany.mockResolvedValue({ count: 1 });
    settings.getEffectiveValue.mockResolvedValue('false');
    prisma.personalWallet.upsert.mockResolvedValue({ id: 'wallet-1', balance: new Prisma.Decimal(0), version: 0 });
    prisma.personalWallet.updateMany.mockResolvedValue({ count: 1 });
    prisma.personalWalletTransaction.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.enterpriseMember.findMany.mockResolvedValue([]);
  });

  it.each([
    { label: 'enterprise member', ctx: { enterpriseId: 'enterprise-1', role: 'MEMBER' } },
    { label: 'enterprise admin', ctx: { enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' } },
    { label: 'individual contributor', ctx: null },
    { label: 'platform admin contribution context', ctx: { enterpriseId: null, role: 'PLATFORM_ADMIN' } },
  ])('rejects SKILL contribution creation for $label before reading packages or writing', async ({ ctx }) => {
    enterpriseContext.resolveOrNull.mockResolvedValue(ctx);
    for (const skillConfig of [{ template: '# 新正文' }, { packageSha256: 'a'.repeat(64) }]) {
      await expect(service.create('user-1', {
        name: '销售分析', description: '分析销售数据', type: 'skill',
        industry: [], position: [], inputSchema: {}, outputSchema: {}, skillConfig,
      })).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(skillPackage.read).not.toHaveBeenCalled();
    expect(prisma.capability.create).not.toHaveBeenCalled();
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
  });

  it('rejects skillConfig hidden inside another capability type when called directly', async () => {
    await expect(service.create('user-1', {
      name: '混合配置', description: '混合配置不能创建正文', type: 'agent',
      industry: [], position: [], inputSchema: {}, outputSchema: {},
      agentConfig: { platform: 'coze', botId: 'bot-1' }, skillConfig: { template: '隐藏正文' },
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.capability.create).not.toHaveBeenCalled();
  });

  it('still creates AGENT contributions in the resolved enterprise', async () => {
    await service.create('user-1', {
      name: '分析 Agent', description: '企业分析能力', type: 'agent',
      industry: [], position: [], inputSchema: {}, outputSchema: {},
      agentConfig: { platform: 'coze', botId: 'bot-1' },
    });
    expect(prisma.capability.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'AGENT', contributorId: 'user-1', enterpriseId: 'enterprise-1',
        agentConfig: { create: expect.objectContaining({ platform: 'COZE', botId: 'bot-1' }) } }),
    }));
  });

  it('still creates RPA contributions from the stored package', async () => {
    rpaPackage.read.mockResolvedValue({ key: 'rpa/aa.zip', sha256: 'a'.repeat(64), fileCount: 2, totalBytes: 100 });
    await service.create('user-1', {
      name: '报表流程', description: '报表流程包创建', type: 'rpa',
      industry: [], position: [], inputSchema: {}, outputSchema: {},
      rpaConfig: { platform: 'yingdao', executionMode: 'download', packageSha256: 'a'.repeat(64),
        packageFilename: 'report.zip', configDoc: '使用前请先配置报表目录和浏览器环境' },
    });
    expect(rpaPackage.read).toHaveBeenCalledWith('a'.repeat(64));
    expect(prisma.capability.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'RPA', enterpriseId: 'enterprise-1',
        rpaVersions: { create: expect.objectContaining({ status: 'DRAFT', packageKey: 'rpa/aa.zip' }) } }),
    }));
  });

  it('lets an enterprise admin inspect another member contribution in the same enterprise', async () => {
    enterpriseContext.resolveOrNull.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
    prisma.capability.findFirst.mockResolvedValue({ ...capability, contributorId: 'member-2' });

    await service.getOne('admin-1', 'cap-1');

    expect(prisma.capability.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'cap-1', OR: [{ contributorId: 'admin-1' }, { enterpriseId: 'enterprise-1' }] },
    }));
  });

  it.each(['MEMBER', 'ENTERPRISE_ADMIN'])('excludes personal version metadata from %s contribution details', async (role) => {
    enterpriseContext.resolveOrNull.mockResolvedValue({ enterpriseId: 'enterprise-1', role });

    await service.getOne('user-1', 'cap-1');

    expect(prisma.capability.findFirst.mock.calls[0][0].select.skillVersions.where)
      .toEqual({ scope: { not: 'PERSONAL' } });
  });

  it.each(['preview', 'edit', 'submit'] as const)('denies the capability author %s access to another member personal submission', async (action) => {
    // The author owns the capability, but not a member's rejected personal submission.
    const privateVersion = {
      id: 'personal-1', scope: 'PERSONAL', status: 'ENTERPRISE_REJECTED',
      enterpriseId: 'other-enterprise', ownerId: 'other-member',
      content: '# 角色\n验收助手\n# 输入\n页面\n# 步骤\n检查\n# 输出\n报告',
      changeSummary: 'Private modification',
    };
    prisma.skillVersion.findFirst.mockImplementation(async ({ where }) =>
      where.scope?.not === privateVersion.scope ? null : privateVersion);

    const request = action === 'preview'
      ? service.getVersionForAuthor('user-1', privateVersion.id)
      : action === 'edit'
        ? service.updateVersion('user-1', privateVersion.id, { content: 'Replacement body' })
        : service.submitVersion('user-1', privateVersion.id);

    await expect(request).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
  });

  it.each(['ENTERPRISE_PRIVATE', 'MARKET_PUBLIC'])('rejects body and package iteration of %s SKILL', async (visibility) => {
    prisma.capability.findFirst.mockResolvedValue({ ...capability, visibility });
    for (const dto of [
      { content: '新正文', changeSummary: '正文修改', parentVersionId: 'personal-1' },
      { packageSha256: 'a'.repeat(64), changeSummary: '包替换' },
    ]) {
      await expect(service.createSkillVersion('user-1', 'cap-1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(skillPackage.read).not.toHaveBeenCalled();
  });

  it('keeps iteration ownership and capability type validation', async () => {
    prisma.capability.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...capability, type: 'RPA' });
    const dto = { content: '新正文', changeSummary: '修改' };
    await expect(service.createSkillVersion('other-user', 'cap-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createSkillVersion('user-1', 'cap-1', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['PLATFORM', 'PLATFORM_APPROVED'],
    ['PLATFORM', 'PENDING_PLATFORM_REVIEW'],
    ['PLATFORM', 'PLATFORM_REJECTED'],
    ['ENTERPRISE', 'ENTERPRISE_APPROVED'],
    ['ENTERPRISE', 'ENTERPRISE_REJECTED'],
    ['ENTERPRISE', 'DRAFT'],
  ])('preserves author preview access to historical %s / %s versions', async (scope, status) => {
    const version = { id: 'version-2', scope, status, content: 'Historical body' };
    prisma.skillVersion.findFirst.mockResolvedValue(version);

    await expect(service.getVersionForAuthor('user-1', version.id)).resolves.toEqual(version);
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: version.id, scope: { not: 'PERSONAL' }, capability: { contributorId: 'user-1' } },
    }));
  });

  it('lists only platform-authorized submissions in the operator queue', async () => {
    prisma.capability.findMany.mockResolvedValue([capability]);
    prisma.capability.count.mockResolvedValue(1);

    const result = await service.listPlatformQueue();

    expect(result).toEqual(expect.objectContaining({ total: 1, status: 'PENDING_REVIEW' }));
    expect(prisma.capability.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { platformReviewStatus: 'PENDING_REVIEW' },
    }));
    expect(prisma.capability.count).toHaveBeenCalledWith({ where: { platformReviewStatus: 'PENDING_REVIEW' } });
  });

  it('applies a trimmed keyword across submission and enterprise fields', async () => {
    prisma.capability.findMany.mockResolvedValue([]);
    prisma.capability.count.mockResolvedValue(0);

    await service.listPlatformQueue('APPROVED', 2, 10, '  示例企业  ');

    const expectedWhere = {
      platformReviewStatus: 'APPROVED',
      OR: [
        { name: { contains: '示例企业', mode: 'insensitive' } },
        { description: { contains: '示例企业', mode: 'insensitive' } },
        { enterprise: { name: { contains: '示例企业', mode: 'insensitive' } } },
      ],
    };
    expect(prisma.capability.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expectedWhere,
      skip: 10,
      take: 10,
    }));
    expect(prisma.capability.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('merges capability and Skill version submissions into one oldest-first queue', async () => {
    const capabilitySubmittedAt = new Date('2026-08-25T10:00:00.000Z');
    const versionSubmittedAt = new Date('2026-08-25T09:00:00.000Z');
    prisma.capability.findMany.mockResolvedValue([{
      id: 'cap-1', name: '销售分析', type: 'SKILL', platformReviewStatus: 'PENDING_REVIEW',
      platformSubmittedAt: capabilitySubmittedAt, enterprise: { id: 'ent-1', name: '示例企业' },
      platformSubmittedBy: { id: 'admin-1', name: '企业管理员', email: 'admin@example.com' },
      contributor: { id: 'user-1', name: '贡献者', email: 'user@example.com' },
    }]);
    prisma.skillVersion.findMany.mockResolvedValue([{
      id: 'version-1', capabilityId: 'cap-1', version: '1.1.0', status: 'PENDING_PLATFORM_REVIEW',
      submittedAt: versionSubmittedAt, capability: { name: '销售分析' }, enterprise: { id: 'ent-1', name: '示例企业' },
      createdBy: { id: 'user-1', name: '贡献者', email: 'user@example.com' },
    }]);

    const result = await service.listUnifiedReviewQueue();

    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.kind)).toEqual(['SKILL_VERSION', 'CAPABILITY']);
    expect(result.items[1].submittedBy.email).toBe('admin@example.com');
    expect(prisma.capability.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { platformReviewStatus: 'PENDING_REVIEW' } }));
    expect(prisma.skillVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'PENDING_PLATFORM_REVIEW' } }));
  });

  it('does not allow a non-admin enterprise member to review', async () => {
    enterpriseContext.assertCanApprove.mockImplementation(() => { throw new ForbiddenException('仅企业管理员可审批'); });
    await expect(service.reviewEnterprise('user-2', 'cap-1', { decision: 'APPROVE' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(enterpriseContext.assertCanApprove).toHaveBeenCalled();
    expect(prisma.capability.findFirst).not.toHaveBeenCalled();
  });

  it('blocks enterprise submission when the Skill body is empty', async () => {
    prisma.capability.findFirst.mockResolvedValue({ ...capability, enterpriseReviewStatus: 'NOT_SUBMITTED' });
    prisma.skillVersion.findFirst.mockResolvedValue({ content: ' \n\t' });

    await expect(service.submitEnterpriseReview('user-1', 'cap-1')).rejects.toThrow('自动校验未通过');
    expect(prisma.capability.update).not.toHaveBeenCalled();
  });

  it('persists validation results before moving a valid Skill into enterprise review', async () => {
    prisma.capability.findFirst.mockResolvedValue({ ...capability, enterpriseReviewStatus: 'NOT_SUBMITTED' });
    prisma.skillVersion.findFirst.mockResolvedValue({ content: '# 角色\n数据分析师\n# 输入\n销售数据\n# 步骤\n分析趋势\n# 输出\n报告' });

    await service.submitEnterpriseReview('user-1', 'cap-1');

    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enterpriseReviewStatus: 'PENDING', validationResult: expect.objectContaining({ valid: true }) }),
    }));
    expect(prisma.skillVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_ENTERPRISE_REVIEW', validationResult: expect.objectContaining({ valid: true }) }),
    }));
  });

  it.each(['ENTERPRISE', 'PLATFORM'])('rejects editing and submitting historical %s Web drafts', async (scope) => {
    for (const status of ['DRAFT', 'ENTERPRISE_REJECTED', 'PLATFORM_REJECTED']) {
      for (const packageKey of [null, 'skills/aa.zip']) {
        prisma.skillVersion.findFirst.mockResolvedValue({
          id: 'version-2', scope, status, packageKey,
          content: '旧正文', changeSummary: '旧说明',
        });
        await expect(service.updateVersion('user-1', 'version-2', { content: '新正文' }))
          .rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.submitVersion('user-1', 'version-2'))
          .rejects.toBeInstanceOf(ForbiddenException);
      }
    }
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(prisma.skillVersionReview.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to touch a version that is already under review', async () => {
    prisma.skillVersion.findFirst.mockResolvedValue({
      id: 'version-2', scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW',
    });

    await expect(service.submitVersion('user-1', 'version-2')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('moves a submitted capability through enterprise review and creates a deduplicated reward event', async () => {
    settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : undefined);
    enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
    prisma.capability.findFirst
      .mockResolvedValueOnce({ ...capability, enterpriseReviewStatus: 'PENDING' })
      .mockResolvedValueOnce({ ...capability, enterpriseReviewStatus: 'PENDING' });

    await service.reviewEnterprise('admin-1', 'cap-1', { decision: 'APPROVE' });

    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ enterpriseReviewStatus: 'APPROVED', enterpriseReviewedById: 'admin-1' }),
    }));
    expect(prisma.contributionRewardEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({ dedupeKey: 'enterprise-approved:cap-1', points: 10, amount: new Prisma.Decimal(10) })],
    }));
    expect(prisma.personalWalletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: new Prisma.Decimal(10), relatedId: 'enterprise-approved:cap-1' }),
    }));
  });

  it.each([null, 'enterprise-1'])('rejects new SKILL platform requests with enterpriseId=%s', async (enterpriseId) => {
    prisma.capability.findFirst.mockResolvedValue({ ...capability, enterpriseId, enterpriseReviewStatus: 'APPROVED' });
    await expect(service.requestPlatformReview('user-1', 'cap-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['REQUESTED', 'REJECTED'])('rejects SKILL authorization of historical %s requests without altering history', async (platformReviewStatus) => {
    enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
    prisma.capability.findFirst.mockResolvedValue({ ...capability, enterpriseReviewStatus: 'APPROVED', platformReviewStatus });
    await expect(service.authorizePlatformSubmission('admin-1', 'cap-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('still enforces ownership and enterprise context for platform submission', async () => {
    prisma.capability.findFirst.mockResolvedValue(null);
    await expect(service.requestPlatformReview('other-user', 'cap-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.authorizePlatformSubmission('other-admin', 'cap-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.capability.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'cap-1', enterpriseId: 'enterprise-1' },
    });
  });

  it.each(['RPA', 'AGENT'])('preserves %s enterprise platform request and authorization', async (type) => {
    prisma.rPAConfig.findUnique.mockResolvedValue({ platform: 'YINGDAO', executionMode: 'DOWNLOAD',
      packageSha256: 'a'.repeat(64), configDoc: '使用前请配置报表目录和浏览器环境' });
    prisma.agentConfig.findUnique.mockResolvedValue({ platform: 'COZE', botId: 'bot-1' });
    prisma.capability.findFirst.mockResolvedValue({ ...capability, type, enterpriseReviewStatus: 'APPROVED' });
    await service.requestPlatformReview('user-1', 'cap-1');
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ platformReviewStatus: 'REQUESTED' }),
    }));
    prisma.capability.findFirst.mockResolvedValue({ ...capability, type, enterpriseReviewStatus: 'APPROVED', platformReviewStatus: 'REQUESTED' });
    await service.authorizePlatformSubmission('admin-1', 'cap-1');
    expect(prisma.capability.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ platformReviewStatus: 'PENDING_REVIEW', platformSubmittedById: 'admin-1' }),
    }));
    if (type === 'RPA') expect(prisma.rpaVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_PLATFORM_REVIEW' }),
    }));
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
  });

  it('preserves individual RPA direct platform submission', async () => {
    prisma.capability.findFirst.mockResolvedValue({ ...capability, type: 'RPA', enterpriseId: null });
    prisma.rPAConfig.findUnique.mockResolvedValue({ platform: 'YINGDAO', executionMode: 'DOWNLOAD',
      packageSha256: 'a'.repeat(64), configDoc: '使用前请配置报表目录和浏览器环境' });
    await service.requestPlatformReview('user-1', 'cap-1');
    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ platformReviewStatus: 'PENDING_REVIEW', platformSubmittedById: 'user-1' }),
    }));
    expect(prisma.rpaVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_PLATFORM_REVIEW' }),
    }));
  });

  it('publishes only after platform admin approval and awards the contributor once', async () => {
    settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : undefined);
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.capability.findUnique.mockResolvedValue({
      ...capability,
      platformReviewStatus: 'PENDING_REVIEW',
    });

    await service.reviewPlatform('platform-admin', 'cap-1', { decision: 'APPROVE' });

    expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ platformReviewStatus: 'APPROVED', visibility: 'MARKET_PUBLIC', status: 'APPROVED' }),
    }));
    expect(prisma.contributionRewardEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({ dedupeKey: 'platform-approved:cap-1', points: 50, amount: new Prisma.Decimal(50) })],
    }));
    expect(prisma.personalWalletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: new Prisma.Decimal(50), relatedId: 'platform-approved:cap-1' }),
    }));
    // scope 约束不能少：漏了它会把 scope=ENTERPRISE 那行也改成 PLATFORM_APPROVED，
    // 结果是「MARKET_PUBLIC 的能力一个平台版本都没有」，别的企业订阅后拿不到正文。
    expect(prisma.skillVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' },
      data: expect.objectContaining({ status: 'PLATFORM_APPROVED' }),
    }));
  });

  it('rejects a second platform review after the first review has completed', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.capability.findUnique.mockResolvedValue({ ...capability, platformReviewStatus: 'APPROVED' });
    await expect(service.reviewPlatform('platform-admin', 'cap-1', { decision: 'APPROVE' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
  });

  describe.each(['enterprise', 'platform'] as const)('%s review reward switch', (kind) => {
    const approve = () => kind === 'enterprise'
      ? service.reviewEnterprise('admin-1', 'cap-1', { decision: 'APPROVE' })
      : service.reviewPlatform('platform-admin', 'cap-1', { decision: 'APPROVE' });

    beforeEach(() => {
      enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
      prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      const pending = { ...capability, enterpriseReviewStatus: 'PENDING', platformReviewStatus: 'PENDING_REVIEW' };
      prisma.capability.findFirst.mockResolvedValue(pending);
      prisma.capability.findUnique.mockResolvedValue(pending);
      prisma.capability.update.mockResolvedValue({ ...pending, [kind === 'enterprise' ? 'enterpriseReviewStatus' : 'platformReviewStatus']: 'APPROVED' });
    });

    it.each([undefined, null, 'false', '', 'TRUE', '1', true])('approves without rewards when the switch is %p', async (value) => {
      settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? value : '75');
      await expect(approve()).resolves.toEqual(expect.objectContaining({
        [kind === 'enterprise' ? 'enterpriseReviewStatus' : 'platformReviewStatus']: 'APPROVED',
      }));
      expect(prisma.capability.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining(kind === 'enterprise'
          ? { enterpriseReviewStatus: 'APPROVED' }
          : { platformReviewStatus: 'APPROVED', status: 'APPROVED', visibility: 'MARKET_PUBLIC' }),
      }));
      expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
      expect(prisma.personalWallet.upsert).not.toHaveBeenCalled();
      expect(prisma.personalWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.personalWalletTransaction.create).not.toHaveBeenCalled();
      expect(settings.getEffectiveValue).not.toHaveBeenCalledWith(kind === 'enterprise'
        ? 'CONTRIBUTION_ENTERPRISE_REWARD_CNY' : 'CONTRIBUTION_PLATFORM_REWARD_CNY');
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
        type: kind === 'enterprise' ? 'CONTRIBUTION_ENTERPRISE_APPROVED' : 'CONTRIBUTION_PLATFORM_APPROVED',
        category: 'APPROVAL',
      }));
      expect(notifications.create.mock.calls[0][0].message).not.toContain('奖励已入账');
      expect(notifications.create).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'CONTRIBUTION_REWARD_CREDITED' }));
      expect(notifications.createBatch).not.toHaveBeenCalled();
    });

    it('uses the configured amount and sends a reward notification only when explicitly enabled', async () => {
      const amountKey = kind === 'enterprise' ? 'CONTRIBUTION_ENTERPRISE_REWARD_CNY' : 'CONTRIBUTION_PLATFORM_REWARD_CNY';
      settings.getEffectiveValue.mockImplementation(async (key) => key === 'CONTRIBUTION_REWARDS_ENABLED' ? 'true' : key === amountKey ? '75' : undefined);
      await approve();
      expect(settings.getEffectiveValue).toHaveBeenCalledWith(amountKey);
      expect(prisma.contributionRewardEvent.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({ amount: new Prisma.Decimal(75) })],
      }));
      expect(prisma.personalWalletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ amount: new Prisma.Decimal(75) }),
      }));
      expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'CONTRIBUTION_REWARD_CREDITED' }));
    });
  });

  describe('CapabilityContributionService version review', () => {
  it('returns parent/current Skill content together with version review history', async () => {
    prisma.skillVersion.findUnique.mockResolvedValue({
      id: 'version-2',
      capabilityId: 'cap-1',
      scope: 'ENTERPRISE',
      enterpriseId: 'enterprise-1',
      parentVersionId: 'version-1',
      sourceVersionId: null,
      version: '1.1.0',
      content: '# 角色\n新版销售分析\n# 输入\n数据\n# 步骤\n分析\n# 输出\n报告',
      changeSummary: '补充边界条件',
      status: 'ENTERPRISE_REJECTED',
      rejectionReason: '缺少异常数据处理',
      submittedAt: new Date('2026-09-27T00:00:00.000Z'),
      createdAt: new Date('2026-09-26T00:00:00.000Z'),
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      createdById: 'user-1',
      capability: { name: '销售分析', contributorId: 'user-1' },
      parentVersion: {
        id: 'version-1',
        version: '1.0.0',
        content: '# 角色\n销售分析\n# 输入\n数据\n# 步骤\n分析\n# 输出\n报告',
      },
      sourceVersion: null,
      reviews: [{
        id: 'review-1',
        actorType: 'ENTERPRISE',
        decision: 'REJECT',
        reviewerId: 'admin-1',
        comment: '缺少异常数据处理',
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
        reviewer: { id: 'admin-1', name: '管理员', email: 'admin@example.com' },
      }],
    });

    await expect(service.getVersionDiff('user-1', 'version-2')).resolves.toEqual(expect.objectContaining({
      version: expect.objectContaining({ status: 'ENTERPRISE_REJECTED', rejectionReason: '缺少异常数据处理' }),
      parent: expect.objectContaining({ id: 'version-1', version: '1.0.0' }),
      current: expect.objectContaining({ id: 'version-2', version: '1.1.0' }),
      changed: true,
      reviews: expect.arrayContaining([expect.objectContaining({ decision: 'REJECT' })]),
    }));
  });

  it('hides a pending version diff from an unrelated enterprise member', async () => {
    prisma.skillVersion.findUnique.mockResolvedValue({
      id: 'version-2',
      capabilityId: 'cap-1',
      scope: 'ENTERPRISE',
      enterpriseId: 'other-enterprise',
      parentVersionId: null,
      sourceVersionId: null,
      version: '1.1.0',
      content: 'pending content',
      changeSummary: 'pending',
      status: 'PENDING_ENTERPRISE_REVIEW',
      rejectionReason: null,
      submittedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdById: 'other-user',
      capability: { name: '销售分析', contributorId: 'other-user' },
      parentVersion: null,
      sourceVersion: null,
      reviews: [],
    });
    enterpriseContext.resolveOrNull.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });

    await expect(service.getVersionDiff('user-1', 'version-2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('records an enterprise review for a rejected version and preserves the rejection comment', async () => {
    enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
    prisma.skillVersion.findFirst.mockResolvedValue({
      id: 'version-2',
      capabilityId: 'cap-1',
      status: 'PENDING_ENTERPRISE_REVIEW',
      createdById: 'user-1',
      version: '1.1.0',
      capability: { name: '销售分析' },
    });
    prisma.skillVersion.update.mockResolvedValue({ id: 'version-2', status: 'ENTERPRISE_REJECTED' });
    prisma.skillVersionReview.create.mockResolvedValue({ id: 'review-2' });

    await service.reviewEnterpriseVersion('admin-1', 'version-2', {
      decision: 'REJECT',
      comment: '请补充异常数据处理',
    });

    expect(prisma.skillVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'version-2' },
      data: expect.objectContaining({ status: 'ENTERPRISE_REJECTED', rejectionReason: '请补充异常数据处理' }),
    }));
    expect(prisma.skillVersionReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionId: 'version-2',
        actorType: 'ENTERPRISE',
        decision: 'REJECT',
        reviewerId: 'admin-1',
        comment: '请补充异常数据处理',
      }),
    });
  });

  it.each(['MARKET_PUBLIC', 'ENTERPRISE_PRIVATE'])('records enterprise approval for %s without platform promotion or notification', async (visibility) => {
    enterpriseContext.resolve.mockResolvedValue({ enterpriseId: 'enterprise-1', role: 'ENTERPRISE_ADMIN' });
    prisma.skillVersion.findFirst.mockResolvedValue({
      id: 'enterprise-v2', capabilityId: 'cap-1', status: 'PENDING_ENTERPRISE_REVIEW',
      createdById: 'user-1', version: '1.1.0', capability: { name: '销售分析', visibility },
    });
    prisma.skillVersion.update.mockResolvedValue({ id: 'enterprise-v2', status: 'ENTERPRISE_APPROVED' });
    const notifications = { create: jest.fn(), createBatch: jest.fn() };
    const reviewService = new CapabilityContributionService(
      prisma as never, enterpriseContext as never, validator, skillPackage as never, undefined, notifications as never,
    );
    await reviewService.reviewEnterpriseVersion('admin-1', 'enterprise-v2', { decision: 'APPROVE' });
    expect(prisma.skillVersion.update).toHaveBeenCalledTimes(1);
    expect(prisma.skillVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'enterprise-v2' }, data: expect.objectContaining({ status: 'ENTERPRISE_APPROVED' }),
    }));
    expect(prisma.skillVersionReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionId: 'enterprise-v2', actorType: 'ENTERPRISE', decision: 'APPROVE' }),
    });
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
    expect(prisma.capability.update).not.toHaveBeenCalled();
    expect(notifications.createBatch).not.toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('records a platform approval without issuing a duplicate capability reward', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.skillVersion.findFirst.mockResolvedValue({
      id: 'platform-v2',
      capabilityId: 'cap-1',
      status: 'PENDING_PLATFORM_REVIEW',
      createdById: 'user-1',
      version: '2.0.0',
    });
    prisma.skillVersion.update.mockResolvedValue({ id: 'platform-v2', status: 'PLATFORM_APPROVED' });
    prisma.skillVersionReview.create.mockResolvedValue({ id: 'review-3' });

    await service.reviewPlatformVersion('platform-admin', 'platform-v2', { decision: 'APPROVE' });

    expect(prisma.skillVersionReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionId: 'platform-v2',
        actorType: 'PLATFORM',
        decision: 'APPROVE',
        reviewerId: 'platform-admin',
      }),
    });
    expect(prisma.contributionRewardEvent.createMany).not.toHaveBeenCalled();
  });
  });
});

describe('CapabilityContributionService RPA download access', () => {
  function makeService() {
    const prisma = {
      capability: { findUnique: jest.fn() },
      rpaVersion: { findFirst: jest.fn() },
    };
    const context = {
      resolveOrNull: jest.fn().mockResolvedValue({
        enterpriseId: 'enterprise-1',
        role: 'MEMBER',
      }),
    };
    const service = new CapabilityContributionService(
      prisma as never,
      context as never,
      new CapabilityValidatorService(),
      { read: jest.fn() } as never,
    );
    return { prisma, context, service };
  }

  it('allows the contributor to download an enterprise-approved RPA version', async () => {
    const { prisma, service } = makeService();
    const sha256 = 'a'.repeat(64);
    prisma.capability.findUnique.mockResolvedValue({
      id: 'rpa-1',
      name: '报表流程',
      type: 'RPA',
      contributorId: 'user-1',
      enterpriseId: 'enterprise-1',
      visibility: 'ENTERPRISE_PRIVATE',
      enterpriseReviewStatus: 'APPROVED',
      platformReviewStatus: 'NOT_SUBMITTED',
    });
    prisma.rpaVersion.findFirst.mockResolvedValue({
      id: 'rpa-version-1',
      version: '1.0.0',
      packageKey: `rpa/${sha256}.zip`,
      packageSha256: sha256,
      packageFilename: '报表流程-v1.zip',
    });

    await expect(service.getRpaPackage('user-1', 'rpa-1')).resolves.toEqual({
      key: `rpa/${sha256}.zip`,
      sha256,
      version: '1.0.0',
      filename: '报表流程-v1.zip',
    });
    expect(prisma.rpaVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        capabilityId: 'rpa-1',
        status: { in: ['ENTERPRISE_APPROVED', 'PLATFORM_APPROVED'] },
      }),
    }));
  });

  it('uses the explicitly requested RPA version and rejects an unreviewed version', async () => {
    const { prisma, service } = makeService();
    const sha256 = 'b'.repeat(64);
    prisma.capability.findUnique.mockResolvedValue({
      id: 'rpa-2',
      name: '草稿流程',
      type: 'RPA',
      contributorId: 'user-1',
      enterpriseId: 'enterprise-1',
      visibility: 'ENTERPRISE_PRIVATE',
      enterpriseReviewStatus: 'APPROVED',
      platformReviewStatus: 'NOT_SUBMITTED',
    });
    prisma.rpaVersion.findFirst.mockResolvedValue(null);

    await expect(service.getRpaPackage('user-1', 'rpa-2', 'draft-version'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.rpaVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'draft-version', capabilityId: 'rpa-2' }),
    }));
    void sha256;
  });
});

describe('CapabilityContributionService download audit', () => {
  it('records Skill download metadata without blocking an authorized download when audit storage is unavailable', async () => {
    const sha256 = 'a'.repeat(64);
    const prisma = {
      skillVersion: { findUnique: jest.fn() },
    };
    const context = {
      resolveOrNull: jest.fn().mockResolvedValue(null),
    };
    const audit = {
      record: jest.fn().mockRejectedValue(new Error('audit database unavailable')),
    };
    const service = new CapabilityContributionService(
      prisma as never,
      context as never,
      new CapabilityValidatorService(),
      { read: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      audit as never,
    );
    prisma.skillVersion.findUnique.mockResolvedValue({
      packageKey: `skills/${sha256}.zip`,
      packageSha256: sha256,
      packageFilename: '销售分析.zip',
      version: '1.0.0',
      scope: 'PLATFORM',
      status: 'PLATFORM_APPROVED',
      capability: {
        id: 'cap-1',
        name: '销售分析',
        contributorId: 'author-1',
        enterpriseId: null,
        visibility: 'MARKET_PUBLIC',
        enterpriseReviewStatus: 'NOT_SUBMITTED',
        platformReviewStatus: 'APPROVED',
      },
    });

    await expect(
      service.getVersionPackage('reader-1', 'v1', undefined, {
        ip: '127.0.0.1',
        userAgent: 'SEP-CLI/1.0',
      }),
    ).resolves.toEqual({
      key: `skills/${sha256}.zip`,
      sha256,
      version: '1.0.0',
      filename: '销售分析.zip',
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'reader-1',
      action: 'CONTRIBUTION_SKILL_DOWNLOAD',
      resourceType: 'SKILL_VERSION',
      resourceId: 'v1',
      metadata: expect.objectContaining({
        sha256,
        ip: '127.0.0.1',
        userAgent: 'SEP-CLI/1.0',
      }),
    }));
  });

  it('records RPA version download metadata for an authorized contributor', async () => {
    const sha256 = 'b'.repeat(64);
    const prisma = {
      capability: { findUnique: jest.fn() },
      rpaVersion: { findFirst: jest.fn() },
    };
    const context = {
      resolveOrNull: jest.fn().mockResolvedValue({
        enterpriseId: 'enterprise-1',
        role: 'MEMBER',
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new CapabilityContributionService(
      prisma as never,
      context as never,
      new CapabilityValidatorService(),
      { read: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      audit as never,
    );
    prisma.capability.findUnique.mockResolvedValue({
      id: 'rpa-1',
      name: '报表流程',
      type: 'RPA',
      contributorId: 'user-1',
      enterpriseId: 'enterprise-1',
      visibility: 'ENTERPRISE_PRIVATE',
      enterpriseReviewStatus: 'APPROVED',
      platformReviewStatus: 'NOT_SUBMITTED',
    });
    prisma.rpaVersion.findFirst.mockResolvedValue({
      id: 'rpa-version-1',
      version: '1.2.0',
      packageKey: `rpa/${sha256}.zip`,
      packageSha256: sha256,
      packageFilename: '报表流程-v1.2.zip',
    });

    await service.getRpaPackage('user-1', 'rpa-1', undefined, {
      ip: '10.0.0.1',
      userAgent: 'SEP-Web/1.0',
    });

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'user-1',
      action: 'CONTRIBUTION_RPA_DOWNLOAD',
      resourceType: 'RPA_VERSION',
      resourceId: 'rpa-version-1',
      metadata: expect.objectContaining({
        versionId: 'rpa-version-1',
        version: '1.2.0',
        sha256,
        ip: '10.0.0.1',
        userAgent: 'SEP-Web/1.0',
      }),
    }));
  });

});

describe('CapabilityContributionService review notifications', () => {
  it('notifies enterprise admins when a capability enters enterprise review', async () => {
    const capability = {
      id: 'cap-1',
      name: '销售分析',
      type: 'SKILL',
      enterpriseId: 'enterprise-1',
      contributorId: 'user-1',
      enterpriseReviewStatus: 'NOT_SUBMITTED',
      platformReviewStatus: 'NOT_SUBMITTED',
    };
    const prisma = {
      capability: {
        findFirst: jest.fn().mockResolvedValue(capability),
        update: jest.fn().mockResolvedValue(capability),
      },
      skillVersion: {
        findFirst: jest.fn().mockResolvedValue({
          content: '# 角色\n数据分析师\n# 输入\n销售数据\n# 步骤\n分析趋势\n# 输出\n报告',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      contributionRewardEvent: { createMany: jest.fn() },
      enterpriseMember: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'admin-1' }, { userId: 'admin-2' }]),
      },
      $transaction: jest.fn(),
    };
    const context = {
      resolve: jest.fn().mockResolvedValue({ enterpriseId: 'enterprise-1' }),
    };
    const notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createBatch: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CapabilityContributionService(
      prisma as never,
      context as never,
      new CapabilityValidatorService(),
      { read: jest.fn() } as never,
      undefined,
      notifications as never,
    );
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );

    await service.submitEnterpriseReview('user-1', 'cap-1');

    expect(notifications.createBatch).toHaveBeenCalledWith(
      ['admin-1', 'admin-2'],
      expect.objectContaining({
        type: 'INFO',
        category: 'APPROVAL',
        relatedId: 'cap-1',
      }),
    );
  });

  it('does not fail an approval request when notification storage is unavailable', async () => {
    const capability = {
      id: 'cap-1',
      name: '公开周报',
      type: 'SKILL',
      enterpriseId: null,
      contributorId: 'user-1',
      platformReviewStatus: 'PENDING_REVIEW',
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      capability: {
        findUnique: jest.fn().mockResolvedValue(capability),
        update: jest.fn().mockResolvedValue(capability),
      },
      skillVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contributionRewardEvent: { createMany: jest.fn() },
      $transaction: jest.fn(),
    };
    const notifications = {
      create: jest.fn().mockRejectedValue(new Error('notification database unavailable')),
      createBatch: jest.fn(),
    };
    const service = new CapabilityContributionService(
      prisma as never,
      { resolveOrNull: jest.fn() } as never,
      new CapabilityValidatorService(),
      { read: jest.fn() } as never,
      undefined,
      notifications as never,
    );
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );

    await expect(
      service.reviewPlatform('platform-admin', 'cap-1', { decision: 'APPROVE' }),
    ).resolves.toEqual(capability);
    expect(notifications.create).toHaveBeenCalled();
  });
});


describe('CapabilityContributionService market visibility', () => {
  it('ANDs search terms with published visibility so q cannot expose unpublished capabilities', async () => {
    const capability = { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) };
    const service = new CapabilityContributionService(
      { capability } as never,
      { resolveOrNull: jest.fn() } as never,
      new CapabilityValidatorService(),
      {} as never,
    );

    await service.searchMarket({ q: 'secret' });

    const where = capability.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toEqual({
      OR: [
        { visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED', status: 'APPROVED' },
        { enterpriseId: null, status: 'APPROVED' },
      ],
    });
    expect(where.AND[1]).toEqual({
      OR: [
        { name: { contains: 'secret', mode: 'insensitive' } },
        { description: { contains: 'secret', mode: 'insensitive' } },
      ],
    });
    expect(capability.count).toHaveBeenCalledWith({ where });
    const query = capability.findMany.mock.calls[0][0];
    expect(query.select.skillVersions).toEqual({
      where: { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      orderBy: [
        { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: 1,
      select: { id: true, version: true, packageSha256: true, packageFilename: true },
    });
    expect(query.select.rpaVersions.orderBy).toEqual({ createdAt: 'desc' });
    expect(query.orderBy).toEqual([{ usageCount: 'desc' }, { updatedAt: 'desc' }]);
  });

  it('binds the latest platform publication with creation time fallback to an existing employee', async () => {
    const prisma = {
      capability: { findFirst: jest.fn().mockResolvedValue({ id: 'cap-1', type: 'SKILL' }) },
      digitalEmployee: { findUnique: jest.fn().mockResolvedValue({ id: 'emp-1' }) },
      skillVersion: { findFirst: jest.fn().mockResolvedValue({ id: 'republished-old-draft' }) },
      employeeCapabilityBinding: { create: jest.fn().mockResolvedValue({ id: 'binding-1' }) },
    };
    const service = new CapabilityContributionService(
      prisma as never,
      {} as never,
      new CapabilityValidatorService(),
      {} as never,
    );

    await service.bindPublishedCapability('user-1', 'cap-1', 'emp-1');

    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      orderBy: [
        { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      select: { id: true },
    });
    expect(prisma.employeeCapabilityBinding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { employeeId: 'emp-1', capabilityId: 'cap-1', priority: 0, defaultSkillVersionId: 'republished-old-draft' },
      }),
    );
  });
});
