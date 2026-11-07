import { ForbiddenException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { EnterpriseRole } from "@prisma/client";

export const ENTERPRISE_SUSPENDED_CODE = "ENTERPRISE_SUSPENDED";
export const ENTERPRISE_SUSPENDED_MESSAGE = "所属企业已被冻结，暂无法使用平台服务，请联系平台管理员";

export function assertEnterpriseNotSuspended(metadata: unknown): void {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).suspended === true) {
    throw new UnauthorizedException({
      statusCode: 401,
      code: ENTERPRISE_SUSPENDED_CODE,
      message: ENTERPRISE_SUSPENDED_MESSAGE,
    });
  }
}

/**
 * 请求级企业上下文。
 *
 * 多租户隔离的**唯一可信来源**：enterpriseId 只能由服务端从
 * userId 反查得出，绝不接受客户端传入 —— 否则改一个请求参数
 * 就能读写别家企业的数据。
 */
export interface EnterpriseContext {
  /** 所属企业 */
  enterpriseId: string;
  /** EnterpriseMember 主键（授权、申请等表引用它，不是 userId） */
  memberId: string;
  /** 企业内角色 */
  role: EnterpriseRole;
  /** 所属部门，未分配则为 null */
  departmentId: string | null;
}

@Injectable()
export class EnterpriseContextService {
  private readonly logger = new Logger(EnterpriseContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 解析用户的企业上下文。
   *
   * MVP 阶段一个用户只属于一家企业（不做多企业切换），故取第一条
   * membership。EnterpriseMember 是关联表而非 User 上的字段，所以将来
   * 放开多企业只需在此处按 enterpriseId 选择，无需改数据结构与调用方。
   *
   * @throws ForbiddenException 用户不属于任何企业
   */
  async resolve(userId: string): Promise<EnterpriseContext> {
    let member;
    try {
      member = await this.prisma.enterpriseMember.findFirst({
        where: { userId, enterprise: { status: "ACTIVE" } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          enterpriseId: true,
          role: true,
          departmentId: true,
          enterprise: { select: { metadata: true } },
        },
      });
    } catch {
      throw new ServiceUnavailableException("企业访问状态暂不可用");
    }

    if (!member) {
      throw new ForbiddenException("当前用户不属于任何企业，无法访问企业资源");
    }

    assertEnterpriseNotSuspended(member.enterprise?.metadata);

    return {
      enterpriseId: member.enterpriseId,
      memberId: member.id,
      role: member.role,
      departmentId: member.departmentId,
    };
  }

  /**
   * 解析企业上下文，用户无企业时返回 null 而不抛错。
   * 用于「登录后返回用户信息」这类允许无企业的场景。
   */
  async resolveOrNull(userId: string): Promise<EnterpriseContext | null> {
    try {
      return await this.resolve(userId);
    } catch (error) {
      if (error instanceof ForbiddenException) return null;
      throw error;
    }
  }

  /** 要求企业管理员角色（订阅、组织架构编辑等花钱或改结构的操作）。 */
  assertEnterpriseAdmin(ctx: EnterpriseContext): void {
    if (ctx.role !== "ENTERPRISE_ADMIN") {
      throw new ForbiddenException("仅企业管理员可执行此操作");
    }
  }

  /**
   * 要求可审批（跨部门调用申请等）。
   *
   * 本版只有企业管理员可审批 —— DEPT_MANAGER 暂按普通成员对待。
   * 该角色要名副其实需要「数据范围」这一整层（只能管本部门的人和实例，
   * 还要决定管一级部门能否管二级），后端尚未具备，故先不给它任何
   * 高于 MEMBER 的权限，避免出现「能审批却看不到本部门数据」的半成品状态。
   */
  assertCanApprove(ctx: EnterpriseContext): void {
    if (ctx.role !== "ENTERPRISE_ADMIN") {
      throw new ForbiddenException("仅企业管理员可审批");
    }
  }
}
