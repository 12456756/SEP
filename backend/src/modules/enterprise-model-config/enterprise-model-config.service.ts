import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import type {
  UpdateEnterpriseModelConfigDto,
  UpdateDepartmentModelPolicyDto,
  EffectiveModelConfig,
  AvailableModel,
} from 'shared/model-config.dto';
import { ModelBillingService } from '../model/model-billing.service';
import { DEFAULT_MODEL_ID, SETTING_KEYS } from 'shared';
import { SettingService } from '../setting/setting.service';


@Injectable()
export class EnterpriseModelConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly config?: ConfigService,
    private readonly billing?: ModelBillingService,
    private readonly settings?: SettingService,
  ) {}

  private getEffectiveEmbeddingConfig() {
    const model = this.config?.get<string>('EMBEDDING_MODEL') ?? 'bge-m3:latest';
    const batchSize = Number(this.config?.get<string>('EMBEDDING_BATCH_SIZE') ?? 32);
    const timeoutMs = Number(this.config?.get<string>('EMBEDDING_TIMEOUT_MS') ?? 30000);
    return {
      embeddingModel: model,
      embeddingBatchSize: Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 32,
      embeddingTimeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
    };
  }

  private serializeConfig(config: any) {
    return {
      ...config,
      ...this.getEffectiveEmbeddingConfig(),
      embeddingModelSource: 'platform' as const,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  async get(userId: string) {
    const context = await this.ctx.resolve(userId);
    return this.getForEnterprise(context.enterpriseId);
  }

  private async getForEnterprise(enterpriseId: string) {
    let config = await this.prisma.enterpriseModelConfig.findUnique({
      where: { enterpriseId },
    });

    if (!config) {
      const defaultChatModel = await this.resolveInitialChatModel();
      config = await this.prisma.enterpriseModelConfig.create({
        data: {
          enterpriseId,
          defaultChatModel,
          allowedChatModels: [],
          allowUserSwitchModel: true,
          ...this.getEffectiveEmbeddingConfig(),
          employeeModelPolicy: 'FOLLOW_TEMPLATE',
        },
      }).catch(async (error: unknown) => {
        // Another request may have initialized this enterprise after the read.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const existing = await this.prisma.enterpriseModelConfig.findUnique({
            where: { enterpriseId },
          });
          if (existing) return existing;
        }
        throw error;
      });
    }

    return this.serializeConfig(config);
  }

  private async resolveInitialChatModel(): Promise<string> {
    const [configuredDefault, availableModels] = await Promise.all([
      this.settings?.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL),
      this.prisma.platformModel.findMany({
        where: { enabled: true, isStale: false },
        orderBy: [{ sortOrder: 'asc' }, { modelId: 'asc' }],
        select: { modelId: true },
      }),
    ]);
    const availableIds = availableModels.map((model: { modelId: string }) => model.modelId);
    if (configuredDefault && availableIds.includes(configuredDefault)) return configuredDefault;
    if (availableIds.length > 0) return availableIds[0];
    throw new ServiceUnavailableException('平台没有已启用且有效的模型，无法初始化企业模型配置');
  }

  async update(userId: string, dto: UpdateEnterpriseModelConfigDto) {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);

    await this.get(userId);
    await this.assertSelectableModels(dto);

    const updated = await this.prisma.enterpriseModelConfig.update({
      where: { enterpriseId: context.enterpriseId },
      data: {
        ...(dto.defaultChatModel !== undefined && { defaultChatModel: dto.defaultChatModel }),
        ...(dto.allowedChatModels !== undefined && { allowedChatModels: dto.allowedChatModels }),
        ...(dto.allowUserSwitchModel !== undefined && { allowUserSwitchModel: dto.allowUserSwitchModel }),
        ...(dto.rerankModel !== undefined && { rerankModel: dto.rerankModel }),
        ...(dto.employeeModelPolicy !== undefined && { employeeModelPolicy: dto.employeeModelPolicy }),
        ...(dto.employeeDefaultModel !== undefined && { employeeDefaultModel: dto.employeeDefaultModel }),
        // 空串按「跟随平台默认」处理：下拉框清空时前端传的是 ''，
        // 原样落库会得到一个查不到的模型 id，规划直接 404
        ...(dto.plannerModel !== undefined && {
          plannerModel: dto.plannerModel?.trim() ? dto.plannerModel.trim() : null,
        }),
      },
    });

    return this.serializeConfig(updated);
  }

  /**
   * 把「默认模型 / 白名单」限制在平台已启用且上游仍在的模型内。
   *
   * 不校验的代价是真实的：某企业的 defaultChatModel 曾被设成 `gemini-3.5-flash`，
   * 而中转对它的流式请求一个字节都不回 —— 该企业每次对话都停在「正在输入」，
   * 而配置页看不出任何异常。写入时挡住，比事后从日志里刨要便宜得多。
   *
   * 只校验「是不是平台启用的模型」这一层：具体能不能跑由
   * `POST /models/:id/test`（按流式测）回答，那是运营启用模型时的关卡。
   */
  private async assertSelectableModels(dto: UpdateEnterpriseModelConfigDto) {
    const wanted = [
      dto.defaultChatModel,
      dto.employeeDefaultModel,
      // 编排模型同样要校验：它现在也是企业自己选的，选到一个未启用/已下架的
      // 模型，表现是「工作安排」报 404 model_not_found，而配置页看不出异常。
      dto.plannerModel,
      ...(dto.allowedChatModels ?? []),
    ]
      .map((id) => (typeof id === 'string' ? id.trim() : id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (wanted.length === 0) return;

    const rows = await this.prisma.platformModel.findMany({
      where: { modelId: { in: [...new Set(wanted)] } },
      select: { modelId: true, enabled: true, isStale: true },
    });
    const byId = new Map(rows.map((r) => [r.modelId, r]));

    for (const id of new Set(wanted)) {
      const row = byId.get(id);
      if (!row) {
        throw new BadRequestException(
          `模型 ${id} 不在平台模型库中。请先在运营端「系统设置 → 模型管理」同步上游并启用。`,
        );
      }
      if (row.isStale) {
        throw new BadRequestException(`模型 ${id} 已从上游下架，不能再选用。`);
      }
      if (!row.enabled) {
        throw new BadRequestException(`模型 ${id} 未被平台启用，请联系平台运营。`);
      }
    }
  }

  async getAvailableModels(userId: string): Promise<AvailableModel[]> {
    await this.ctx.resolve(userId);

    const models = await this.prisma.platformModel.findMany({
      where: { enabled: true, isStale: false },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      select: {
        modelId: true,
        label: true,
        isFree: true,
        vendor: true,
        category: true,
        contextLength: true,
        maxOutputTokens: true,
        pricingInputPer1M: true,
        pricingOutputPer1M: true,
        supportedFeatures: true,
        description: true,
      },
    });

    if (!this.billing) throw new ServiceUnavailableException('模型计费服务不可用');
    const billing = await this.billing.describe(models);

    // modelId 是调用模型时的标识，不能用主键 cuid 代替。
    // 元数据列大多为空（等同步任务补齐），保持 null 让前端降级展示。
    return models.map((m, index) => ({
      modelId: m.modelId,
      label: m.label,
      displayName: m.label,
      ...billing[index],
      vendor: m.vendor,
      category: m.category,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      pricingInputPer1M: m.pricingInputPer1M?.toString() ?? null,
      pricingOutputPer1M: m.pricingOutputPer1M?.toString() ?? null,
      supportedFeatures:
        m.supportedFeatures && typeof m.supportedFeatures === 'object'
          ? (m.supportedFeatures as Record<string, unknown>)
          : null,
      description: m.description,
    }));
  }

  async resolveEffectiveModel(opts: {
    userId: string;
    /** 已验证的服务端企业身份，避免按用户第一条 membership 重新选择企业。 */
    enterpriseId?: string;
    /** 网关必须得到实际可调用集合；空交集不能解释成不限制。 */
    restrictToAvailableModels?: boolean;
    /** 对话请求要求最终模型处于当前平台和企业策略的可用交集中。 */
    requireAvailableModel?: boolean;
    userSelectedModel?: string;
    /** 雇佣关系 id。收敛前是 employeeInstanceId。 */
    subscriptionId?: string;
    /** 员工模板自带模型：订阅未单独配置时的兜底（FOLLOW_TEMPLATE 语义） */
    employeeTemplateModel?: string | null;
    departmentId?: string;
  }): Promise<EffectiveModelConfig> {
    const config = opts.enterpriseId
      ? await this.getForEnterprise(opts.enterpriseId)
      : await this.get(opts.userId);
    const canSwitch = config.allowUserSwitchModel && config.employeeModelPolicy !== 'FORCE_DEFAULT';

    // 所有分支共享的知识库/开关字段，只有 chatModel 与 allowedChatModels 会被覆盖
    const base = {
      allowedChatModels: config.allowedChatModels,
      allowUserSwitchModel: canSwitch,
      ...this.getEffectiveEmbeddingConfig(),
      rerankModel: config.rerankModel,
    };

    // 部门策略先解析：它同时影响用户可选范围（白名单收窄）
    let deptPolicy: { defaultChatModel: string | null; allowedChatModels: string[] } | null =
      null;
    if (opts.departmentId) {
      deptPolicy = await this.prisma.departmentModelPolicy.findUnique({
        where: { departmentId: opts.departmentId },
        select: { defaultChatModel: true, allowedChatModels: true },
      });
    }

    const enterpriseAllowed = config.allowedChatModels;
    const departmentAllowed = deptPolicy?.allowedChatModels ?? [];
    // 旧调用把 [] 解释为不限制；网关和对话显式要求当前可用交集。
    let allowed = departmentAllowed.length > 0 ? departmentAllowed : enterpriseAllowed;
    const restrictModels = opts.restrictToAvailableModels || opts.requireAvailableModel;
    if (restrictModels) {
      const models = await this.prisma.platformModel.findMany({
        where: { enabled: true, isStale: false },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        select: { modelId: true },
      });
      allowed = models.map((model) => model.modelId).filter((id) =>
        (enterpriseAllowed.length === 0 || enterpriseAllowed.includes(id)) &&
        (departmentAllowed.length === 0 || departmentAllowed.includes(id)),
      );
    }

    if (opts.requireAvailableModel && allowed.length === 0) {
      throw new ServiceUnavailableException('企业模型白名单与当前平台可用模型没有交集');
    }

    const assertDefaultAvailable = (modelId: string, label: string) => {
      if (opts.requireAvailableModel && !allowed.includes(modelId)) {
        throw new ServiceUnavailableException(`${label}模型当前不可用，请联系管理员调整模型策略`);
      }
    };
    const resolveAvailableSystemDefault = async (): Promise<string> => {
      const configuredDefault = await this.settings?.getEffectiveValue(SETTING_KEYS.SUB2API_DEFAULT_MODEL);
      const defaultModel = configuredDefault && allowed.includes(configuredDefault)
        ? configuredDefault
        : undefined;
      if (!defaultModel) throw new ServiceUnavailableException('平台默认模型当前不可用，请联系平台管理员调整模型配置');
      return defaultModel;
    };

    // 1. 用户显式选择（需开关允许且落在白名单内）
    if (opts.userSelectedModel && canSwitch) {
      const isAllowed = restrictModels
        ? allowed.includes(opts.userSelectedModel)
        : allowed.length === 0 || allowed.includes(opts.userSelectedModel);
      if (isAllowed) {
        return {
          ...base,
          chatModel: opts.userSelectedModel,
          allowedChatModels: allowed,
          source: 'USER_CHOICE',
        };
      }
    }

    // 管理员关闭会话模型切换时，配置页承诺强制使用默认模型。
    // 此时不能继续落到员工模板，否则界面虽已锁定，实际请求仍可能走模板里的模型。
    if (!config.allowUserSwitchModel) {
      if (deptPolicy?.defaultChatModel) {
        assertDefaultAvailable(deptPolicy.defaultChatModel, '部门默认');
        return {
          ...base,
          chatModel: deptPolicy.defaultChatModel,
          allowedChatModels: allowed,
          source: 'DEPARTMENT',
        };
      }

      if (config.defaultChatModel) assertDefaultAvailable(config.defaultChatModel, '企业默认');
      if (opts.requireAvailableModel && !config.defaultChatModel) {
        return { ...base, chatModel: await resolveAvailableSystemDefault(), allowedChatModels: allowed, source: 'SYSTEM_DEFAULT' };
      }
      return {
        ...base,
        chatModel: config.defaultChatModel || DEFAULT_MODEL_ID,
        allowedChatModels: allowed,
        source: config.defaultChatModel ? 'ENTERPRISE' : 'SYSTEM_DEFAULT',
      };
    }

    // 2. 员工自带模型（仅 FOLLOW_TEMPLATE 策略下生效）
    //    订阅 config.modelId 优先于模板 modelId：订阅是管理员对单个员工的微调。
    //    FORCE_DEFAULT 时整段跳过，使用员工策略中指定的统一模型。
    if (config.employeeModelPolicy === 'FOLLOW_TEMPLATE') {
      let modelId: string | null = null;

      if (opts.subscriptionId) {
        const subscription = await this.prisma.subscription.findUnique({
          where: { id: opts.subscriptionId, enterpriseId: config.enterpriseId },
          select: { config: true },
        });
        const raw = subscription?.config as { modelId?: unknown } | null;
        if (typeof raw?.modelId === 'string') modelId = raw.modelId;
      }

      if (!modelId && opts.employeeTemplateModel) {
        modelId = opts.employeeTemplateModel;
      }

      if (modelId && (!restrictModels || allowed.includes(modelId))) {
        return {
          ...base,
          chatModel: modelId,
          allowedChatModels: allowed,
          source: 'EMPLOYEE_INSTANCE',
        };
      }
    }

    if (config.employeeModelPolicy === 'FORCE_DEFAULT' && config.employeeDefaultModel) {
      assertDefaultAvailable(config.employeeDefaultModel, '企业强制员工');
      return {
        ...base,
        chatModel: config.employeeDefaultModel,
        allowedChatModels: allowed,
        source: 'ENTERPRISE',
      };
    }

    // 3. 部门默认模型
    if (deptPolicy?.defaultChatModel) {
      assertDefaultAvailable(deptPolicy.defaultChatModel, '部门默认');
      return {
        ...base,
        chatModel: deptPolicy.defaultChatModel,
        allowedChatModels: allowed,
        source: 'DEPARTMENT',
      };
    }

    // 4. 企业默认模型
    if (config.defaultChatModel) {
      assertDefaultAvailable(config.defaultChatModel, '企业默认');
      return {
        ...base,
        chatModel: config.defaultChatModel,
        allowedChatModels: allowed,
        source: 'ENTERPRISE',
      };
    }

    // 5. 系统兜底
    if (opts.requireAvailableModel) {
      const defaultModel = await resolveAvailableSystemDefault();
      return { ...base, chatModel: defaultModel, allowedChatModels: allowed, source: 'SYSTEM_DEFAULT' };
    }
    return {
      ...base,
      chatModel: DEFAULT_MODEL_ID,
      allowedChatModels: allowed,
      source: 'SYSTEM_DEFAULT',
    };
  }

  /** 读取部门模型策略；未设置时返回空策略而非 404，方便前端直接渲染表单。 */
  async getDepartmentPolicy(userId: string, departmentId: string) {
    const context = await this.ctx.resolve(userId);
    await this.assertDepartmentInEnterprise(departmentId, context.enterpriseId);

    const policy = await this.prisma.departmentModelPolicy.findUnique({
      where: { departmentId },
    });

    if (!policy) {
      return {
        id: null,
        departmentId,
        defaultChatModel: null,
        allowedChatModels: [] as string[],
        createdAt: null,
        updatedAt: null,
      };
    }

    return {
      ...policy,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  /** 设置部门模型策略（仅企业管理员）。defaultChatModel=null 表示回退到企业配置。 */
  async setDepartmentPolicy(
    userId: string,
    departmentId: string,
    dto: UpdateDepartmentModelPolicyDto,
  ) {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);
    await this.assertDepartmentInEnterprise(departmentId, context.enterpriseId);

    const policy = await this.prisma.departmentModelPolicy.upsert({
      where: { departmentId },
      create: {
        departmentId,
        defaultChatModel: dto.defaultChatModel ?? null,
        allowedChatModels: dto.allowedChatModels ?? [],
      },
      update: {
        ...(dto.defaultChatModel !== undefined && {
          defaultChatModel: dto.defaultChatModel,
        }),
        ...(dto.allowedChatModels !== undefined && {
          allowedChatModels: dto.allowedChatModels,
        }),
      },
    });

    return {
      ...policy,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  /**
   * 编排与分析模型：工作安排的任务规划、迭代建议、交付物生成共用这一个。
   *
   * 解析顺序 **企业 → 平台**，与会话那条链的形状一致：
   *   企业 plannerModel → 平台系统设置 SUB2API_DEFAULT_MODEL → 代码常量
   *
   * 为什么单独一层而不是复用 defaultChatModel：这三件事都要把大段上下文
   * （员工能力目录、执行记录）塞进 prompt 并输出严格 JSON，而用户感知不到延迟；
   * 会话要的恰好相反。两者共用一个值等于强迫双方妥协。
   *
   * 落到平台那一档由调用方处理（它们已持有 SettingService），这里只回答
   * 「这家企业有没有自己指定过」——返回 null 表示跟随平台。
   */
  async getPlannerModel(enterpriseId: string): Promise<string | null> {
    const config = await this.prisma.enterpriseModelConfig.findUnique({
      where: { enterpriseId },
      select: { plannerModel: true },
    });
    return config?.plannerModel ?? null;
  }

  /** 防止跨企业越权操作别人的部门。 */
  private async assertDepartmentInEnterprise(departmentId: string, enterpriseId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { enterpriseId: true },
    });

    if (!dept || dept.enterpriseId !== enterpriseId) {
      throw new NotFoundException(`部门 ${departmentId} 不存在`);
    }
  }

}
