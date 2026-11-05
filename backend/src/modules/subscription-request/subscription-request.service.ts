import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestStatus, SubscriptionRequestKind } from '@prisma/client';
import {
  CreateSubscriptionRequestDto,
  ApproveSubscriptionRequestDto,
  RejectSubscriptionRequestDto,
} from './dto';
import { EnterpriseContextService } from '../enterprise/enterprise-context.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class SubscriptionRequestService {
  constructor(
    private prisma: PrismaService,
    private enterpriseContext: EnterpriseContextService,
    private subscriptionService: SubscriptionService,
    private notifications: NotificationsService,
  ) {}

  /**
   * 创建订阅申请（普通成员）
   */
  async createRequest(
    userId: string,
    dto: CreateSubscriptionRequestDto,
    clientOptions: {
      targetType?: 'ENTERPRISE_SUBSCRIPTION' | 'PLATFORM_EMPLOYEE';
      requestedCapabilities?: string[];
      idempotencyKey?: string;
      requestFingerprint?: string;
    } = {},
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);

    if (clientOptions.idempotencyKey) {
      const existing = await this.prisma.subscriptionRequest.findUnique({
        where: { clientIdempotencyKey: clientOptions.idempotencyKey },
        include: {
          employee: { select: { id: true, name: true, avatar: true } },
          requester: { select: { id: true, userId: true, role: true } },
        },
      });
      if (existing) {
        if (
          existing.requesterId !== ctx.memberId ||
          existing.clientRequestFingerprint !== clientOptions.requestFingerprint
        ) {
          throw new ConflictException('Idempotency-Key 已被其他请求使用');
        }
        return existing;
      }
    }

    // 检查员工是否存在
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: dto.employeeId },
    });
    if (!employee) {
      throw new NotFoundException(`Employee ${dto.employeeId} not found`);
    }
    if (employee.status !== 'APPROVED') {
      throw new BadRequestException('Cannot request unapproved employee');
    }

    // 企业对该员工的订阅状态决定申请类型：
    //   ACTIVE → GRANT（仅授权，免费）；否则 → SUBSCRIBE（订阅 + 授权，扣费）
    const subscription = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId: ctx.enterpriseId,
          employeeId: dto.employeeId,
        },
      },
    });

    const kind =
      subscription && subscription.status === 'ACTIVE'
        ? SubscriptionRequestKind.GRANT
        : SubscriptionRequestKind.SUBSCRIBE;

    // 已有 ACTIVE 订阅时，检查申请人是否已持有有效授权（直接或经部门）。
    // 已有权限还来申请是无意义的重复，直接拒绝，避免审批队列被刷屏。
    if (kind === SubscriptionRequestKind.GRANT && ctx.memberId && subscription) {
      const now = new Date();
      const alreadyGranted = await this.prisma.employeeGrant.findFirst({
        where: {
          subscriptionId: subscription.id,
          AND: [
            {
              OR: [
                { memberId: ctx.memberId },
                ...(ctx.departmentId ? [{ departmentId: ctx.departmentId }] : []),
              ],
            },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
      });
      if (alreadyGranted) {
        throw new ConflictException('你已有该员工的使用权限');
      }
    }

    // 检查是否有未处理的申请（同企业、同员工、同申请人）—— 两类申请统一去重
    const pendingRequest = await this.prisma.subscriptionRequest.findFirst({
      where: {
        enterpriseId: ctx.enterpriseId,
        employeeId: dto.employeeId,
        requesterId: ctx.memberId,
        status: RequestStatus.PENDING,
      },
    });

    if (pendingRequest) {
      throw new ConflictException('You already have a pending request for this employee');
    }

    // 快照申请人信息
    const requester = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });

    // 创建申请
    const request = await this.prisma.subscriptionRequest.create({
      data: {
        enterpriseId: ctx.enterpriseId,
        requesterId: ctx.memberId,
        requesterEmail: requester?.email,
        requesterName: requester?.name,
        employeeId: dto.employeeId,
        reason: dto.reason,
        requestedDays: dto.requestedDays,
        kind,
        status: RequestStatus.PENDING,
        clientTargetType: clientOptions.targetType,
        requestedCapabilities: clientOptions.requestedCapabilities ?? undefined,
        clientIdempotencyKey: clientOptions.idempotencyKey,
        clientRequestFingerprint: clientOptions.requestFingerprint,
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        requester: { select: { id: true, userId: true, role: true } },
      },
    });

    // 通知企业管理员（文案按类型区分）
    const admins = await this.prisma.enterpriseMember.findMany({
      where: {
        enterpriseId: ctx.enterpriseId,
        role: 'ENTERPRISE_ADMIN',
      },
      select: { userId: true },
    });

    if (admins.length > 0) {
      const action =
        kind === SubscriptionRequestKind.GRANT ? '申请使用' : '申请订阅';
      await this.notifications.createBatch(
        admins.map((a) => a.userId),
        {
          type: 'SUBSCRIPTION_REQUEST_CREATED',
          title: '新的使用申请',
          message: `${requester?.name ?? requester?.email ?? '成员'} ${action}「${employee.name}」`,
          relatedType: 'SUBSCRIPTION_REQUEST',
          relatedId: request.id,
        },
      );
    }

    return request;
  }

  /**
   * 审批通过订阅申请（管理员）
   */
  async approveRequest(
    reviewerUserId: string,
    requestId: string,
    dto: ApproveSubscriptionRequestDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(reviewerUserId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: true,
        requester: true,
      },
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found`);
    }

    if (request.enterpriseId !== ctx.enterpriseId) {
      throw new ForbiddenException('Cannot approve request from another enterprise');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    if (!request.requester) {
      throw new BadRequestException('Original requester no longer in enterprise');
    }

    // 事务：创建/激活订阅 + 创建授权 + 更新申请状态
    return await this.prisma.$transaction(async (tx) => {
      // 1. 检查是否已有订阅
      let subscription = await tx.subscription.findUnique({
        where: {
          enterpriseId_employeeId: {
            enterpriseId: ctx.enterpriseId,
            employeeId: request.employeeId,
          },
        },
      });

      // 2. 创建或激活订阅（通过 SubscriptionService，包含扣款逻辑）
      if (!subscription || subscription.status !== 'ACTIVE') {
        // 使用 SubscriptionService.subscribe 创建/激活订阅（会自动扣款）
        subscription = await this.subscriptionService.subscribe(reviewerUserId, {
          employeeId: request.employeeId,
          config: null,
        });
      }

      // 3. 为申请人创建授权
      const expiresAt = dto.approvedDays
        ? new Date(Date.now() + dto.approvedDays * 24 * 60 * 60 * 1000)
        : subscription.endDate;

      const grant = await tx.employeeGrant.create({
        data: {
          subscriptionId: subscription.id,
          memberId: request.requester.id,
          expiresAt,
        },
      });

      // 4. 更新申请状态
      const updatedRequest = await tx.subscriptionRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.APPROVED,
          reviewerId: reviewerUserId,
          reviewNote: dto.reviewNote,
          reviewedAt: new Date(),
          subscriptionId: subscription.id,
        },
        include: {
          employee: { select: { id: true, name: true, avatar: true } },
          requester: { select: { id: true, userId: true, role: true } },
          reviewer: { select: { id: true, name: true, email: true } },
        },
      });

      // 通知申请人（事务外，失败不影响审批结果）
      if (request.requester?.userId) {
        const isGrant = request.kind === SubscriptionRequestKind.GRANT;
        await this.notifications
          .create({
            userId: request.requester.userId,
            type: 'SUBSCRIPTION_REQUEST_APPROVED',
            title: isGrant ? '使用申请已通过' : '订阅申请已通过',
            message: isGrant
              ? `您申请使用「${request.employee.name}」已通过审批，现在可以使用了`
              : `您申请订阅「${request.employee.name}」已通过审批，现在可以使用了`,
            relatedType: 'SUBSCRIPTION',
            relatedId: subscription.id,
          })
          .catch(() => {
            // 通知失败不影响审批流程
          });
      }

      return { request: updatedRequest, subscription, grant };
    });
  }

  /**
   * 拒绝订阅申请（管理员）
   */
  async rejectRequest(
    reviewerUserId: string,
    requestId: string,
    dto: RejectSubscriptionRequestDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(reviewerUserId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: { select: { id: true, name: true } },
      },
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found`);
    }

    if (request.enterpriseId !== ctx.enterpriseId) {
      throw new ForbiddenException('Cannot reject request from another enterprise');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    const updatedRequest = await this.prisma.subscriptionRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.REJECTED,
        reviewerId: reviewerUserId,
        reviewNote: dto.reviewNote,
        reviewedAt: new Date(),
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        requester: { select: { id: true, userId: true, role: true } },
        reviewer: { select: { id: true, name: true, email: true } },
      },
    });

    // 通知申请人
    if (request.requesterId) {
      const requesterMember = await this.prisma.enterpriseMember.findUnique({
        where: { id: request.requesterId },
        select: { userId: true },
      });

      if (requesterMember) {
        const isGrant = request.kind === SubscriptionRequestKind.GRANT;
        await this.notifications
          .create({
            userId: requesterMember.userId,
            type: 'SUBSCRIPTION_REQUEST_REJECTED',
            title: isGrant ? '使用申请已拒绝' : '订阅申请已拒绝',
            message: `${isGrant ? '您申请使用' : '您申请订阅'}「${request.employee.name}」已被拒绝${dto.reviewNote ? `：${dto.reviewNote}` : ''}`,
            relatedType: 'SUBSCRIPTION_REQUEST',
            relatedId: requestId,
          })
          .catch(() => {
            // 通知失败不影响拒绝流程
          });
      }
    }

    return updatedRequest;
  }

  /**
   * 取消自己的申请（申请人）
   */
  async cancelRequest(userId: string, requestId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);

    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found`);
    }

    if (request.requesterId !== ctx.memberId) {
      throw new ForbiddenException('Can only cancel your own requests');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(`Request is already ${request.status.toLowerCase()}`);
    }

    return await this.prisma.subscriptionRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.CANCELED },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
      },
    });
  }

  /** 查询客户端申请详情，并强制限制为当前用户自己的申请。 */
  async getClientRequest(userId: string, requestId: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    const request = await this.prisma.subscriptionRequest.findFirst({
      where: {
        id: requestId,
        enterpriseId: ctx.enterpriseId,
        requesterId: ctx.memberId,
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
      },
    });
    if (!request) throw new NotFoundException('申请不存在');
    return request;
  }

  /**
   * 查询我的申请（申请人）
   */
  async getMyRequests(userId: string, status?: RequestStatus, keyword?: string) {
    const ctx = await this.enterpriseContext.resolve(userId);

    return await this.prisma.subscriptionRequest.findMany({
      where: {
        requesterId: ctx.memberId,
        ...(status ? { status } : {}),
        ...(keyword?.trim() ? { employee: { name: { contains: keyword.trim(), mode: 'insensitive' } } } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        reviewer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 查询待审批申请（管理员）
   */
  async getPendingRequests(userId: string, keyword?: string) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    return await this.prisma.subscriptionRequest.findMany({
      where: {
        enterpriseId: ctx.enterpriseId,
        status: RequestStatus.PENDING,
        ...(keyword?.trim() ? { employee: { name: { contains: keyword.trim(), mode: 'insensitive' } } } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        requester: {
          select: {
            id: true,
            userId: true,
            role: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 查询所有申请（管理员，带筛选）
   */
  async getAllRequests(
    userId: string,
    status?: RequestStatus,
    keyword?: string,
  ) {
    const ctx = await this.enterpriseContext.resolve(userId);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);

    return await this.prisma.subscriptionRequest.findMany({
      where: {
        enterpriseId: ctx.enterpriseId,
        ...(status && { status }),
        ...(keyword?.trim() ? { employee: { name: { contains: keyword.trim(), mode: 'insensitive' } } } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, avatar: true } },
        requester: {
          select: {
            id: true,
            userId: true,
            role: true,
            user: { select: { name: true, email: true } },
          },
        },
        reviewer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
