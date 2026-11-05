import { CapabilityService } from './capability.service';
import { SkillVersionService } from '../skill-version/skill-version.service';
import { NotFoundException } from '@nestjs/common';

/** 通过真实解析器核对传入适配器的正文及执行归因，不能只测试选版记录。 */
describe('技能实际执行统一采用企业启用版本', () => {
  const capability = { id: 'cap-1', type: 'SKILL', status: 'APPROVED', agentConfig: { platform: 'OPENCODE', skillName: 'skill' } };
  const enterprise = { id: 'enterprise-v', capabilityId: 'cap-1', scope: 'ENTERPRISE', enterpriseId: 'ent-1', status: 'ENTERPRISE_APPROVED', content: '企业默认正文' };
  const personal = { id: 'personal-v', capabilityId: 'cap-1', scope: 'PERSONAL', enterpriseId: 'ent-1', ownerId: 'user-1', status: 'PERSONAL_ACTIVE', content: '本人副本正文' };
  const platform = { id: 'platform-v', capabilityId: 'cap-1', scope: 'PLATFORM', enterpriseId: null, ownerId: null, status: 'PLATFORM_APPROVED', content: '我选的旧平台正文' };
  function build() {
    const preferences = new Map<string, { versionId: string | null; version: typeof platform | null }>();
    const prisma = {
      capability: { findUnique: jest.fn().mockResolvedValue(capability) },
      subscription: { findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', employee: { bindings: [] } }) },
      memberSkillVersionSelection: { findFirst: jest.fn(async ({ where }) => preferences.get(`${where.member.userId}:${where.subscriptionId}`) ?? null) },
      skillVersion: { findFirst: jest.fn(async ({ where }) => where.ownerId === 'user-1' ? personal : null) },
      subscriptionSkillVersion: { findUnique: jest.fn().mockResolvedValue({ version: enterprise }) },
      enterpriseSkillDefault: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const versions = new SkillVersionService(prisma as never, {} as never);
    const execute = jest.fn().mockResolvedValue({ success: true, output: 'result' });
    const factory = { create: jest.fn().mockReturnValue({ execute }) };
    return { preferences, factory, prisma, execute, service: new CapabilityService(prisma as never, factory as never, versions) };
  }
  it('历史个人 PIN 不影响不同成员的正式执行，正文与归因一致', async () => {
    const { service, preferences, factory, execute, prisma } = build();
    preferences.set('user-1:sub-a', { versionId: platform.id, version: platform });
    preferences.set('user-1:sub-b', { versionId: null, version: null });
    for (const [userId, subscriptionId, expected] of [
      ['user-1', 'sub-a', enterprise], ['user-1', 'sub-b', enterprise], ['user-2', 'sub-a', enterprise],
    ] as const) {
      const input = { userMessage: '执行技能', userId, sessionId: 'session-1' };
      const result = await service.execute('cap-1', input, { subscriptionId, userId });
      expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({ skillContent: expected.content, skillVersionId: expected.id }));
      expect(result.skillVersionId).toBe(expected.id);
      expect(execute).toHaveBeenLastCalledWith(input);
    }
    expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
  });
  it('企业启用新版后正式执行跟随企业，忽略历史个人 PIN 和旧订阅默认', async () => {
    const { service, preferences, prisma, factory } = build();
    preferences.set('user-1:sub-a', { versionId: platform.id, version: platform });
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue({ version: { ...enterprise, id: 'enterprise-new', content: '新默认' } });
    prisma.enterpriseSkillDefault.findUnique.mockResolvedValue({ version: { ...enterprise, id: 'enterprise-global', content: '企业全局默认' } });
    await service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, { subscriptionId: 'sub-a', userId: 'user-1' });
    expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({ skillContent: '企业全局默认', skillVersionId: 'enterprise-global' }));
    expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptionSkillVersion.findUnique).not.toHaveBeenCalled();
  });
  it('跟随企业的真实执行优先使用全局默认而非旧订阅默认', async () => {
    const { service, preferences, prisma, factory } = build();
    preferences.set('user-1:sub-a', { versionId: null, version: null });
    const reverted = { ...enterprise, id: 'enterprise-reverted', content: '回退后的企业默认正文' };
    prisma.enterpriseSkillDefault.findUnique.mockResolvedValue({ version: reverted });
    const result = await service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, {
      subscriptionId: 'sub-a', userId: 'user-1',
    });
    expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({
      skillContent: reverted.content, skillVersionId: reverted.id,
    }));
    expect(result.skillVersionId).toBe(reverted.id);
    expect(prisma.subscriptionSkillVersion.findUnique).not.toHaveBeenCalled();
  });
  it.each(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_REJECTED'])(
    '忽略历史显式选择的 %s 个人版本，不传入实际执行适配器', async (status) => {
      const { service, prisma, factory } = build();
      const saved = { ...personal, status, content: `个人保存正文: ${status}` };
      prisma.memberSkillVersionSelection.findFirst.mockResolvedValue({ versionId: saved.id, version: saved } as never);
      const result = await service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, {
        subscriptionId: 'sub-a', userId: 'user-1',
      });
      expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({
        skillContent: enterprise.content, skillVersionId: enterprise.id,
      }));
      expect(result.skillVersionId).toBe(enterprise.id);
      expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
    },
  );
  it('有无个人偏好均跳过历史副本，使用统一企业版本', async () => {
    const { service, preferences, factory, prisma } = build();
    const input = { userMessage: '执行', sessionId: 'session' };
    await service.execute('cap-1', input, { subscriptionId: 'sub-a', userId: 'user-1' });
    expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({ skillVersionId: enterprise.id }));
    preferences.set('user-1:sub-a', { versionId: null, version: null });
    await service.execute('cap-1', input, { subscriptionId: 'sub-a', userId: 'user-1' });
    expect(factory.create).toHaveBeenLastCalledWith(expect.objectContaining({ skillVersionId: enterprise.id }));
    expect(prisma.memberSkillVersionSelection.findFirst).not.toHaveBeenCalled();
  });
  it('不向正式执行解析器传入 userId，并在无有效版本时停止执行', async () => {
    const resolveEffectiveVersion = jest.fn().mockResolvedValue(null);
    const prisma = { capability: { findUnique: jest.fn().mockResolvedValue(capability) } };
    const execute = jest.fn();
    const factory = { create: jest.fn().mockReturnValue({ execute }) };
    const service = new CapabilityService(prisma as never, factory as never, { resolveEffectiveVersion } as never);

    await expect(service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, {
      subscriptionId: 'sub-a', userId: 'user-1',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(resolveEffectiveVersion).toHaveBeenCalledWith('sub-a', 'cap-1');
    expect(factory.create).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('已下架能力不能继续执行', async () => {
    const prisma = { capability: { findUnique: jest.fn().mockResolvedValue({ ...capability, status: 'ARCHIVED' }) } };
    const factory = { create: jest.fn() };
    const service = new CapabilityService(prisma as never, factory as never, {} as never);

    await expect(service.execute('cap-1', { userMessage: '执行', sessionId: 'session' })).rejects.toBeInstanceOf(NotFoundException);
    expect(factory.create).not.toHaveBeenCalled();
  });
  it('真实解析器没有已通过版本时，不允许 adapter 回退到本地技能', async () => {
    const { service, prisma, factory, execute } = build();
    prisma.subscriptionSkillVersion.findUnique.mockResolvedValue(null);
    await expect(service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, {
      subscriptionId: 'sub-a', userId: 'user-1',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(factory.create).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('历史无 agentConfig 的 SKILL 仍在解析前返回原有错误', async () => {
    const resolveEffectiveVersion = jest.fn();
    const prisma = { capability: { findUnique: jest.fn().mockResolvedValue({ ...capability, agentConfig: null }) } };
    const factory = { create: jest.fn() };
    const service = new CapabilityService(prisma as never, factory as never, { resolveEffectiveVersion } as never);
    await expect(service.execute('cap-1', { userMessage: '执行', sessionId: 'session' }, {
      subscriptionId: 'sub-a', userId: 'user-1',
    })).rejects.toThrow('No agent config for capability cap-1');
    expect(resolveEffectiveVersion).not.toHaveBeenCalled();
    expect(factory.create).not.toHaveBeenCalled();
  });
});
