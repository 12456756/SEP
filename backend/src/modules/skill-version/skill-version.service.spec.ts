import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SkillVersionService } from './skill-version.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';

const memberContext = {
  enterpriseId: 'enterprise-1',
  memberId: 'member-1',
  departmentId: 'department-1',
  role: 'MEMBER' as const,
};

const adminContext = { ...memberContext, role: 'ENTERPRISE_ADMIN' as const };

const platformVersion = {
  id: 'version-platform',
  capabilityId: 'capability-1',
  scope: 'PLATFORM',
  enterpriseId: null,
  parentVersionId: null,
  sourceVersionId: null,
  version: '1.0.0',
  content: '# Approved skill',
  changeSummary: null,
  status: 'PLATFORM_APPROVED',
  createdAt: new Date(),
  updatedAt: new Date(),
  capability: { id: 'capability-1', name: 'Skill', description: 'Description' },
};

function createPrismaMock() {
  const prisma = {
    skillVersion: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    skillVersionReview: { create: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'enterprise-1', employee: { bindings: [] } }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    capability: { findUnique: jest.fn().mockResolvedValue({ id: 'capability-1', name: '测试能力', status: 'APPROVED' }) },
    enterpriseMember: { findMany: jest.fn().mockResolvedValue([]) },
    notification: { createMany: jest.fn() },
    employeeCapabilityBinding: {
      findFirst: jest.fn(),
      // 「发布为平台版」要把员工模板钉着的默认版推到新版本，否则那个动作没有任何效果
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    memberSkillVersionSelection: { findFirst: jest.fn().mockResolvedValue(null) },
    subscriptionSkillVersion: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    enterpriseSkillDefault: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return prisma;
}

describe('SkillVersionService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let enterpriseContext: {
    resolve: jest.Mock;
    assertCanApprove: jest.Mock;
    assertEnterpriseAdmin: jest.Mock;
  };
  let service: SkillVersionService;
  let defaults: { get: jest.Mock; lock: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    enterpriseContext = {
      resolve: jest.fn().mockResolvedValue(memberContext),
      assertCanApprove: jest.fn(),
      assertEnterpriseAdmin: jest.fn((ctx) => {
        if (ctx.role !== 'ENTERPRISE_ADMIN') throw new ForbiddenException('仅企业管理员可执行此操作');
      }),
    };
    defaults = { get: jest.fn().mockResolvedValue(null), lock: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue({ affectedSubscriptions: 0 }) };
    service = new SkillVersionService(
      prisma as unknown as PrismaService,
      enterpriseContext as unknown as EnterpriseContextService,
      defaults as never,
    );
  });

  it('denies preview when the member has no active granted subscription', async () => {
    prisma.skillVersion.findUnique.mockResolvedValue(platformVersion);
    prisma.subscription.findFirst.mockResolvedValue(null);

    await expect(service.previewEnterpriseVersion('user-1', platformVersion.id)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('returns personal submission Markdown byte-for-byte, including frontmatter and CRLF', async () => {
    const content = '---\r\nname: client-skill\r\n---\r\n\r\n# Content\r\n';
    prisma.skillVersion.findUnique.mockResolvedValue({
      ...platformVersion, scope: 'PERSONAL', ownerId: 'user-1',
      enterpriseId: memberContext.enterpriseId, status: 'ENTERPRISE_REJECTED', content,
    });
    prisma.subscription.findFirst.mockResolvedValue({ id: 'subscription-1' });
    const result = await service.previewEnterpriseVersion('user-1', 'personal-version');
    expect(result.content).toBe(content);
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ endDate: null }, { endDate: { gt: expect.any(Date) } }] }),
    }));
  });

  it.each([
    { ownerId: 'other-user', enterpriseId: memberContext.enterpriseId },
    { ownerId: 'user-1', enterpriseId: 'other-enterprise' },
  ])('hides personal content outside ownership and tenant boundaries: %j', async (ownership) => {
    prisma.skillVersion.findUnique.mockResolvedValue({
      ...platformVersion, ...ownership, scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW',
      submittedAt: new Date(),
    });
    await expect(service.previewEnterpriseVersion('user-1', 'personal-version')).rejects.toThrow(NotFoundException);
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('lets an administrator read a submitted review without an employee grant', async () => {
    enterpriseContext.resolve.mockResolvedValue(adminContext);
    const pending = { ...platformVersion, scope: 'PERSONAL', ownerId: 'other-user',
      enterpriseId: memberContext.enterpriseId, status: 'PENDING_ENTERPRISE_REVIEW', submittedAt: new Date() };
    prisma.skillVersion.findUnique.mockResolvedValue(pending);
    await expect(service.previewEnterpriseVersion('admin', 'personal-version')).resolves.toEqual(pending);
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('includes own pending submissions without selecting them as the current published version', async () => {
    prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-1' });
    Object.assign(prisma.employeeCapabilityBinding, { findMany: jest.fn().mockResolvedValue([
      { capability: platformVersion.capability, defaultSkillVersion: platformVersion },
    ]) });
    Object.assign(prisma.subscriptionSkillVersion, { findMany: jest.fn().mockResolvedValue([]) });
    const pending = { ...platformVersion, id: 'pending', scope: 'PERSONAL', status: 'PENDING_ENTERPRISE_REVIEW' };
    prisma.skillVersion.findMany.mockResolvedValue([pending, platformVersion]);
    prisma.skillVersion.findFirst.mockResolvedValue(platformVersion);
    const result = await service.listEmployeeSkills('user-1', 'employee-1');
    expect(result.skills[0].currentVersion.id).toBe(platformVersion.id);
    expect(result.skills[0].currentVersion).not.toHaveProperty('content');
    expect(result.skills[0].versions).toContain(pending);
    expect(result.skills[0].latestPublishedVersion.id).toBe(platformVersion.id);
    expect(prisma.skillVersion.findMany.mock.calls[0][0].where.OR).toContainEqual({
      scope: 'PERSONAL', enterpriseId: memberContext.enterpriseId, ownerId: 'user-1',
    });
  });

  it('hides another enterprise private version', async () => {
    prisma.skillVersion.findUnique.mockResolvedValue({
      ...platformVersion,
      scope: 'ENTERPRISE',
      enterpriseId: 'enterprise-2',
      status: 'ENTERPRISE_APPROVED',
    });

    await expect(service.previewEnterpriseVersion('user-1', 'private-version')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it('hides a platform version before platform approval', async () => {
    prisma.skillVersion.findUnique.mockResolvedValue({
      ...platformVersion,
      status: 'PENDING_PLATFORM_REVIEW',
    });

    await expect(service.previewEnterpriseVersion('user-1', 'pending-version')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does not allow selecting an unapproved version', async () => {
    enterpriseContext.resolve.mockResolvedValue(adminContext);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'subscription-1',
      employeeId: 'employee-1',
      enterpriseId: 'enterprise-1',
    });
    prisma.employeeCapabilityBinding.findFirst.mockResolvedValue({ id: 'binding-1' });
    prisma.skillVersion.findUnique.mockResolvedValue({
      ...platformVersion,
      status: 'PENDING_PLATFORM_REVIEW',
    });

    await expect(
      service.selectVersion(
        'admin-1',
        'subscription-1',
        'capability-1',
        platformVersion.id,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
    expect(defaults.lock).not.toHaveBeenCalled();
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('switches the enterprise default through the shared service without changing member preferences', async () => {
    enterpriseContext.resolve.mockResolvedValue(adminContext);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'subscription-1', employeeId: 'employee-1', enterpriseId: 'enterprise-1',
    });
    prisma.employeeCapabilityBinding.findFirst.mockResolvedValue({ id: 'binding-1' });
    prisma.skillVersion.findUnique.mockResolvedValue(platformVersion);
    await service.selectVersion('admin-1', 'subscription-1', 'capability-1', platformVersion.id);
    expect(defaults.lock).toHaveBeenCalledWith(prisma, 'enterprise-1', 'capability-1');
    expect(defaults.set).toHaveBeenCalledWith(prisma, 'enterprise-1', 'capability-1', platformVersion.id, 'admin-1');
    expect(defaults.lock.mock.invocationCallOrder[0]).toBeLessThan(defaults.set.mock.invocationCallOrder[0]);
    expect(prisma.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
    expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'PERSONAL', enterpriseId: 'enterprise-1', ownerId: 'admin-1', status: 'ENTERPRISE_APPROVED' },
    { scope: 'ENTERPRISE', enterpriseId: 'other-enterprise', status: 'ENTERPRISE_APPROVED' },
    { scope: 'ENTERPRISE', enterpriseId: 'enterprise-1', status: 'ENTERPRISE_REJECTED' },
  ])('cannot make a personal, foreign or unpublished version the enterprise default: %j', async (version) => {
    enterpriseContext.resolve.mockResolvedValue(adminContext);
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'subscription-1', employeeId: 'employee-1', enterpriseId: 'enterprise-1',
    });
    prisma.employeeCapabilityBinding.findFirst.mockResolvedValue({ id: 'binding-1' });
    prisma.skillVersion.findUnique.mockResolvedValue({ ...platformVersion, ...version });
    await expect(service.selectVersion('admin-1', 'subscription-1', 'capability-1', platformVersion.id))
      .rejects.toThrow(BadRequestException);
    expect(defaults.set).not.toHaveBeenCalled();
  });

  describe('setEnterpriseDefault', () => {
    it('denies ordinary members before checking capability visibility or writing defaults', async () => {
      await expect(service.setEnterpriseDefault('user-1', 'capability-1', platformVersion.id))
        .rejects.toThrow(ForbiddenException);
      expect(enterpriseContext.assertEnterpriseAdmin).toHaveBeenCalledWith(memberContext);
      expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
      expect(defaults.lock).not.toHaveBeenCalled();
      expect(defaults.set).not.toHaveBeenCalled();
    });

    it('allows an administrator to roll back a retained enterprise skill without a subscription', async () => {
      enterpriseContext.resolve.mockResolvedValue(adminContext);
      prisma.subscription.findFirst.mockResolvedValue(null);
      prisma.skillVersion.findFirst.mockResolvedValue({ id: 'enterprise-new' });
      const oldVersion = { ...platformVersion, id: 'enterprise-old', scope: 'ENTERPRISE',
        enterpriseId: 'enterprise-1', status: 'ENTERPRISE_APPROVED', version: '1.0.0' };
      prisma.skillVersion.findUnique.mockResolvedValue(oldVersion);

      await expect(service.setEnterpriseDefault('admin-1', 'capability-1', oldVersion.id))
        .resolves.toEqual({ capabilityId: 'capability-1', versionId: oldVersion.id, version: oldVersion });

      expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
        enterpriseId: 'enterprise-1', capabilityId: 'capability-1', capability: { type: 'SKILL' }, OR: [
          { scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' },
          { scope: 'PERSONAL', workingCopyId: null,
            status: { in: ['PERSONAL_ACTIVE', 'PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED'] } },
        ],
      } }));
      expect(defaults.lock).toHaveBeenCalledWith(prisma, 'enterprise-1', 'capability-1');
      expect(defaults.set).toHaveBeenCalledWith(prisma, 'enterprise-1', 'capability-1', oldVersion.id, 'admin-1');
      expect(defaults.lock.mock.invocationCallOrder[0]).toBeLessThan(defaults.set.mock.invocationCallOrder[0]);
      expect(prisma.subscriptionSkillVersion.upsert).not.toHaveBeenCalled();
      expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
      expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    });

    it('hides capabilities that have neither an active enterprise binding nor retained versions', async () => {
      enterpriseContext.resolve.mockResolvedValue(adminContext);
      prisma.subscription.findFirst.mockResolvedValue(null);
      prisma.skillVersion.findFirst.mockResolvedValue(null);
      await expect(service.setEnterpriseDefault('admin-1', 'capability-1', platformVersion.id))
        .rejects.toThrow(NotFoundException);
      expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
      expect(defaults.set).not.toHaveBeenCalled();
    });

    it.each([
      { scope: 'PERSONAL', enterpriseId: 'enterprise-1', ownerId: 'admin-1', status: 'ENTERPRISE_APPROVED' },
      { scope: 'ENTERPRISE', enterpriseId: 'other-enterprise', status: 'ENTERPRISE_APPROVED' },
      { scope: 'ENTERPRISE', enterpriseId: 'enterprise-1', status: 'DRAFT' },
      { scope: 'PLATFORM', status: 'PENDING_PLATFORM_REVIEW' },
      { capabilityId: 'other-capability' },
    ])('rejects invalid global default selections without taking the write lock: %j', async (version) => {
      enterpriseContext.resolve.mockResolvedValue(adminContext);
      prisma.subscription.findFirst.mockResolvedValue({ id: 'subscription-1' });
      prisma.skillVersion.findUnique.mockResolvedValue({ ...platformVersion, ...version });
      await expect(service.setEnterpriseDefault('admin-1', 'capability-1', platformVersion.id))
        .rejects.toThrow(BadRequestException);
      expect(defaults.lock).not.toHaveBeenCalled();
      expect(defaults.set).not.toHaveBeenCalled();
    });
  });

  it.each([
    null, { status: 'ENTERPRISE_APPROVED' }, { status: 'PENDING_ENTERPRISE_REVIEW' }, { status: 'ARCHIVED' },
  ])('rejects obsolete Web edits without reading or writing a version: %j', async (current) => {
    enterpriseContext.resolve.mockResolvedValue(adminContext);
    const draft = { id: 'enterprise-draft', capabilityId: 'capability-1', status: 'DRAFT' };
    prisma.skillVersion.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(current);
    await expect(service.updateEnterpriseVersion('admin-1', draft.id, { content: 'Must never overwrite publication' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(defaults.lock).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(defaults.set).not.toHaveBeenCalled();
  });

  it('rejects obsolete enterprise platform submission without creating a platform copy', async () => {
    await expect(service.submitPlatformReview('admin-1', 'enterprise-version')).rejects.toThrow(ForbiddenException);
    expect(prisma.skillVersion.findUnique).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
  });

});
