import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, SkillVersion } from '@prisma/client';
import { ClientSkillArtifactService } from '../client/client-skill-artifact.service';
import { EmployeeReadinessService } from './employee-readiness.service';

const version = (capabilityId = 'cap-1', changes: Partial<SkillVersion> = {}): SkillVersion => ({
  id: `version-${capabilityId}`, capabilityId, scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
  content: 'Generate a product description.', packageKey: null, packageSha256: null, ...changes,
} as SkillVersion);
const binding = (capabilityId = 'cap-1', changes: any = {}) => ({
  id: `binding-${capabilityId}`, capabilityId, enabled: true, priority: 0,
  defaultSkillVersionId: null, defaultSkillVersion: null,
  capability: {
    id: capabilityId, name: `能力-${capabilityId}`, type: 'SKILL', status: 'APPROVED',
    enterpriseId: null, visibility: 'ENTERPRISE_PRIVATE', platformReviewStatus: 'NOT_SUBMITTED',
  }, ...changes,
});

describe('EmployeeReadinessService', () => {
  const prisma = {
    $transaction: jest.fn(), $queryRaw: jest.fn(),
    digitalEmployee: { findUnique: jest.fn() },
    employeeCapabilityBinding: { findMany: jest.fn() },
    skillVersion: { findFirst: jest.fn() },
  };
  const packages = { readInstallablePackage: jest.fn() };
  let artifacts: ClientSkillArtifactService;
  let service: EmployeeReadinessService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((action) => action(prisma));
    prisma.digitalEmployee.findUnique.mockResolvedValue({ id: 'emp-1', status: 'DRAFT' });
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding()]);
    prisma.skillVersion.findFirst.mockResolvedValue(version());
    artifacts = new ClientSkillArtifactService(prisma as any, {} as any, { assertEmployeeSubscriptionsReady: jest.fn().mockResolvedValue(undefined) } as any, packages as any);
    service = new EmployeeReadinessService(prisma as any, artifacts);
  });

  it('requires at least one enabled binding and only queries enabled bindings', async () => {
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([]);
    await expect(service.assertReady('emp-1')).rejects.toThrow('至少需要一个已启用能力');
    expect(prisma.employeeCapabilityBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { employeeId: 'emp-1', enabled: true },
    }));
  });

  it('rejects missing approved versions with the capability name', async () => {
    prisma.skillVersion.findFirst.mockResolvedValue(null);
    await expect(service.assertReady('emp-1')).rejects.toThrow('能力-cap-1：缺少已批准平台版本');
  });

  it('uses real artifact preparation and includes a blocked reason', async () => {
    prisma.skillVersion.findFirst.mockResolvedValue(version('cap-1', { content: '' }));
    await expect(service.assertReady('emp-1')).rejects.toThrow('能力-cap-1：技能制品不可安装 (INVALID_ENTRY)');
  });

  it('blocks a single-file skill whose referenced local resource has no package', async () => {
    prisma.skillVersion.findFirst.mockResolvedValue(version('cap-1', { content: '[Checklist](./checklist.md)' }));
    await expect(service.assertReady('emp-1')).rejects.toThrow('PACKAGE_REQUIRED');
  });

  it('checks actual subscription overrides in the same transaction after template readiness', async () => {
    const check = jest.spyOn(artifacts, 'assertEmployeeSubscriptionsReady')
      .mockRejectedValue(new BadRequestException('企业生效版本目录冲突'));
    await expect(service.assertReady('emp-1', prisma as any)).rejects.toThrow('企业生效版本目录冲突');
    expect(check).toHaveBeenCalledWith('emp-1', prisma);
  });

  it('accepts Chinese AVAILABLE entries without renaming approved content', async () => {
    const content = '---\nname: 商品卖点结构化\ndescription: 商品卖点生成\n---\n整理商品卖点。';
    prisma.skillVersion.findFirst.mockResolvedValue(version('cap-1', { content }));
    const descriptor = await artifacts.describe('emp-1', 'cap-1', version('cap-1', { content }));
    expect(descriptor).toMatchObject({ status: 'AVAILABLE', installationDirectory: '商品卖点结构化' });
    await expect(service.assertReady('emp-1')).resolves.toBeUndefined();
    expect(prisma.skillVersion.findFirst.mock.results.length).toBe(1);
  });

  it('selects latest approved PLATFORM version using runtime publication order', async () => {
    await service.assertReady('emp-1');
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith({
      where: { capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
      orderBy: [{ platformReviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('prefers a valid approved pin over a newer available version', async () => {
    const pinned = version('cap-1', { id: 'old-approved' });
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding('cap-1', {
      defaultSkillVersionId: pinned.id, defaultSkillVersion: pinned,
    })]);
    const describe = jest.spyOn(artifacts, 'describe');
    await service.assertReady('emp-1');
    expect(describe).toHaveBeenCalledWith('emp-1', 'cap-1', pinned);
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    null,
    version('other'),
    version('cap-1', { status: 'DRAFT' }),
    version('cap-1', { scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED' }),
    version('cap-1', { id: 'different-version' }),
  ])('does not fall back from an invalid pinned version (case %#)', async (pinned) => {
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding('cap-1', {
      defaultSkillVersionId: 'version-cap-1', defaultSkillVersion: pinned,
    })]);
    await expect(service.assertReady('emp-1')).rejects.toThrow('绑定默认版本不是该能力的已批准平台版本');
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
  });

  it('does not replace a blocked valid pin with a newer installable version', async () => {
    const pinned = version('cap-1', { content: '' });
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding('cap-1', {
      defaultSkillVersionId: pinned.id, defaultSkillVersion: pinned,
    })]);
    await expect(service.assertReady('emp-1')).rejects.toThrow('INVALID_ENTRY');
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
  });

  it.each([['ENTERPRISE_PRIVATE', 'APPROVED'], ['MARKET_PUBLIC', 'NOT_SUBMITTED']])(
    'rejects nonpublic or unreviewed enterprise capabilities: %s %s', async (visibility, platformReviewStatus) => {
      const item = binding();
      item.capability = { ...item.capability, enterpriseId: 'ent-1', visibility, platformReviewStatus };
      prisma.employeeCapabilityBinding.findMany.mockResolvedValue([item]);
      await expect(service.assertReady('emp-1')).rejects.toThrow('企业能力未通过平台审核并公开到市场');
    },
  );

  it('accepts approved public enterprise capabilities', async () => {
    const item = binding();
    item.capability = { ...item.capability, enterpriseId: 'ent-1', visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED' };
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([item]);
    await expect(service.assertReady('emp-1')).resolves.toBeUndefined();
  });

  it('rejects unapproved capabilities even if public', async () => {
    const item = binding();
    item.capability.status = 'PENDING';
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([item]);
    await expect(service.assertReady('emp-1')).rejects.toThrow('能力未批准 (PENDING)');
  });

  it('allows legacy approved non-SKILL capabilities without versions', async () => {
    const item = binding();
    item.capability.type = 'AGENT';
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([item]);
    await service.assertReady('emp-1');
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
  });

  it.each([['商品卖点', '商品卖点'], ['café', 'cafe\u0301'], ['shop', 'ＳＨＯＰ']])(
    'rejects installation names colliding after normalization: %s %s', async (first, second) => {
      prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding(), binding('cap-2')]);
      jest.spyOn(artifacts, 'describe').mockImplementation(async (_employeeId, capabilityId) => ({
        status: 'AVAILABLE', installationDirectory: capabilityId === 'cap-1' ? first : second,
      } as any));
      await expect(service.assertReady('emp-1')).rejects.toThrow('能力-cap-1：安装目录与「能力-cap-2」冲突');
    },
  );

  it('reports all blocked capabilities in one structured failure', async () => {
    prisma.employeeCapabilityBinding.findMany.mockResolvedValue([binding(), binding('cap-2')]);
    prisma.skillVersion.findFirst.mockResolvedValue(null);
    try {
      await service.assertReady('emp-1');
      throw new Error('expected readiness failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'EMPLOYEE_NOT_READY', failures: [
          { capabilityId: 'cap-1', capabilityName: '能力-cap-1' },
          { capabilityId: 'cap-2', capabilityName: '能力-cap-2' },
        ],
      });
    }
  });

  it('locks and rereads the employee in the transaction before acting', async () => {
    const action = jest.fn().mockResolvedValue('ok');
    expect(await service.withEmployeeLock('emp-1', action)).toBe('ok');
    expect(prisma.$queryRaw.mock.calls[0][0].join('?')).toBe('SELECT id FROM digital_employees WHERE id = ? FOR UPDATE');
    expect(prisma.$queryRaw.mock.calls[0][1]).toBe('emp-1');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.digitalEmployee.findUnique.mock.invocationCallOrder[0]);
    expect(action).toHaveBeenCalledWith(prisma, { id: 'emp-1', status: 'DRAFT' });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable', timeout: 30_000,
    });
  });

  it('fails when the employee disappeared before acquiring the lock', async () => {
    prisma.digitalEmployee.findUnique.mockResolvedValue(null);
    await expect(service.withEmployeeLock('missing', jest.fn())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports a retryable conflict on concurrent serialization failure', async () => {
    prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: '6' }));
    await expect(service.withEmployeeLock('emp-1', jest.fn())).rejects.toBeInstanceOf(ConflictException);
  });
});
