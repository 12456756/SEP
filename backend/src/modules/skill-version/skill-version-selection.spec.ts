import { ForbiddenException } from '@nestjs/common';
import { SkillVersionService } from './skill-version.service';

const platform = { id: 'platform-1', capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED', enterpriseId: null };
const enterprise = { ...platform, id: 'enterprise-1', scope: 'ENTERPRISE', status: 'ENTERPRISE_APPROVED', enterpriseId: 'ent-1' };

function build() {
  const prisma = {
    capability: { findUnique: jest.fn().mockResolvedValue({ status: 'APPROVED' }) },
    subscription: { findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', employee: { bindings: [{ defaultSkillVersion: platform }] } }) },
    skillVersion: { findFirst: jest.fn().mockResolvedValue(platform) },
    memberSkillVersionSelection: { upsert: jest.fn(), findFirst: jest.fn() },
    subscriptionSkillVersion: { findUnique: jest.fn().mockResolvedValue({ version: platform }) },
  };
  const defaults = { get: jest.fn().mockResolvedValue({ version: enterprise }) };
  const context = { resolve: jest.fn() };
  return { prisma, defaults, service: new SkillVersionService(prisma as never, context as never, defaults as never) };
}

describe('正式执行统一跟随企业启用版本', () => {
  it.each([null, 'platform-1', 'personal-1'])('个人选版写入已停用（%j），不改历史记录', async (id) => {
    const { service, prisma } = build();
    await expect(service.selectPersonalVersion('user-1', 'sub-1', 'cap-1', id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.memberSkillVersionSelection.upsert).not.toHaveBeenCalled();
  });

  it.each([undefined, 'user-1'])('企业启用优先，忽略个人 PIN 和工作副本（%j）', async (userId) => {
    const { service, prisma } = build();
    prisma.memberSkillVersionSelection.findFirst.mockResolvedValue({ version: { ...enterprise, scope: 'PERSONAL' } });
    await expect(service.resolveEffectiveVersion('sub-1', 'cap-1', userId)).resolves.toEqual(enterprise);
    expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptionSkillVersion.findUnique).not.toHaveBeenCalled();
  });

  it('企业切回历史已通过平台版，所有成员随之切换', async () => {
    const { service, defaults } = build();
    defaults.get.mockResolvedValue({ version: platform });
    await expect(service.resolveEffectiveVersion('sub-1', 'cap-1', 'user-1')).resolves.toEqual(platform);
  });

  it.each([
    { ...enterprise, enterpriseId: 'other-ent' },
    { ...enterprise, capabilityId: 'other-cap' },
    { ...enterprise, status: 'ENTERPRISE_REJECTED' },
    { ...enterprise, scope: 'PERSONAL' },
  ])('无效或越权企业默认不参与执行：%j', async (version) => {
    const { service, defaults } = build();
    defaults.get.mockResolvedValue({ version });
    await expect(service.resolveEffectiveVersion('sub-1', 'cap-1')).resolves.toEqual(platform);
  });

  it('缺少企业默认和有效订阅默认时回落模板已通过平台版', async () => {
    const { service, prisma, defaults } = build();
    defaults.get.mockResolvedValue(null);
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue({ version: { ...enterprise, scope: 'PERSONAL' } });
    await expect(service.resolveEffectiveVersion('sub-1', 'cap-1')).resolves.toEqual(platform);
    expect(prisma.subscription.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({
      employee: { select: { bindings: { where: { capabilityId: 'cap-1', enabled: true, capability: { status: 'APPROVED' } }, select: { defaultSkillVersion: true }, take: 1 } } },
    }) }));
  });

  it('不存在的订阅不能获取技能正文', async () => {
    const { service, prisma, defaults } = build();
    prisma.subscription.findUnique.mockResolvedValue(null);
    await expect(service.resolveEffectiveVersion('missing', 'cap-1')).resolves.toBeNull();
    expect(defaults.get).not.toHaveBeenCalled();
    expect(prisma.skillVersion.findFirst).not.toHaveBeenCalled();
  });

  it('无有效默认时只查询已通过平台版本，不恢复历史个人版本', async () => {
    const { service, prisma, defaults } = build();
    defaults.get.mockResolvedValue(null);
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue(null);
    prisma.subscription.findUnique.mockResolvedValue({ enterpriseId: 'ent-1', employee: { bindings: [] } });
    await expect(service.resolveEffectiveVersion('sub-1', 'cap-1', 'user-1')).resolves.toEqual(platform);
    expect(prisma.skillVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      capabilityId: 'cap-1', scope: 'PLATFORM', status: 'PLATFORM_APPROVED',
    } }));
  });
});
