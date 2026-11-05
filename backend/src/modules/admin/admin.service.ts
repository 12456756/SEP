import { Injectable, NotFoundException, BadRequestException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TransactionType } from '@prisma/client';
import { AVATAR_SOURCES, SELECTABLE_AVATAR_STYLES, FOLLOW_DEFAULT_STYLE_ID, SILICON_3D_STYLE, builtinAvatarStyle, canonicalAvatarStyleId, libraryAvatarBinding } from '../../shared/dicebear-styles';
import { DEFAULT_AVATAR_STYLE_ID, employeeEffectiveStyle, resolveAvatarForStyle, resolveAvatarBindingForStyle, preservedAvatarBindings, isAvatarImageUrl } from '../../common/avatar-style';
import { employeeAssetBaseUrl, withEmployeeAvatar } from '../../common/employee-avatar';
import { SettingService } from '../setting/setting.service';
import { PersonalWalletService, assertActiveRewardRecipientInTx } from '../personal-wallet/personal-wallet.service';
import { Decimal } from '@prisma/client/runtime/library';
import { EmployeeReadinessService } from '../digital-employee/employee-readiness.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    @Optional() private readonly setting?: SettingService,
    @Optional() private readonly personalWallet?: PersonalWalletService,
    @Optional() private readonly readiness?: EmployeeReadinessService,
  ) {}

  private employeeReadiness(): EmployeeReadinessService {
    if (!this.readiness) throw new ServiceUnavailableException('员工可安装性检查服务不可用');
    return this.readiness;
  }

  private async contributionRewardAmount(kind: 'enterprise' | 'platform') {
    const key = kind === 'enterprise' ? 'CONTRIBUTION_ENTERPRISE_REWARD_CNY' : 'CONTRIBUTION_PLATFORM_REWARD_CNY';
    const value = Number(await this.setting?.getEffectiveValue(key as any));
    return new Decimal(Number.isFinite(value) && value > 0 ? value : kind === 'enterprise' ? 10 : 50);
  }

  /**
   * 获取企业详情（运营端视角）
   */
  async getEnterpriseDetail(enterpriseId: string) {
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                role: true,
              }
            },
            department: {
              select: {
                id: true,
                name: true,
              }
            }
          },
        },
        subscriptions: {
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                description: true,
              }
            },
          },
        },
        wallet: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        },
        departments: {
          select: {
            id: true,
            name: true,
            parentId: true,
          }
        }
      },
    });

    if (!enterprise) {
      throw new NotFoundException('企业不存在');
    }

    // 余额与流水统一读钱包（EnterpriseWallet / WalletTransaction）。
    // 原先这里 include 的是 ComputeAccount + ComputeTransaction —— 前者是
    // schema 里标注废弃的字段，后者只剩 gateway 链路在写，运营端看到的
    // 余额和流水都对不上企业自己看到的数。
    const { wallet, ...rest } = enterprise;
    return {
      ...rest,
      balance: Number(wallet?.balance ?? 0),
      computeReservedCNY: Number(wallet?.computeReservedCNY ?? 0),
      transactions: (wallet?.transactions ?? []).map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: Number(tx.amount),
        balanceAfter: Number(tx.balanceAfter),
        description: tx.description,
        metadata: tx.metadata,
        createdAt: tx.createdAt,
      })),
    };
  }

  /**
   * 充值/扣减算力
   */
  async creditAdjustment(params: {
    enterpriseId: string;
    amount: number;
    type: 'RECHARGE' | 'DEDUCT';
    note: string;
    operatorId: string;
  }) {
    const { enterpriseId, amount, type, note, operatorId } = params;

    if (amount <= 0) {
      throw new BadRequestException('金额必须大于0');
    }

    // 确保企业存在
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
    });

    if (!enterprise) {
      throw new NotFoundException('企业不存在');
    }

    // 使用新的钱包系统
    let newBalance: number;

    if (type === 'RECHARGE') {
      // 充值
      const result = await this.walletService.adminDeposit(
        enterpriseId,
        amount,
        note,
        operatorId,
      );
      newBalance = result.balance;
    } else {
      // 扣减
      const result = await this.walletService.adminDeduct(
        enterpriseId,
        amount,
        note,
        operatorId,
      );
      newBalance = result.balance;
    }

    return {
      success: true,
      newBalance,
    };
  }

  /**
   * 冻结企业
   */
  async suspendEnterprise(enterpriseId: string, reason: string, operatorId: string) {
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
    });

    if (!enterprise) {
      throw new NotFoundException('企业不存在');
    }

    // 检查是否已经被冻结
    const metadata = enterprise.metadata as any;
    if (metadata?.suspended === true) {
      throw new BadRequestException('企业已被冻结');
    }

    await this.prisma.enterprise.update({
      where: { id: enterpriseId },
      data: {
        metadata: {
          ...(metadata || {}),
          suspended: true,
          suspendReason: reason,
          suspendedAt: new Date().toISOString(),
          suspendedBy: operatorId,
        },
      },
    });

    return { success: true };
  }

  /**
   * 解冻企业
   */
  async resumeEnterprise(enterpriseId: string, operatorId: string) {
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: enterpriseId },
    });

    if (!enterprise) {
      throw new NotFoundException('企业不存在');
    }

    // 检查是否被冻结
    const metadata = enterprise.metadata as any;
    if (metadata?.suspended !== true) {
      throw new BadRequestException('企业未被冻结');
    }

    await this.prisma.enterprise.update({
      where: { id: enterpriseId },
      data: {
        metadata: {
          ...(metadata || {}),
          suspended: false,
          resumedAt: new Date().toISOString(),
          resumedBy: operatorId,
        },
      },
    });

    return { success: true };
  }

  /**
   * 获取所有企业列表（运营端）
   */
  async listEnterprises(params?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    suspended?: boolean;
  }) {
    const { page = 1, pageSize = 20, keyword, suspended } = params || {};
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (keyword?.trim()) where.OR = [
      { name: { contains: keyword.trim(), mode: 'insensitive' as const } },
      { description: { contains: keyword.trim(), mode: 'insensitive' as const } },
    ];
    if (suspended !== undefined) where.metadata = { path: ['suspended'], equals: suspended };

    const [enterprises, total] = await Promise.all([
      this.prisma.enterprise.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          // 余额读钱包，不读 ComputeAccount.balance —— 后者已停止写入，
          // 继续读它会让运营端看到一个永远不变的假余额。
          wallet: {
            select: { balance: true },
          },
          _count: {
            select: {
              members: true,
              subscriptions: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.enterprise.count({ where }),
    ]);

    return {
      data: enterprises.map((e) => ({
        ...e,
        balance: Number(e.wallet?.balance ?? 0),
        memberCount: e._count.members,
        subscriptionCount: e._count.subscriptions,
        suspended: (e.metadata as any)?.suspended === true,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 获取平台级算力交易记录
   */
  /**
   * 平台级资金流水。数据源是 WalletTransaction（唯一主账本），
   * 不再是 ComputeTransaction —— 后者已停止写入。
   *
   * 对外的 type 参数保持 RECHARGE / CONSUME / REFUND 不变，内部映射到钱包类型，
   * 这样运营端筛选器不用跟着改。金额单位是元。
   */
  async getComputeTransactions(params: {
    type?: 'RECHARGE' | 'CONSUME' | 'REFUND';
    enterpriseId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const {
      type,
      enterpriseId,
      startDate,
      endDate,
      page = 1,
      pageSize = 20,
    } = params;

    const typeMap = {
      RECHARGE: 'DEPOSIT',
      CONSUME: 'CONSUME',
      REFUND: 'REFUND',
    } as const;

    const where: Prisma.WalletTransactionWhereInput = {
      ...(type && { type: typeMap[type] }),
      ...(enterpriseId && { wallet: { enterpriseId } }),
    };

    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      };
    }

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        include: {
          wallet: {
            select: {
              enterprise: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    const reverseTypeMap: Record<string, 'RECHARGE' | 'CONSUME' | 'REFUND'> = {
      DEPOSIT: 'RECHARGE',
      CONSUME: 'CONSUME',
      REFUND: 'REFUND',
      ADJUSTMENT: 'RECHARGE',
    };

    return {
      data: transactions.map((t) => ({
        id: t.id,
        type: reverseTypeMap[t.type] ?? t.type,
        amount: Number(t.amount),
        balanceAfter: Number(t.balanceAfter),
        description: t.description,
        metadata: t.metadata,
        createdAt: t.createdAt,
        // 算力消费的 relatedId 就是会话 ID（见 WalletService.consumeComputeUpTo）
        sessionId: t.relatedType === 'compute' ? t.relatedId : null,
        enterprise: t.wallet.enterprise,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 平台资金合计。
   *
   * 原先这三个数是前端算的：拉 `pageSize=9999` 的全量流水到浏览器再 reduce。
   * 两个问题 —— 一是每次进页面都搬一遍整本账，二是超过 9999 条之后累计充值/消费
   * 会静默算错（只累加最新的 9999 条）。搬到后端用 groupBy 一次算完。
   *
   * 余额读 EnterpriseWallet，不读已废弃的 ComputeAccount.balance。
   */
  async getComputeSummary() {
    const [byType, walletTotals] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['type'],
        _sum: { amount: true },
      }),
      this.prisma.enterpriseWallet.aggregate({
        _sum: { balance: true, computeReservedCNY: true },
      }),
    ]);

    const sumOf = (...types: string[]) =>
      byType
        .filter((row) => types.includes(row.type))
        .reduce((acc, row) => acc + Number(row._sum.amount ?? 0), 0);

    // ADJUSTMENT 归入充值口径，与流水列表的 reverseTypeMap 保持一致
    const totalRecharge = sumOf('DEPOSIT', 'ADJUSTMENT');
    const totalConsume = Math.abs(sumOf('CONSUME'));
    const totalRefund = Math.abs(sumOf('REFUND'));

    return {
      totalRecharge: +totalRecharge.toFixed(2),
      totalConsume: +totalConsume.toFixed(2),
      totalRefund: +totalRefund.toFixed(2),
      totalBalance: +Number(walletTotals._sum.balance ?? 0).toFixed(2),
      totalComputeReserved: +Number(walletTotals._sum.computeReservedCNY ?? 0).toFixed(2),
    };
  }

  /**
   * 获取员工列表（运营端）
   */
  async listEmployees(params?: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT' | 'ARCHIVED';
    page?: number;
    pageSize?: number;
    keyword?: string;
    industry?: string;
    position?: string;
    capabilityKeyword?: string;
    sortBy?: 'createdAt' | 'name' | 'annualPriceCNY';
    sortOrder?: 'asc' | 'desc';
  }) {
    const { status, page = 1, pageSize = 20, keyword, industry, position, capabilityKeyword, sortBy = 'createdAt', sortOrder = 'desc' } = params || {};
    const skip = (page - 1) * pageSize;

    const where: any = { ...(status ? { status } : {}) };
    const filters: any[] = [];
    if (keyword?.trim()) filters.push({ name: { contains: keyword.trim(), mode: 'insensitive' } });
    if (industry?.trim()) filters.push({ industry: { contains: industry.trim(), mode: 'insensitive' } });
    if (position?.trim()) filters.push({ position: { contains: position.trim(), mode: 'insensitive' } });
    if (capabilityKeyword?.trim()) filters.push({ bindings: { some: { capability: { name: { contains: capabilityKeyword.trim(), mode: 'insensitive' } } } } });
    if (filters.length) where.AND = filters;

    const [employees, total] = await Promise.all([
      this.prisma.digitalEmployee.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          bindings: {
            include: {
              capability: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  status: true,
                },
              },
            },
          },
          _count: {
            select: {
              bindings: true,
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.digitalEmployee.count({ where }),
    ]);

    return {
      data: employees,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 审核通过员工模板
   */
  async approveEmployee(employeeId: string, operatorId: string, note?: string) {
    const readiness = this.employeeReadiness();
    return readiness.withEmployeeLock(employeeId, async (tx, employee) => {
      if (employee.status !== 'PENDING') throw new BadRequestException('只能审核待审核状态的员工');
      await readiness.assertReady(employeeId, tx);
      await tx.digitalEmployee.update({
        where: { id: employeeId },
        data: { status: 'APPROVED', publishedAt: new Date() },
      });
      return { success: true };
    });
  }

  /**
   * 拒绝员工模板
   */
  async rejectEmployee(employeeId: string, operatorId: string, reason: string) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('员工模板不存在');
    }
    if (employee.status !== 'PENDING') {
      throw new BadRequestException('只能审核待审核状态的员工');
    }

    await this.prisma.digitalEmployee.update({
      where: { id: employeeId },
      data: {
        status: 'REJECTED',
      },
    });

    return { success: true };
  }

  /**
   * 创建员工（运营）
   */
  async createEmployee(data: {
    name: string;
    description?: string;
    industry?: string;
    position?: string;
    avatar?: string;
    systemPrompt?: string;
    modelId?: string;
    maxSteps?: number;
    price?: number;
    annualPriceCNY?: number;
    includedComputeCNY?: number | null;
    operatorId: string;
  }) {
    const employee = await this.prisma.digitalEmployee.create({
      data: {
        name: data.name,
        description: data.description || '',
        industry: data.industry || '通用',
        position: data.position || '通用',
        avatar: data.avatar,
        ...(data.avatar !== undefined ? { avatarStyle: 'custom', avatarCustomUrl: data.avatar } : {}),
        systemPrompt: data.systemPrompt || '你是一位专业的数字员工，随时准备协助用户完成各项任务。',
        modelId: data.modelId || 'gpt-4o',
        maxSteps: data.maxSteps || 10,
        price: data.price,
        annualPriceCNY: data.annualPriceCNY,
        // null/undefined 都落成 NULL = 「未配置，订阅时取系统默认赠送金额」。
        // 不要 `|| 0`：那会把「未配置」变成运营明确的「不赠送」。
        includedComputeCNY: data.includedComputeCNY ?? undefined,
        status: 'DRAFT',
        version: '1.0.0',
      },
    });

    return employee;
  }

  /**
   * 更新员工
   */
  async updateEmployee(
    employeeId: string,
    data: {
      name?: string;
      description?: string;
      industry?: string;
      position?: string;
      avatar?: string;
      systemPrompt?: string;
      modelId?: string;
      maxSteps?: number;
      price?: number;
      annualPriceCNY?: number;
      includedComputeCNY?: number | null;
    },
    operatorId: string,
  ) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('员工不存在');
    }

    return this.prisma.digitalEmployee.update({
      where: { id: employeeId },
      data: {
        name: data.name,
        description: data.description,
        industry: data.industry,
        position: data.position,
        avatar: data.avatar === withEmployeeAvatar(employee).avatar ? employee.avatar : data.avatar,
        ...(data.avatar !== undefined && data.avatar !== employee.avatar && data.avatar !== withEmployeeAvatar(employee).avatar
          ? { avatarStyle: 'custom', avatarCustomUrl: data.avatar, avatarBindings: preservedAvatarBindings(employee) } : {}),
        systemPrompt: data.systemPrompt,
        modelId: data.modelId,
        maxSteps: data.maxSteps,
        price: data.price,
        annualPriceCNY: data.annualPriceCNY,
        // 显式传 null 表示「清除员工级覆盖，回落系统默认值」；
        // 省略字段（undefined）表示不改动。这两者必须区分开。
        includedComputeCNY: data.includedComputeCNY,
      },
    });
  }

  /**
   * 发布员工（运营直接发布，跳过审核）
   */
  async publishEmployee(employeeId: string, operatorId: string) {
    const readiness = this.employeeReadiness();
    return readiness.withEmployeeLock(employeeId, async (tx, employee) => {
      if (employee.status !== 'DRAFT') throw new BadRequestException('只能发布草稿状态的员工');
      await readiness.assertReady(employeeId, tx);
      return tx.digitalEmployee.update({
        where: { id: employeeId },
        data: { status: 'APPROVED', publishedAt: new Date() },
      });
    });
  }

  /**
   * 下架员工
   */
  async archiveEmployee(employeeId: string, operatorId: string) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('员工不存在');
    }
    if (employee.status !== 'APPROVED') {
      throw new BadRequestException('只能下架已发布的员工');
    }

    return this.prisma.digitalEmployee.update({
      where: { id: employeeId },
      data: {
        status: 'ARCHIVED',
      },
    });
  }

  /**
   * 删除员工（仅草稿可删除）
   */
  async deleteEmployee(employeeId: string) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException('员工不存在');
    }
    if (employee.status !== 'DRAFT') {
      throw new BadRequestException('只能删除草稿状态的员工');
    }

    await this.prisma.digitalEmployee.delete({
      where: { id: employeeId },
    });

    return { success: true };
  }

  /**
   * 获取员工详情（运营端）
   */
  async getEmployeeDetail(employeeId: string) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
      include: {
        bindings: {
          include: {
            capability: {
              select: {
                id: true,
                name: true,
                type: true,
                status: true,
              },
            },
          },
        },
        _count: {
          select: {
            subscriptions: true,
            sessions: true,
          },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException('员工不存在');
    }

    return employee;
  }

  /**
   * 获取员工的能力绑定列表
   */
  async getEmployeeBindings(employeeId: string) {
    return this.prisma.employeeCapabilityBinding.findMany({
      where: { employeeId },
      include: {
        capability: {
          select: {
            id: true,
            name: true,
            type: true,
            description: true,
            status: true,
          },
        },
      },
      orderBy: { priority: 'desc' },
    });
  }

  /**
   * 批量绑定能力到员工
   */
  async bindCapabilities(employeeId: string, capabilityIds: string[], operatorId: string) {
    const readiness = this.employeeReadiness();
    return readiness.withEmployeeLock(employeeId, async (tx, employee) => {
      const capabilities = await tx.capability.findMany({
        where: { id: { in: capabilityIds } },
      });
      if (capabilities.length !== capabilityIds.length) {
        throw new BadRequestException('部分能力不存在');
      }
      if (capabilities.some((capability) => capability.status !== 'APPROVED')) {
        throw new BadRequestException('只能绑定已发布的能力');
      }

      const approvedSkillVersions = await tx.skillVersion.findMany({
        where: {
          capabilityId: { in: capabilityIds },
          scope: 'PLATFORM',
          status: 'PLATFORM_APPROVED',
        },
        select: { id: true, capabilityId: true },
        orderBy: [
          { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' }, { id: 'desc' },
        ],
      });
      const defaultVersions = new Map<string, string>();
      for (const version of approvedSkillVersions) {
        if (!defaultVersions.has(version.capabilityId)) {
          defaultVersions.set(version.capabilityId, version.id);
        }
      }

      await tx.employeeCapabilityBinding.deleteMany({ where: { employeeId } });

      const bindings = capabilityIds.map((capabilityId, index) => ({
        employeeId,
        capabilityId,
        priority: capabilityIds.length - index,
        enabled: true,
        defaultSkillVersionId: defaultVersions.get(capabilityId),
      }));

      await tx.employeeCapabilityBinding.createMany({ data: bindings });

      if (employee.status === 'APPROVED') await readiness.assertReady(employeeId, tx);
      return { success: true, count: bindings.length };
    });
  }

  /**
   * 更新单个绑定的配置
   */
  async updateBinding(bindingId: string, data: {
    priority?: number;
    enabled?: boolean;
    config?: any;
  }) {
    const binding = await this.prisma.employeeCapabilityBinding.findUnique({ where: { id: bindingId } });
    if (!binding) throw new NotFoundException('能力绑定不存在');
    const readiness = this.employeeReadiness();
    return readiness.withEmployeeLock(binding.employeeId, async (tx, employee) => {
      if (data.enabled === true) {
        const capability = await tx.capability.findUnique({
          where: { id: binding.capabilityId },
          select: { status: true },
        });
        if (capability?.status !== 'APPROVED') {
          throw new BadRequestException('已下架或未发布的能力不能重新启用');
        }
      }
      const updated = await tx.employeeCapabilityBinding.update({ where: { id: bindingId }, data });
      if (employee.status === 'APPROVED') await readiness.assertReady(employee.id, tx);
      return updated;
    });
  }

  /**
   * 删除绑定
   */
  async removeBinding(bindingId: string) {
    const binding = await this.prisma.employeeCapabilityBinding.findUnique({ where: { id: bindingId } });
    if (!binding) throw new NotFoundException('能力绑定不存在');
    const readiness = this.employeeReadiness();
    return readiness.withEmployeeLock(binding.employeeId, async (tx, employee) => {
      await tx.employeeCapabilityBinding.delete({ where: { id: bindingId } });
      if (employee.status === 'APPROVED') await readiness.assertReady(employee.id, tx);
      return { success: true };
    });
  }

  /**
   * 创建能力（运营）
   */
  async createCapability(data: {
    name: string;
    description: string;
    type: 'AGENT' | 'RPA' | 'SKILL' | 'AI_APP';
    industry: string[];
    position: string[];
    inputSchema: any;
    outputSchema: any;
    agentConfig?: {
      platform: 'COZE' | 'DIFY' | 'N8N' | 'OPENCODE';
      region?: string;
      runtimeKind?: string;
      botId?: string;
      workflowId?: string;
      apiKey?: string;
      workflowUrl?: string;
      webUrl?: string;
      skillName?: string;
    };
    // SKILL 类型专用字段
    zipPath?: string;
    sha256?: string;
    fileCount?: number;
    totalSize?: number;
    operatorId: string;
  }) {
    // 构建 metadata（用于存储 SKILL 类型的文件信息）
    const metadata: any = {};
    if (data.type === 'SKILL' && data.zipPath) {
      metadata.zipPath = data.zipPath;
      metadata.sha256 = data.sha256;
      metadata.fileCount = data.fileCount;
      metadata.totalSize = data.totalSize;
    }

    // 如果是 AGENT 类型且提供了 agentConfig，创建关联的 AgentConfig
    const capability = await this.prisma.capability.create({
      data: {
        name: data.name,
        description: data.description,
        type: data.type,
        industry: data.industry,
        position: data.position,
        inputSchema: data.inputSchema,
        outputSchema: data.outputSchema,
        status: 'PENDING', // 初始为待审核
        contributorId: data.operatorId, // 运营人员作为贡献者
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        ...(data.type === 'AGENT' && data.agentConfig && {
          agentConfig: {
            create: {
              platform: data.agentConfig.platform,
              region: data.agentConfig.region,
              runtimeKind: data.agentConfig.runtimeKind,
              botId: data.agentConfig.botId,
              workflowId: data.agentConfig.workflowId,
              apiKey: data.agentConfig.apiKey,
              workflowUrl: data.agentConfig.workflowUrl,
              webUrl: data.agentConfig.webUrl,
              skillName: data.agentConfig.skillName,
            },
          },
        }),
      },
      include: {
        agentConfig: true,
      },
    });

    return capability;
  }

  /**
   * 获取能力列表（运营端）
   */
  async listCapabilities(params?: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
    type?: 'AGENT' | 'RPA' | 'SKILL' | 'AI_APP';
    page?: number;
    pageSize?: number;
    keyword?: string;
    sortBy?: 'createdAt' | 'name' | 'usageCount';
    sortOrder?: 'asc' | 'desc';
  }) {
    const { status, type, page = 1, pageSize = 20, keyword, sortBy = 'createdAt', sortOrder = 'desc' } = params || {};
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (status) {
      if (status === 'PENDING') {
        // 贡献中心的企业私有草稿也保留 status=PENDING，但不能进入平台审核队列。
        // 只有已获企业管理员授权的投稿（PENDING_REVIEW）或历史无企业能力可见。
        where.OR = [
          { enterpriseId: null, status: 'PENDING' },
          { platformReviewStatus: 'PENDING_REVIEW' },
        ];
      } else if (status === 'APPROVED') {
        where.OR = [
          { visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED', status: 'APPROVED' },
          { enterpriseId: null, status: 'APPROVED' },
        ];
      } else if (status === 'ARCHIVED') {
        where.status = 'ARCHIVED';
      } else {
        where.status = status;
      }
    }
    if (type) where.type = type;
    const normalizedKeyword = keyword?.trim();
    if (normalizedKeyword) {
      const keywordOr = [
        { name: { contains: normalizedKeyword, mode: 'insensitive' as const } },
        { description: { contains: normalizedKeyword, mode: 'insensitive' as const } },
        { enterprise: { name: { contains: normalizedKeyword, mode: 'insensitive' as const } } },
      ];
      const existingOr = where.OR;
      if (existingOr) {
        where.AND = [{ OR: existingOr }, { OR: keywordOr }];
        delete where.OR;
      } else {
        where.OR = keywordOr;
      }
    }

    const [items, total] = await Promise.all([
      this.prisma.capability.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          contributor: {
            select: { id: true, email: true, name: true },
          },
          // 「来源」列要区分平台自有能力和企业投稿，只有 enterpriseId 不够，
          // 还得显示企业名 —— 否则运营看到的是一串 cuid。
          enterprise: {
            select: { id: true, name: true },
          },
          // 能力审核通过后到底有没有用上，看的是它被哪几位硅基员工带着 ——
          // 平台没有能力市场页面，「已收录」的真实去处就是绑定到员工。
          // 已通过但 0 绑定 = 审了但没人用，这是运营需要看见的信号。
          _count: { select: { bindings: { where: { enabled: true } } } },
          bindings: {
            where: { enabled: true },
            take: 6,
            orderBy: { createdAt: 'asc' },
            select: { employee: { select: { id: true, name: true } } },
          },
          skillVersions: {
            where: { scope: 'PLATFORM', status: 'PLATFORM_APPROVED' },
            orderBy: [
              { platformReviewedAt: { sort: 'desc', nulls: 'last' } },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            take: 1,
            select: { id: true, version: true, platformReviewedAt: true },
          },
        },
      }),
      this.prisma.capability.count({ where }),
    ]);

    const skillCapabilityIds = items
      .filter((capability) => capability.type === 'SKILL')
      .map((capability) => capability.id);
    const pendingSkillVersions = skillCapabilityIds.length
      ? await this.prisma.skillVersion.findMany({
        where: {
          capabilityId: { in: skillCapabilityIds },
          scope: 'PLATFORM',
          status: 'PENDING_PLATFORM_REVIEW',
        },
        orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, capabilityId: true, version: true, updatedAt: true },
      })
      : [];
    const pendingSkillVersionByCapability = new Map();
    for (const version of pendingSkillVersions) {
      if (!pendingSkillVersionByCapability.has(version.capabilityId)) {
        pendingSkillVersionByCapability.set(version.capabilityId, version);
      }
    }

    return {
      items: items.map(({ skillVersions, ...capability }) => ({
        ...capability,
        currentPlatformVersion: capability.type === 'SKILL' ? skillVersions[0] ?? null : null,
        pendingPlatformVersion: capability.type === 'SKILL'
          ? pendingSkillVersionByCapability.get(capability.id) ?? null
          : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 获取能力详情（运营端）
   */
  async getCapabilityDetail(capabilityId: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      include: {
        contributor: {
          select: { id: true, email: true, name: true },
        },
        bindings: {
          include: {
            employee: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    if (!capability) throw new NotFoundException('能力不存在');
    return capability;
  }

  /**
   * 更新能力
   */
  async updateCapability(
    capabilityId: string,
    data: {
      name?: string;
      description?: string;
      type?: 'AGENT' | 'RPA' | 'SKILL' | 'AI_APP';
      industry?: string[];
      position?: string[];
      inputSchema?: any;
      outputSchema?: any;
    },
    operatorId: string,
  ) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });

    if (!capability) throw new NotFoundException('能力不存在');

    return this.prisma.capability.update({
      where: { id: capabilityId },
      data: {
        name: data.name,
        description: data.description,
        type: data.type,
        industry: data.industry,
        position: data.position,
        inputSchema: data.inputSchema,
        outputSchema: data.outputSchema,
      },
    });
  }

  /**
   * 提交能力审核
   */
  async submitCapabilityForReview(capabilityId: string, operatorId: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });

    if (!capability) throw new NotFoundException('能力不存在');
    if (capability.status === 'APPROVED') {
      throw new BadRequestException('已审核通过的能力无需重新提交');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.capability.update({
        where: { id: capabilityId },
        data: { status: 'PENDING' },
      });
      if (capability.type === 'SKILL') {
        await tx.skillVersion.updateMany({
          where: {
            capabilityId,
            scope: 'PLATFORM',
            status: { in: ['DRAFT', 'PLATFORM_REJECTED'] },
          },
          data: {
            status: 'PENDING_PLATFORM_REVIEW',
            submittedAt: new Date(),
            rejectionReason: null,
          },
        });
      }
      return updated;
    });
  }

  /**
   * 审核通过能力
   */
  async approveCapability(capabilityId: string, operatorId: string, note?: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });

    if (!capability) throw new NotFoundException('能力不存在');
    if (capability.type === 'SKILL') {
      throw new BadRequestException('技能不能使用通用能力审核，请前往技能监控选择精确版本并发布为平台版本');
    }
    if (capability.status !== 'PENDING') {
      throw new BadRequestException('只能审核待审核状态的能力');
    }

    return this.prisma.$transaction(async (tx) => {
      const reviewedAt = new Date();
      const isContributionSubmission = capability.platformReviewStatus === 'PENDING_REVIEW';
      const updated = await tx.capability.update({
        where: { id: capabilityId },
        data: {
          status: 'APPROVED',
          approvedAt: reviewedAt,
          ...(isContributionSubmission && {
            platformReviewStatus: 'APPROVED',
            visibility: 'MARKET_PUBLIC',
            platformRejectionReason: null,
          }),
        },
      });
      if (isContributionSubmission && await this.setting?.getEffectiveValue('CONTRIBUTION_REWARDS_ENABLED') === 'true') {
        const dedupeKey = `platform-approved:${capability.id}`;
        const existingReward = await tx.contributionRewardEvent.findUnique({ where: { dedupeKey }, select: { id: true } });
        if (!existingReward) {
          const amount = await this.contributionRewardAmount('platform');
          await assertActiveRewardRecipientInTx(tx, capability.contributorId);
          const event = await tx.contributionRewardEvent.create({ data: { recipientId: capability.contributorId, enterpriseId: capability.enterpriseId, capabilityId: capability.id, eventType: 'PLATFORM_APPROVED', points: 50, amount, status: 'AVAILABLE', settledAt: reviewedAt, dedupeKey, metadata: { reviewerId: operatorId, amountCNY: amount.toString() } } });
          await this.personalWallet?.creditContributionRewardInTx(tx, capability.contributorId, amount, event.id, `平台审核通过奖励 ¥${amount.toFixed(2)}`);
        }
      }
      return updated;
    });
  }

  /**
   * 拒绝能力
   */
  async rejectCapability(capabilityId: string, operatorId: string, reason: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
    });

    if (!capability) throw new NotFoundException('能力不存在');
    if (capability.type === 'SKILL') {
      throw new BadRequestException('技能不能使用通用能力审核，请前往技能监控选择精确版本处理');
    }
    if (capability.status !== 'PENDING') {
      throw new BadRequestException('只能审核待审核状态的能力');
    }

    return this.prisma.$transaction(async (tx) => {
      const isContributionSubmission = capability.platformReviewStatus === 'PENDING_REVIEW';
      const updated = await tx.capability.update({
        where: { id: capabilityId },
        data: {
          status: 'REJECTED',
          ...(isContributionSubmission && {
            platformReviewStatus: 'REJECTED',
            visibility: 'ENTERPRISE_PRIVATE',
            platformRejectionReason: reason,
          }),
        },
      });
      return updated;
    });
  }

  /**
   * 删除能力（仅待审核或已拒绝可删除）
   */
  async deleteCapability(capabilityId: string) {
    const capability = await this.prisma.capability.findUnique({
      where: { id: capabilityId },
      include: { bindings: true },
    });

    if (!capability) throw new NotFoundException('能力不存在');
    if (capability.status === 'APPROVED' || capability.status === 'ARCHIVED') {
      throw new BadRequestException('已发布或已下架的能力不能删除');
    }
    if (capability.bindings?.length > 0) {
      throw new BadRequestException('能力已被员工绑定，无法删除');
    }

    await this.prisma.capability.delete({
      where: { id: capabilityId },
    });

    return { success: true };
  }

  /**
   * 下架能力并停用所有员工绑定。保留绑定和版本选择供审计，员工记录不受影响。
   */
  async archiveCapability(capabilityId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${capabilityId} FOR UPDATE`;
      const capability = await tx.capability.findUnique({
        where: { id: capabilityId },
        select: { id: true, status: true },
      });
      if (!capability) throw new NotFoundException('能力不存在');
      if (capability.status !== 'APPROVED') {
        throw new BadRequestException('只能下架已发布的能力');
      }
      await tx.employeeCapabilityBinding.updateMany({
        where: { capabilityId, enabled: true },
        data: { enabled: false },
      });
      return tx.capability.update({
        where: { id: capabilityId },
        data: { status: 'ARCHIVED' },
      });
    });
  }

  /**
   * 运营仪表盘统计数据
   */
  async getStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // 上月末（用于 MoM 环比）
    const prevMonthEnd = new Date();
    prevMonthEnd.setDate(0);
    prevMonthEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    const [
      totalEnterprises,
      suspendedEnterprises,
      totalEmployees,
      pendingEmployees,
      todayConsumeTx,
      yesterdayConsumeTx,
      todayConversations,
      yesterdayConversations,
      prevMonthEnterprises,
      prevMonthEmployees,
      pendingCapabilities,
      computeTx30,
      enterprises30,
      topAccountsRaw,
      topEmployeesRaw,
    ] = await Promise.all([
      this.prisma.enterprise.count(),
      // 冻结状态存在 metadata JSON 里，不是独立字段
      this.prisma.enterprise.count({
        where: { metadata: { path: ['suspended'], equals: true } },
      }),
      this.prisma.digitalEmployee.count({ where: { status: 'APPROVED' } }),
      this.prisma.digitalEmployee.count({ where: { status: 'PENDING' } }),
      // 今日算力消费。统一人民币口径后数据源是 ComputeUsageRecord ——
      // ComputeTransaction 已停止写入，继续读它会让运营看板从改版当天起冻结。
      this.prisma.computeUsageRecord.aggregate({
        where: { createdAt: { gte: todayStart, lte: todayEnd } },
        _sum: { costCNY: true, inputTokens: true, outputTokens: true },
      }),
      // 昨日算力消费（用于趋势比较）
      this.prisma.computeUsageRecord.aggregate({
        where: { createdAt: { gte: yesterdayStart, lt: todayStart } },
        _sum: { costCNY: true, inputTokens: true, outputTokens: true },
      }),
      // 今日活跃用户（有会话的不重复用户数）
      this.prisma.conversationSession.findMany({
        where: { createdAt: { gte: todayStart, lte: todayEnd } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      // 昨日活跃用户
      this.prisma.conversationSession.findMany({
        where: { createdAt: { gte: yesterdayStart, lt: todayStart } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      // 上月企业总数（用于 MoM 趋势）
      this.prisma.enterprise.count({
        where: { createdAt: { lte: prevMonthEnd } },
      }),
      // 上月员工数
      this.prisma.digitalEmployee.count({
        where: { status: 'APPROVED', createdAt: { lte: prevMonthEnd } },
      }),
      // 待审核能力
      this.prisma.capability.count({ where: { status: 'PENDING' } }),
      // 近 30 天按日汇总的算力消费
      this.prisma.computeUsageRecord.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: {
          costCNY: true,
          inputTokens: true,
          outputTokens: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      // 近 30 天企业注册记录
      this.prisma.enterprise.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Top 10 企业（按算力消费金额）。ComputeUsageRecord 自带 enterpriseId，
      // 不必再像旧的 ComputeTransaction 那样绕 accountId 回查。
      this.prisma.computeUsageRecord.groupBy({
        by: ['enterpriseId'],
        _sum: { costCNY: true, inputTokens: true, outputTokens: true },
        orderBy: { _sum: { costCNY: 'desc' } },
        take: 10,
      }),
      // Top 10 员工（按会话数）
      this.prisma.conversationSession.groupBy({
        by: ['employeeId'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);

    // ── 计算 KPI trends ────────────────────────────────────────────
    const enterpriseTrendPct =
      prevMonthEnterprises > 0
        ? +((((totalEnterprises - prevMonthEnterprises) / prevMonthEnterprises) * 100).toFixed(1))
        : 0;

    const employeeTrendPct =
      prevMonthEmployees > 0
        ? +((((totalEmployees - prevMonthEmployees) / prevMonthEmployees) * 100).toFixed(1))
        : 0;

    // Token 仍作为用量指标展示（它反映调用规模），但趋势按**人民币成本**算 ——
    // 换模型会让同样的 token 数对应完全不同的成本，token 趋势会误导。
    const todayTokens =
      (todayConsumeTx._sum.inputTokens ?? 0) +
      (todayConsumeTx._sum.outputTokens ?? 0);
    const yesterdayTokens =
      (yesterdayConsumeTx._sum.inputTokens ?? 0) +
      (yesterdayConsumeTx._sum.outputTokens ?? 0);
    const todayCostCNY = Number(todayConsumeTx._sum.costCNY ?? 0);
    const yesterdayCostCNY = Number(yesterdayConsumeTx._sum.costCNY ?? 0);
    const tokenTrendPct =
      yesterdayCostCNY > 0
        ? +(((todayCostCNY - yesterdayCostCNY) / yesterdayCostCNY) * 100).toFixed(1)
        : 0;

    const todayActiveUsers = todayConversations.length;
    const yesterdayActiveUsers = yesterdayConversations.length;
    const userTrendPct =
      yesterdayActiveUsers > 0
        ? +(((todayActiveUsers - yesterdayActiveUsers) / yesterdayActiveUsers) * 100).toFixed(1)
        : 0;

    // ── 近 30 天趋势：按日汇总 ──────────────────────────────────────
    const dayMap = new Map<string, { tokens: number; costCNY: number }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo.getTime() + i * 86400000);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      dayMap.set(key, { tokens: 0, costCNY: 0 });
    }
    for (const usage of computeTx30) {
      const d = usage.createdAt;
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      const bucket = dayMap.get(key) ?? { tokens: 0, costCNY: 0 };
      bucket.tokens += usage.inputTokens + usage.outputTokens;
      bucket.costCNY += Number(usage.costCNY);
      dayMap.set(key, bucket);
    }
    const computeTrend = Array.from(dayMap.entries()).map(([date, bucket]) => ({
      date,
      tokens: bucket.tokens,
      costCNY: +bucket.costCNY.toFixed(2),
    }));

    const entDayMap = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo.getTime() + i * 86400000);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      entDayMap.set(key, 0);
    }
    for (const ent of enterprises30) {
      const d = ent.createdAt;
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      entDayMap.set(key, (entDayMap.get(key) ?? 0) + 1);
    }
    const enterpriseTrend = Array.from(entDayMap.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    // ── Top 10 企业：enterpriseId → 企业名称 ──────────────────────
    const topEnterpriseIds = topAccountsRaw.map((r) => r.enterpriseId);

    const topEnterpriseRows = await this.prisma.enterprise.findMany({
      where: { id: { in: topEnterpriseIds } },
      select: { id: true, name: true },
    });
    const enterpriseNameMap = new Map(
      topEnterpriseRows.map((e) => [e.id, e.name]),
    );

    const topEnterprises = topAccountsRaw.map((r) => ({
      id: r.enterpriseId,
      name: enterpriseNameMap.get(r.enterpriseId) ?? '未知企业',
      tokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0),
      costCNY: +Number(r._sum.costCNY ?? 0).toFixed(2),
    }));

    // ── Top 10 员工：补全名称 ──────────────────────────────────────
    const topEmployeeIds = topEmployeesRaw.map((r) => r.employeeId);
    const topEmployeeDetails = await this.prisma.digitalEmployee.findMany({
      where: { id: { in: topEmployeeIds } },
      select: { id: true, name: true, bindings: { select: { capability: { select: { type: true } } }, take: 1 } },
    });
    const empDetailMap = new Map(topEmployeeDetails.map((e) => [e.id, e]));

    const topEmployees = topEmployeesRaw.map((r) => {
      const detail = empDetailMap.get(r.employeeId);
      const firstType = detail?.bindings?.[0]?.capability?.type ?? 'AGENT';
      return {
        id: r.employeeId,
        name: detail?.name ?? '未知员工',
        type: firstType,
        calls: r._count.id,
      };
    });

    return {
      kpi: {
        totalEnterprises,
        suspendedEnterprises,
        enterpriseTrendPct,
        totalEmployees,
        pendingEmployees,
        employeeTrendPct,
        pendingCapabilities,
        todayTokens,
        /** 今日算力消费（元）—— 财务口径的主指标 */
        todayCostCNY: +todayCostCNY.toFixed(2),
        /** 趋势按人民币成本算，见上方注释 */
        tokenTrendPct,
        todayActiveUsers,
        userTrendPct,
      },
      computeTrend,
      enterpriseTrend,
      topEnterprises,
      topEmployees,
    };
  }

  /**
   * 提交员工审核（替代原 publishEmployee）
   */
  async submitEmployeeForReview(employeeId: string, operatorId: string) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) throw new NotFoundException('员工不存在');
    if (employee.status !== 'DRAFT') {
      throw new BadRequestException('只能提交草稿状态的员工');
    }

    return this.prisma.digitalEmployee.update({
      where: { id: employeeId },
      data: {
        status: 'PENDING', // 进入待审核
      },
    });
  }

  private async avatarDefinitions(db: Prisma.TransactionClient = this.prisma) {
    const custom = await db.avatarStyleDefinition.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    return [
      ...SELECTABLE_AVATAR_STYLES.map((style) => ({
        ...style,
        examples: style.delivery === 'binding' ? [] as string[]
          : [1, 2, 3].map((n) => libraryAvatarBinding(style.id, `preview-${n}`, ['产品经理', '设计师', '工程师'][n - 1])?.faceUrl
            ?? libraryAvatarBinding(style.id, `preview-${n}`, ['产品经理', '设计师', '工程师'][n - 1])?.portraitUrl).filter((url): url is string => !!url),
      })),
      ...custom.map((style) => ({ ...style, source: 'platform', sourceName: '平台素材', sourceUrl: '', license: undefined, delivery: 'binding' as const,
        examples: Array.isArray(style.examples) ? style.examples.filter((item): item is string => typeof item === 'string') : [] })),
    ];
  }

  private async avatarDefault(db: Prisma.TransactionClient = this.prisma) {
    const setting = await db.systemSetting.findUnique({ where: { key: 'DEFAULT_AVATAR_STYLE' } });
    return canonicalAvatarStyleId(setting?.value || process.env.DEFAULT_AVATAR_STYLE || DEFAULT_AVATAR_STYLE_ID);
  }

  private async avatarTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new BadRequestException('头像配置正在被其他管理员修改，请刷新后重试');
      }
      throw error;
    }
  }

  async getAvatarStyles() {
    const [employees, definitions, defaultStyleId] = await Promise.all([
      this.prisma.digitalEmployee.findMany({ orderBy: { createdAt: 'asc' } }),
      this.avatarDefinitions(), this.avatarDefault(),
    ]);
    const prepared = employees.map((employee) => ({ ...employee, avatarBindings: preservedAvatarBindings(employee) }));
    const styles = definitions.map((style) => {
      const matched = prepared.filter((employee) => !!resolveAvatarForStyle(employee, style.id)).length;
      const examples = style.examples.length ? style.examples : prepared.flatMap((employee) => {
        const avatar = resolveAvatarForStyle(employee, style.id);
        return avatar ? [withEmployeeAvatar({ ...employee, avatar }).avatar!] : [];
      }).slice(0, 3);
      return { ...style, examples: examples.map((url) => url.startsWith('/') && !url.startsWith('//') ? new URL(url, employeeAssetBaseUrl()).href : url),
        coverage: { matched, total: employees.length }, canSetDefault: matched === employees.length };
    });
    const followersCount = employees.filter((employee) => !employee.avatarStyle || employee.avatarStyle === FOLLOW_DEFAULT_STYLE_ID).length;
    return {
      styles, sources: AVATAR_SOURCES.filter((source) => styles.some((style) => style.source === source.id)),
      total: styles.length, defaultStyleId, followersCount, overridesCount: employees.length - followersCount,
      employees: prepared.map((employee) => ({
        id: employee.id, name: employee.name, position: employee.position,
        avatar: withEmployeeAvatar(employee).avatar, avatarAsset: withEmployeeAvatar(employee).avatarAsset,
        avatarStyle: employee.avatarStyle || FOLLOW_DEFAULT_STYLE_ID,
        effectiveStyleId: employeeEffectiveStyle(employee.avatarStyle, defaultStyleId),
        availableStyleIds: [
          ...(resolveAvatarForStyle(employee, defaultStyleId) ? [FOLLOW_DEFAULT_STYLE_ID] : []),
          ...styles.filter((style) => !!resolveAvatarForStyle(employee, style.id)).map((style) => style.id),
          ...(employee.avatarCustomUrl || (employee.avatarStyle === 'custom' && employee.avatar) ? ['custom'] : []),
        ],
      })),
    };
  }

  async batchUpdateAvatarStyle(styleId: string, operatorId: string, applyToAll = false) {
    const canonical = canonicalAvatarStyleId(styleId);
    return this.avatarTransaction(async (tx) => {
      const style = (await this.avatarDefinitions(tx)).find((item) => item.id === canonical);
      if (!style) throw new BadRequestException('头像风格不存在');
      const employees = await tx.digitalEmployee.findMany();
      const prepared = employees.map((employee) => ({ ...employee, avatarBindings: preservedAvatarBindings(employee) }));
      if (prepared.some((employee) => !resolveAvatarForStyle(employee, canonical))) {
        throw new BadRequestException('该头像风格素材覆盖不完整，不能设为平台默认');
      }
      const followers = prepared.filter((employee) => !employee.avatarStyle || employee.avatarStyle === FOLLOW_DEFAULT_STYLE_ID);
      const targets = applyToAll ? prepared : followers;
      await tx.systemSetting.upsert({ where: { key: 'DEFAULT_AVATAR_STYLE' }, create: { key: 'DEFAULT_AVATAR_STYLE', value: canonical, label: '数字员工默认头像风格' }, update: { value: canonical } });
      for (const employee of targets) {
        const avatar = resolveAvatarForStyle(employee, canonical)!;
        const bindings = employee.avatarBindings;
        bindings[canonical] ??= resolveAvatarBindingForStyle(employee, canonical)!;
        const preservedCustomUrl = employee.avatarCustomUrl || (employee.avatarStyle === 'custom' ? employee.avatar : null);
        await tx.digitalEmployee.update({
          where: { id: employee.id },
          data: {
            avatar,
            avatarStyle: FOLLOW_DEFAULT_STYLE_ID,
            avatarBindings: bindings,
            ...(preservedCustomUrl ? { avatarCustomUrl: preservedCustomUrl } : {}),
          },
        });
      }
      return { success: true, updated: targets.length, skipped: employees.length - targets.length, style: style.name, styleId: canonical, appliedToAll: applyToAll };
    });
  }

  async updateEmployeeAvatarStyle(employeeId: string, styleId: string, operatorId: string) {
    const canonical = canonicalAvatarStyleId(styleId);
    return this.avatarTransaction(async (tx) => {
      const employee = await tx.digitalEmployee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new NotFoundException('员工不存在');
      const effective = canonical === FOLLOW_DEFAULT_STYLE_ID ? await this.avatarDefault(tx) : canonical;
      if (effective !== 'custom' && !(await this.avatarDefinitions(tx)).some((style) => style.id === effective)) throw new BadRequestException('头像风格不存在');
      const bindings = preservedAvatarBindings(employee);
      const custom = employee.avatarCustomUrl || (employee.avatarStyle === 'custom' ? employee.avatar : null);
      const avatar = effective === 'custom' ? custom : resolveAvatarForStyle({ ...employee, avatarBindings: bindings }, effective);
      if (!avatar) throw new BadRequestException('该员工没有可用的头像绑定');
      if (effective !== 'custom') bindings[effective] ??= resolveAvatarBindingForStyle({ ...employee, avatarBindings: bindings }, effective)!;
      return withEmployeeAvatar(await tx.digitalEmployee.update({ where: { id: employeeId }, data: { avatar, avatarStyle: canonical, avatarCustomUrl: custom, avatarBindings: bindings } }));
    });
  }

  async registerAvatarStyle(input: { id: string; name: string; description: string; category: string; examples?: string[]; recommended?: boolean; totalAssets?: number }) {
    const id = input.id.trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id) || [FOLLOW_DEFAULT_STYLE_ID, 'custom'].includes(id) || builtinAvatarStyle(id)) throw new BadRequestException('风格标识无效或与内置风格冲突');
    if (input.examples?.some((url) => !isAvatarImageUrl(url))) throw new BadRequestException('素材地址必须为 HTTP(S) 或 /assets/ 路径');
    if (await this.prisma.avatarStyleDefinition.findUnique({ where: { id } })) throw new BadRequestException('该风格标识已存在');
    return this.prisma.avatarStyleDefinition.create({ data: { ...input, id, source: 'platform', examples: input.examples || [] } });
  }

  async bindEmployeeAvatar(employeeId: string, styleId: string, binding: { portraitUrl: string; faceUrl?: string; version?: string }) {
    if (!isAvatarImageUrl(binding.portraitUrl) || (binding.faceUrl && !isAvatarImageUrl(binding.faceUrl))) throw new BadRequestException('素材地址必须为 HTTP(S) 或 /assets/ 路径');
    const canonical = canonicalAvatarStyleId(styleId);
    return this.avatarTransaction(async (tx) => {
      const style = (await this.avatarDefinitions(tx)).find((item) => item.id === canonical && ['binding', 'static'].includes(item.delivery));
      if (!style) throw new BadRequestException('请选择支持员工素材绑定的风格');
      const employee = await tx.digitalEmployee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new NotFoundException('员工不存在');
      const bindings = preservedAvatarBindings(employee);
      bindings[canonical] = { portraitUrl: binding.portraitUrl, ...(binding.faceUrl ? { faceUrl: binding.faceUrl } : {}), ...(binding.version ? { version: binding.version } : {}) };
      const effective = employeeEffectiveStyle(employee.avatarStyle, await this.avatarDefault(tx));
      return withEmployeeAvatar(await tx.digitalEmployee.update({ where: { id: employeeId }, data: {
        avatarBindings: bindings, ...(effective === canonical ? { avatar: binding.portraitUrl } : {}),
      } }));
    });
  }
}
