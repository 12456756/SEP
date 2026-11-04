/**
 * 企业模型配置服务测试。
 *
 * 重点覆盖两处**容易悄悄错掉、且错了不会报错只会用错模型**的逻辑：
 *   ① 会话模型的优先级链：用户选择 > 员工实例 > 部门 > 企业 > 系统兜底。
 *      每层还要各自受白名单和开关约束 —— 少判一个条件不会抛异常，
 *      只会安静地用错模型，线上很难发现。
 *   ② 编排与分析模型（工作安排 / 迭代建议 / 交付物生成共用）：与会话是两条独立的
 *      链，null 表示「跟随平台默认」而不是「没有模型」。清空成空串必须落库 null，
 *      否则会存进一个查不到的模型 id，规划直接 404。
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EnterpriseModelConfigService } from './enterprise-model-config.service';

const ACME = {
  enterpriseId: 'ent-acme',
  memberId: 'mem-boss',
  role: 'ENTERPRISE_ADMIN' as const,
  departmentId: null,
};

/** 企业配置默认值，各测试按需覆盖字段 */
function makeConfig(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    enterpriseId: 'ent-acme',
    defaultChatModel: 'gemini-3.5-flash-high',
    allowedChatModels: [] as string[],
    allowUserSwitchModel: true,
    embeddingModel: 'text-embedding-3-small',
    rerankModel: null,
    embeddingBatchSize: 32,
    embeddingTimeoutMs: 30000,
    employeeModelPolicy: 'FOLLOW_TEMPLATE',
    employeeDefaultModel: null,
    plannerModel: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  };
}

