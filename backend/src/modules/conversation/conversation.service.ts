import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { withEmployeeAvatar } from '../../common/employee-avatar';
import { SubscriptionService } from '../subscription/subscription.service';
import { ModelService } from '../model/model.service';
import { ComputeCreditService } from '../compute-credit/compute-credit.service';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import {
  ConversationCreateDto,
  ConversationSource,
  ConversationUpdateDto,
  type MessageAttachment,
} from 'shared';
import { StorageService } from '../upload/storage/storage.service';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionService: SubscriptionService,
    private readonly modelService: ModelService,
    private readonly modelConfig: EnterpriseModelConfigService,
    private readonly storage: StorageService,
    private readonly computeCredit: ComputeCreditService,
    private readonly enterpriseContext: EnterpriseContextService,
  ) {}

  async create(userId: string, dto: ConversationCreateDto) {
    const source = dto.source ?? 'CHAT';
    if (source === 'TASK' && (!dto.taskPlanId || !dto.taskStepId)) {
      throw new BadRequestException('Task conversations require taskPlanId and taskStepId');
    }
    if (source === 'CHAT' && (dto.taskPlanId || dto.taskStepId)) {
      throw new BadRequestException('Chat conversations cannot include task context');
    }

    // 验证 DigitalEmployee 存在
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, name: true },
    });
    if (!employee) {
      throw new NotFoundException(`Digital employee ${dto.employeeId} not found`);
    }

    // 必须持有有效订阅
    await this.subscriptionService.assertActiveSubscription(userId, dto.employeeId);

    // 对话前的人民币余额闸门（乐观检查）：该员工的赠送余额 + 企业钱包余额。
    // 精确扣费在对话结束后完成，这里只拦「一分钱都没有」的情况 ——
    // 单次对话的成本要等模型返回 token 数才知道，事前无法精确预留。
    const ctx = await this.enterpriseContext.resolve(userId);
    const subscription = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: ctx.enterpriseId,
          employeeId: dto.employeeId,
        },
      },
      select: { id: true },
    });
    const enterpriseConfig = await this.modelConfig.get(userId);
    const balanceCheck = await this.computeCredit.checkBalanceBeforeConversation(
      ctx.enterpriseId,
      subscription?.id,
      // 传 userId 才能过「这个人本月的算力额度」这道闸门
      userId,
      enterpriseConfig.defaultChatModel,
    );
    if (!balanceCheck.allowed) {
      throw new BadRequestException(balanceCheck.reason);
    }

    // Snapshot the enterprise default at creation time. A null modelId would
    // silently fall back to the employee template, contradicting the setting
    // labelled "默认会话模型" in the enterprise console.
    const session = await this.prisma.conversationSession.create({
      data: {
        userId,
        employeeId: dto.employeeId,
        title: dto.title ?? null,
        source,
        taskPlanId: dto.taskPlanId ?? null,
        taskStepId: dto.taskStepId ?? null,
        modelId: enterpriseConfig.defaultChatModel,
      },
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        taskPlanId: true,
        taskStepId: true,
        modelId: true,
        createdAt: true,
        updatedAt: true,
        employee: { select: { id: true, name: true, avatar: true, avatarStyle: true, avatarBindings: true, status: true } },
      },
    });

    this.logger.log(`Session created: ${session.id} by user ${userId}`);
    return { ...session, employee: session.employee ? withEmployeeAvatar(session.employee) : session.employee };
  }

  async findAll(userId: string, source: ConversationSource = 'CHAT') {
    const enterpriseContext = source === 'CHAT'
      ? await this.enterpriseContext.resolveOrNull(userId)
      : null;
    const now = new Date();
    const employeeWhere: Prisma.DigitalEmployeeWhereInput | undefined = source !== 'CHAT'
      ? undefined
      : enterpriseContext
        ? {
          OR: [
            { status: { not: 'ARCHIVED' } },
            {
              status: 'ARCHIVED',
              subscriptions: {
                some: {
                  enterpriseId: enterpriseContext.enterpriseId,
                  status: 'ACTIVE',
                  OR: [{ endDate: null }, { endDate: { gt: now } }],
                  grants: {
                    some: {
                      OR: [
                        { memberId: enterpriseContext.memberId },
                        ...(enterpriseContext.departmentId
                          ? [{ departmentId: enterpriseContext.departmentId }]
                          : []),
                      ],
                      AND: [{
                        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                      }],
                    },
                  },
                },
              },
            },
          ],
        }
        : { status: { not: 'ARCHIVED' } };
    const sessions = await this.prisma.conversationSession.findMany({
      // 归档会话通过 status 隐藏；历史消息仍保留在数据库中，供审计和必要时恢复。
      // 已下架员工仅对仍持有本企业有效订阅及成员/部门授权的用户保留历史会话可见性。
      where: {
        userId,
        source,
        status: 'ACTIVE',
        ...(employeeWhere ? { employee: { is: employeeWhere } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        source: true,
        taskPlanId: true,
        taskStepId: true,
        modelId: true,
        createdAt: true,
        updatedAt: true,
        employee: { select: { id: true, name: true, avatar: true, avatarStyle: true, avatarBindings: true, status: true } },
        _count: { select: { messages: true } },
      },
    });
    return sessions.map((session) => ({
      ...session,
      employee: session.employee ? withEmployeeAvatar(session.employee) : session.employee,
    }));
  }

  async findOne(sessionId: string, userId: string) {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      include: {
        employee: { select: { id: true, name: true, avatar: true, avatarStyle: true, avatarBindings: true, modelId: true, status: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            toolCalls: true,
            knowledgeSources: true,
            metadata: true,
            attachments: true,
            createdAt: true,
          },
        },
      },
    });

    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (session.userId !== userId) throw new ForbiddenException();

    return {
      ...session,
      employee: session.employee ? withEmployeeAvatar(session.employee) : session.employee,
      messages: await this.withFreshAttachmentUrls(session.messages),
    };
  }

  /**
   * 重签附件访问链接。
   *
   * 存库的 url 只有 1 小时有效期，历史会话直接回传会渲染成裂图。key 是
   * 永久标识，所以每次读取会话时按 key 重新签发。
   */
  private async withFreshAttachmentUrls<
    T extends { attachments: unknown },
  >(messages: T[]): Promise<T[]> {
    return Promise.all(
      messages.map(async (message) => {
        const attachments = message.attachments as MessageAttachment[] | null;
        if (!attachments || attachments.length === 0) return message;

        const refreshed = await Promise.all(
          attachments.map(async (att) => {
            try {
              return { ...att, url: await this.storage.getSignedUrl(att.key) };
            } catch (err) {
              // 重签失败（对象已被清理等）不该让整个会话打不开
              this.logger.warn(
                `附件重签失败 ${att.key}: ${(err as Error).message}`,
              );
              return att;
            }
          }),
        );

        return { ...message, attachments: refreshed };
      }),
    );
  }

  async update(sessionId: string, userId: string, dto: ConversationUpdateDto) {
    await this.assertOwner(sessionId, userId);

    return this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { title: dto.title },
      select: { id: true, title: true, updatedAt: true },
    });
  }

  async switchModel(sessionId: string, userId: string, modelId: string) {
    await this.assertOwner(sessionId, userId);

    // 只允许切到平台已启用的模型（防止绕过白名单调用未开放模型）
    if (modelId && !(await this.modelService.isEnabled(modelId))) {
      throw new BadRequestException(`模型 ${modelId} 未开放使用`);
    }

    return this.prisma.conversationSession.update({
      where: { id: sessionId },
      data: { modelId: modelId || null }, // 空 = 回退员工默认模型
      select: { id: true, modelId: true, updatedAt: true },
    });
  }

  async remove(sessionId: string, userId: string) {
    await this.assertOwner(sessionId, userId);

    await this.prisma.conversationSession.delete({ where: { id: sessionId } });
    this.logger.log(`Session deleted: ${sessionId}`);
  }

  /**
   * 首条消息后自动生成标题（仅 title 为 null 时设置，重命名后不覆盖）
   */
  async autoGenerateTitle(sessionId: string, firstUserMessage: string): Promise<void> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      select: { title: true, _count: { select: { messages: true } } },
    });

    if (!session) return;

    // 只在 title 从未设置（null），且消息数 ≤ 2（用户+AI 第一轮）时生成
    if (session.title === null && session._count.messages <= 2) {
      // 纯附件消息（content 为空）取不到文字，回退到固定文案，
      // 否则标题会是空串，会话列表里显示成一片空白
      const autoTitle = firstUserMessage.slice(0, 20).trim() || '附件消息';
      await this.prisma.conversationSession.update({
        where: { id: sessionId },
        data: { title: autoTitle },
      });
    }
  }

  private async assertOwner(sessionId: string, userId: string) {
    const session = await this.prisma.conversationSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });

    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (session.userId !== userId) throw new ForbiddenException();
  }
}