describe('EnterpriseModelConfigService', () => {
  let prisma: any;
  let ctxSvc: any;
  let billing: any;
  let settings: any;
  let svc: EnterpriseModelConfigService;

  beforeEach(() => {
    prisma = {
      enterpriseModelConfig: {
        findUnique: jest.fn().mockResolvedValue(makeConfig()),
        create: jest.fn(),
        update: jest.fn(),
      },
      departmentModelPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      department: {
        findUnique: jest.fn().mockResolvedValue({ enterpriseId: 'ent-acme' }),
      },
      subscription: { findUnique: jest.fn().mockResolvedValue(null) },
      platformModel: { findMany: jest.fn().mockResolvedValue([]) },
      computeAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'acct-1' }) },
      computeTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
    };
    ctxSvc = {
      resolve: jest.fn().mockResolvedValue(ACME),
      assertEnterpriseAdmin: jest.fn(),
    };
    billing = {
      describe: jest.fn().mockResolvedValue([
        { isFree: false, billingMultiplier: '1', discountLabel: '按中转倍率计费' },
      ]),
    };
    settings = { getEffectiveValue: jest.fn().mockResolvedValue('platform-default') };
    svc = new EnterpriseModelConfigService(prisma, ctxSvc, undefined, billing, settings);
  });

  describe('get', () => {
    it('配置不存在时使用有效的平台默认模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'platform-default' }, { modelId: 'fallback-model' }]);
      prisma.enterpriseModelConfig.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(makeConfig(data)));

      const cfg = await svc.get('u1');

      expect(prisma.enterpriseModelConfig.create).toHaveBeenCalled();
      expect(cfg.defaultChatModel).toBe('platform-default');
    });

    it('平台默认不可用时选排序后的首个有效模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
      settings.getEffectiveValue.mockResolvedValue('missing-default');
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'fallback-model' }]);
      prisma.enterpriseModelConfig.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(makeConfig(data)));

      expect((await svc.get('u1')).defaultChatModel).toBe('fallback-model');
    });

    it('没有有效平台模型时拒绝创建企业配置', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
      prisma.platformModel.findMany.mockResolvedValue([]);

      await expect(svc.get('u1')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.enterpriseModelConfig.create).not.toHaveBeenCalled();
    });

    it('并发首次读取复用唯一键竞争中已创建的配置，不覆盖其策略', async () => {
      const winner = makeConfig({
        defaultChatModel: 'gpt-4o',
        allowedChatModels: ['gpt-4o'],
        allowUserSwitchModel: false,
      });
      const conflict = new Prisma.PrismaClientKnownRequestError('duplicate enterprise', {
        code: 'P2002', clientVersion: '6', meta: { target: ['enterpriseId'] },
      });
      prisma.enterpriseModelConfig.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(winner);
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'platform-default' }]);
      prisma.enterpriseModelConfig.create
        .mockResolvedValueOnce(winner)
        .mockRejectedValueOnce(conflict);

      const configs = await Promise.all([svc.get('u1'), svc.get('u2')]);

      expect(configs).toEqual([configs[0], configs[0]]);
      expect(configs[0]).toMatchObject({
        defaultChatModel: 'gpt-4o', allowedChatModels: ['gpt-4o'], allowUserSwitchModel: false,
      });
      expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenCalledTimes(3);
      expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenLastCalledWith({
        where: { enterpriseId: 'ent-acme' },
      });
      expect(prisma.enterpriseModelConfig.update).not.toHaveBeenCalled();
    });

    it('唯一键错误后仍找不到本企业配置时保留原始错误', async () => {
      const conflict = new Prisma.PrismaClientKnownRequestError('duplicate id', {
        code: 'P2002', clientVersion: '6', meta: { target: ['id'] },
      });
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'platform-default' }]);
      prisma.enterpriseModelConfig.create.mockRejectedValue(conflict);

      await expect(svc.get('u1')).rejects.toBe(conflict);
      expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenCalledTimes(2);
    });

    it('其他数据库错误不能被初始化恢复掩盖', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('enterprise missing', {
        code: 'P2003', clientVersion: '6',
      });
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(null);
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'platform-default' }]);
      prisma.enterpriseModelConfig.create.mockRejectedValue(failure);

      await expect(svc.get('u1')).rejects.toBe(failure);
      expect(prisma.enterpriseModelConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it('已有企业配置只读，不重新创建或更新', async () => {
      await svc.get('u1');

      expect(prisma.enterpriseModelConfig.create).not.toHaveBeenCalled();
      expect(prisma.enterpriseModelConfig.update).not.toHaveBeenCalled();
    });

    it('编排模型原样下发，未指定时为 null（= 跟随平台默认）', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ plannerModel: null }),
      );
      expect((await svc.get('u1')).plannerModel).toBeNull();

      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ plannerModel: 'gemini-3.6-flash' }),
      );
      expect((await svc.get('u1')).plannerModel).toBe('gemini-3.6-flash');
    });
  });

  describe('getAvailableModels', () => {
    it('返回 modelId 而非主键 —— 调用模型用的是 modelId', async () => {
      prisma.platformModel.findMany.mockResolvedValue([
        {
          modelId: 'claude-sonnet-5',
          label: 'Claude Sonnet 5',
          isFree: false,
          vendor: null,
          category: null,
          contextLength: null,
          maxOutputTokens: null,
          pricingInputPer1M: null,
          pricingOutputPer1M: null,
          supportedFeatures: null,
          description: null,
        },
      ]);

      const models = await svc.getAvailableModels('u1');

      expect(models[0].modelId).toBe('claude-sonnet-5');
      expect(models[0]).toMatchObject({
        billingMultiplier: '1',
        discountLabel: '按中转倍率计费',
        isFree: false,
      });
      // 元数据列目前大多为空，必须原样透传 null 让前端降级，不能塞 0 / ''
      expect(models[0].contextLength).toBeNull();
      expect(models[0].pricingInputPer1M).toBeNull();
    });

    it('只取 enabled 且未下架的模型', async () => {
      await svc.getAvailableModels('u1');
      expect(prisma.platformModel.findMany.mock.calls[0][0].where).toEqual({
        enabled: true,
        isStale: false,
      });
    });
  });

  describe('resolveEffectiveModel 优先级链', () => {
    it('① 用户选择在白名单内 → USER_CHOICE', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowedChatModels: ['claude-sonnet-5', 'gpt-4o'] }),
      );

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        userSelectedModel: 'claude-sonnet-5',
      });

      expect(r.chatModel).toBe('claude-sonnet-5');
      expect(r.source).toBe('USER_CHOICE');
    });

    it('用户选择**不在**白名单内 → 忽略，回落企业默认', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowedChatModels: ['gpt-4o'] }),
      );

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        userSelectedModel: 'claude-opus-5', // 白名单外
      });

      expect(r.chatModel).toBe('gemini-3.5-flash-high');
      expect(r.source).toBe('ENTERPRISE');
    });

    it('白名单为空 = 不限制，用户任选都算 USER_CHOICE', async () => {
      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        userSelectedModel: 'claude-opus-5',
      });

      expect(r.source).toBe('USER_CHOICE');
      expect(r.chatModel).toBe('claude-opus-5');
    });

    it('allowUserSwitchModel=false → 忽略用户和员工模型并强制使用企业默认', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowUserSwitchModel: false }),
      );

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        userSelectedModel: 'claude-sonnet-5',
        employeeTemplateModel: 'gpt-4o',
      });

      expect(r.source).toBe('ENTERPRISE');
      expect(r.chatModel).toBe('gemini-3.5-flash-high');
      expect(r.allowUserSwitchModel).toBe(false);
    });

    it('allowUserSwitchModel=false → 部门默认仍覆盖企业默认', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowUserSwitchModel: false }),
      );
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: 'claude-sonnet-5',
        allowedChatModels: [],
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        employeeTemplateModel: 'gpt-4o',
        departmentId: 'dept-tech',
      });

      expect(r.source).toBe('DEPARTMENT');
      expect(r.chatModel).toBe('claude-sonnet-5');
    });

    it('② FOLLOW_TEMPLATE 下走雇佣关系自带模型', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        config: { modelId: 'gpt-4o-mini' },
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        subscriptionId: 'sub-1',
      });

      expect(r.chatModel).toBe('gpt-4o-mini');
      expect(r.source).toBe('EMPLOYEE_INSTANCE');
    });

    it('FORCE_DEFAULT 下忽略雇佣关系模型，强制企业默认', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ employeeModelPolicy: 'FORCE_DEFAULT' }),
      );
      prisma.subscription.findUnique.mockResolvedValue({
        config: { modelId: 'gpt-4o-mini' },
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        subscriptionId: 'sub-1',
      });

      expect(r.chatModel).toBe('gemini-3.5-flash-high');
      expect(r.source).toBe('ENTERPRISE');
    });

    it('FORCE_DEFAULT 配置了指定模型时优先使用该模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({
          employeeModelPolicy: 'FORCE_DEFAULT',
          employeeDefaultModel: 'claude-sonnet-5',
        }),
      );

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        employeeTemplateModel: 'gpt-4o',
      });

      expect(r.chatModel).toBe('claude-sonnet-5');
      expect(r.source).toBe('ENTERPRISE');
    });

    it('FORCE_DEFAULT 不允许显式用户模型绕过统一模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({
        employeeModelPolicy: 'FORCE_DEFAULT', employeeDefaultModel: 'gpt-4o',
      }));
      const result = await svc.resolveEffectiveModel({ userId: 'u1', userSelectedModel: 'claude-sonnet-5' });
      expect(result).toMatchObject({ chatModel: 'gpt-4o', allowUserSwitchModel: false, source: 'ENTERPRISE' });
    });

    it('严格路径中部门白名单不能扩大企业范围，空交集不接受任意用户模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['gpt-4o'] }));
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null, allowedChatModels: ['claude-sonnet-5'],
      });
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', departmentId: 'dept-tech', userSelectedModel: 'claude-sonnet-5',
        restrictToAvailableModels: true,
      });
      expect(result.allowedChatModels).toEqual([]);
      expect(result.source).toBe('ENTERPRISE');
    });

    it('旧调用保留部门白名单契约，不把不相交的白名单变成 [] 不限制', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['gpt-4o'] }));
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null, allowedChatModels: ['claude-sonnet-5'],
      });
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', departmentId: 'dept-tech', userSelectedModel: 'outside-both-lists',
      });
      expect(result.allowedChatModels).toEqual(['claude-sonnet-5']);
      expect(result.source).toBe('ENTERPRISE');
      expect(prisma.platformModel.findMany).not.toHaveBeenCalled();
    });

    it('旧调用的白名单与严格可调用集合保持隔离', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['gpt-4o'] }));
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null, allowedChatModels: ['claude-sonnet-5'],
      });
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gpt-4o' }, { modelId: 'claude-sonnet-5' }]);
      const options = { userId: 'u1', departmentId: 'dept-tech', userSelectedModel: 'claude-sonnet-5' };
      const legacy = await svc.resolveEffectiveModel(options);
      const strict = await svc.resolveEffectiveModel({ ...options, restrictToAvailableModels: true });
      expect(legacy).toMatchObject({ allowedChatModels: ['claude-sonnet-5'], source: 'USER_CHOICE' });
      expect(strict).toMatchObject({ allowedChatModels: [], source: 'ENTERPRISE' });
    });

    it('网关使用已验证企业，不重新按用户选择 membership，并返回平台有效交集', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['gpt-4o', 'stale'] }));
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null, allowedChatModels: ['gpt-4o', 'outside'],
      });
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gpt-4o' }, { modelId: 'outside' }]);
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', enterpriseId: 'ent-acme', departmentId: 'dept-tech', restrictToAvailableModels: true,
      });
      expect(ctxSvc.resolve).not.toHaveBeenCalled();
      expect(result.allowedChatModels).toEqual(['gpt-4o']);
      expect(prisma.platformModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { enabled: true, isStale: false },
      }));
    });

    it('雇佣关系 config 里 modelId 不是字符串时不当成有效值', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        config: { modelId: 42 },
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        subscriptionId: 'sub-1',
      });

      expect(r.source).toBe('ENTERPRISE');
    });

    it('③ 部门策略覆盖企业默认', async () => {
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: 'gemini-3.5-flash',
        allowedChatModels: [],
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        departmentId: 'dept-tech',
      });

      expect(r.chatModel).toBe('gemini-3.5-flash');
      expect(r.source).toBe('DEPARTMENT');
    });

    it('部门白名单收窄企业白名单', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowedChatModels: ['gpt-4o', 'claude-sonnet-5'] }),
      );
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null,
        allowedChatModels: ['gpt-4o'],
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        departmentId: 'dept-tech',
      });

      expect(r.allowedChatModels).toEqual(['gpt-4o']);
    });

    it('部门白名单收窄后，原本合法的用户选择被拒', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ allowedChatModels: ['gpt-4o', 'claude-sonnet-5'] }),
      );
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: 'gpt-4o',
        allowedChatModels: ['gpt-4o'],
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        departmentId: 'dept-tech',
        userSelectedModel: 'claude-sonnet-5', // 企业允许，但部门收窄后不允许
      });

      expect(r.source).toBe('DEPARTMENT');
      expect(r.chatModel).toBe('gpt-4o');
    });

    it('部门只设白名单不设默认模型时，不算 DEPARTMENT 来源', async () => {
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: null,
        allowedChatModels: ['gpt-4o'],
      });

      const r = await svc.resolveEffectiveModel({
        userId: 'u1',
        departmentId: 'dept-tech',
      });

      expect(r.source).toBe('ENTERPRISE');
      expect(r.allowedChatModels).toEqual(['gpt-4o']);
    });

    it('知识库运行参数统一使用平台环境配置，不受企业数据库字段影响', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ embeddingModel: 'stale-model', embeddingBatchSize: 64 }),
      );

      const r = await svc.resolveEffectiveModel({ userId: 'u1' });

      expect(r.embeddingModel).toBe('bge-m3:latest');
      expect(r.embeddingBatchSize).toBe(32);
    });

    it('会话模式忽略已经下架的用户选择并回落到有效默认模型', async () => {
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gemini-3.5-flash-high' }]);
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', userSelectedModel: 'gpt-4o', requireAvailableModel: true,
      });
      expect(result).toMatchObject({
        chatModel: 'gemini-3.5-flash-high', source: 'ENTERPRISE',
        allowedChatModels: ['gemini-3.5-flash-high'],
      });
    });

    it('会话模式跳过失效的员工模板模型', async () => {
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gemini-3.5-flash-high' }]);
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', employeeTemplateModel: 'gpt-4o', requireAvailableModel: true,
      });
      expect(result).toMatchObject({ chatModel: 'gemini-3.5-flash-high', source: 'ENTERPRISE' });
    });

    it('会话模式在显式部门默认不可用时拒绝放宽策略', async () => {
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gemini-3.5-flash-high' }]);
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: 'gpt-4o', allowedChatModels: [],
      });
      await expect(svc.resolveEffectiveModel({
        userId: 'u1', departmentId: 'dept-tech', requireAvailableModel: true,
      })).rejects.toThrow(ServiceUnavailableException);
    });

    it('会话模式拒绝空的可调用白名单交集', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['gpt-4o'] }));
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gemini-3.5-flash-high' }]);
      await expect(svc.resolveEffectiveModel({
        userId: 'u1', requireAvailableModel: true,
      })).rejects.toThrow(ServiceUnavailableException);
    });

    it('部门默认在收窄白名单内时不受未使用的企业默认影响', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({
        defaultChatModel: 'enterprise-a', allowedChatModels: ['enterprise-a', 'department-b'],
      }));
      prisma.departmentModelPolicy.findUnique.mockResolvedValue({
        defaultChatModel: 'department-b', allowedChatModels: ['department-b'],
      });
      prisma.platformModel.findMany.mockResolvedValue([
        { modelId: 'enterprise-a' }, { modelId: 'department-b' },
      ]);
      const result = await svc.resolveEffectiveModel({
        userId: 'u1', departmentId: 'dept-tech', requireAvailableModel: true,
      });
      expect(result).toMatchObject({ chatModel: 'department-b', source: 'DEPARTMENT' });
    });

    it('强制员工默认失效时拒绝继续回落到旧模型', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({
        employeeModelPolicy: 'FORCE_DEFAULT', employeeDefaultModel: 'missing-model',
      }));
      prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'gemini-3.5-flash-high' }]);
      await expect(svc.resolveEffectiveModel({
        userId: 'u1', requireAvailableModel: true,
      })).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('平台级 Embedding 配置', () => {
    it('更新企业配置时忽略旧客户端提交的 embedding 运行参数', async () => {
      prisma.enterpriseModelConfig.update.mockResolvedValue(makeConfig());

      const result = await svc.update('u1', {
        embeddingModel: 'fake-model',
        embeddingBatchSize: 256,
        embeddingTimeoutMs: 120000,
        rerankModel: 'reranker',
      } as any);

      expect(prisma.enterpriseModelConfig.update.mock.calls[0][0].data).toEqual({
        rerankModel: 'reranker',
      });
      expect(result.embeddingModel).toBe('bge-m3:latest');
      expect(result.embeddingModelSource).toBe('platform');
    });
  });

  describe('编排与分析模型', () => {
    it('企业没指定时返回 null —— 由调用方落到平台默认', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ plannerModel: null }),
      );
      expect(await svc.getPlannerModel('ent-acme')).toBeNull();
    });

    it('企业指定了就用企业的', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(
        makeConfig({ plannerModel: 'gemini-3.1-pro-preview' }),
      );
      expect(await svc.getPlannerModel('ent-acme')).toBe('gemini-3.1-pro-preview');
    });

    it('未启用的模型不能设为编排模型 —— 否则工作安排会 404 而配置页看不出异常', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig());
      prisma.platformModel.findMany.mockResolvedValue([
        { modelId: 'gemini-3.5-flash', enabled: false, isStale: false },
      ]);

      await expect(
        svc.update('u1', { plannerModel: 'gemini-3.5-flash' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.enterpriseModelConfig.update).not.toHaveBeenCalled();
    });

    it('清空成空串按「跟随平台」落库 null，而不是原样存一个查不到的模型 id', async () => {
      prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig());
      prisma.enterpriseModelConfig.update.mockResolvedValue(makeConfig());

      await svc.update('u1', { plannerModel: '   ' });

      expect(prisma.enterpriseModelConfig.update.mock.calls[0][0].data).toEqual({
        plannerModel: null,
      });
    });
  });

  describe('权限与租户隔离', () => {
    it('update 要求企业管理员', async () => {
      ctxSvc.assertEnterpriseAdmin.mockImplementation(() => {
        throw new ForbiddenException('仅企业管理员可执行此操作');
      });

      await expect(svc.update('u1', { plannerModel: 'gemini-3.7-flash' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('setDepartmentPolicy 要求企业管理员', async () => {
      ctxSvc.assertEnterpriseAdmin.mockImplementation(() => {
        throw new ForbiddenException('仅企业管理员可执行此操作');
      });

      await expect(
        svc.setDepartmentPolicy('u1', 'dept-tech', { defaultChatModel: 'gpt-4o' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('操作别家企业的部门 → 404（不泄露存在性）', async () => {
      prisma.department.findUnique.mockResolvedValue({
        enterpriseId: 'ent-globex',
      });

      await expect(
        svc.setDepartmentPolicy('u1', 'dept-other', { defaultChatModel: 'gpt-4o' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.departmentModelPolicy.upsert).not.toHaveBeenCalled();
    });

    it('部门不存在 → 404', async () => {
      prisma.department.findUnique.mockResolvedValue(null);

      await expect(
        svc.getDepartmentPolicy('u1', 'nope'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDepartmentPolicy', () => {
    it('未设置策略时返回空策略而非 404，方便前端直接渲染表单', async () => {
      prisma.departmentModelPolicy.findUnique.mockResolvedValue(null);

      const p = await svc.getDepartmentPolicy('u1', 'dept-tech');

      expect(p.id).toBeNull();
      expect(p.departmentId).toBe('dept-tech');
      expect(p.defaultChatModel).toBeNull();
      expect(p.allowedChatModels).toEqual([]);
    });
  });
});
