import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MemberCreateDto, MemberUpdateDto, knowledgeMemberDisplay, type KnowledgeGrantCandidateQuery } from "shared";
import { EnterpriseContextService } from "./enterprise-context.service";
import { InvitationService } from "./invitation.service";

@Injectable()
export class MemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    @Optional() private readonly invitations?: InvitationService,
  ) {}

  /** 列出本企业成员。可按部门过滤并分页。 */
  async list(
    userId: string,
    departmentId?: string,
    options?: {
      page?: number;
      pageSize?: number;
      search?: string;
      role?: 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER';
    },
  ) {
    const ctx = await this.ctx.resolve(userId);
    const page = Number.isInteger(options?.page) && (options?.page as number) > 0
      ? (options.page as number)
      : 1;
    const pageSize = Number.isInteger(options?.pageSize) && (options?.pageSize as number) > 0
      ? Math.min(options.pageSize as number, 100)
      : 20;
    const search = options?.search?.trim();
    const where = {
      enterpriseId: ctx.enterpriseId,
      ...(departmentId && { departmentId }),
      ...(options?.role && { role: options.role }),
      ...(search ? {
        OR: [
          { user: { name: { contains: search, mode: 'insensitive' as const } } },
          { user: { email: { contains: search, mode: 'insensitive' as const } } },
          { position: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    if (!options) {
      return this.prisma.enterpriseMember.findMany({
        where,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          position: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, avatar: true } },
          department: {
            select: {
              id: true,
              name: true,
              parent: { select: { id: true, name: true } },
            },
          },
        },
      });
    }

    const [items, total] = await Promise.all([
      this.prisma.enterpriseMember.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          role: true,
          position: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, avatar: true } },
          department: {
            select: {
              id: true,
              name: true,
              parent: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.enterpriseMember.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  /** Administrator-only safe projection for knowledge grants; legacy list remains unchanged. */
  async listKnowledgeGrantCandidates(userId: string, query: KnowledgeGrantCandidateQuery) {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);
    const where = { enterpriseId: context.enterpriseId,
      ...(query.keyword ? { OR: [
        { user: { name: { contains: query.keyword, mode: 'insensitive' as const } } },
        { position: { contains: query.keyword, mode: 'insensitive' as const } },
      ] } : {}) };
    const [members, total] = await Promise.all([
      this.prisma.enterpriseMember.findMany({ where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        select: { id: true, position: true, user: { select: { name: true, avatar: true } },
          department: { select: { name: true } } } }),
      this.prisma.enterpriseMember.count({ where }),
    ]);
    return { items: members.map(knowledgeMemberDisplay), page: query.page, pageSize: query.pageSize, total };
  }

  /**
   * 添加成员统一转为邀请。
   *
   * 保留这个 service 方法是为了兼容旧的 service 调用方，但正式路径
   * 不再创建 User、不再接触管理员提交的 password，所有账号创建与一次性
   * token 都由 InvitationService/AuthService 负责。
   */
  async create(userId: string, dto: MemberCreateDto) {
    if (!this.invitations) {
      throw new InternalServerErrorException("邀请服务未配置");
    }
    return this.invitations.create(userId, {
      email: dto.email,
      role: dto.role,
      departmentId: dto.departmentId,
      position: dto.position,
    });
  }

  /** 修改成员角色 / 调岗。 */
  async update(userId: string, memberId: string, dto: MemberUpdateDto) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);

    const member = await this.assertMemberInEnterprise(
      memberId,
      ctx.enterpriseId,
    );

    if (dto.departmentId) {
      await this.assertDepartmentInEnterprise(dto.departmentId, ctx.enterpriseId);
    }

    // 不允许把自己降级 —— 否则管理员可一步操作把自己锁在门外
    if (
      member.id === ctx.memberId &&
      dto.role !== undefined &&
      dto.role !== "ENTERPRISE_ADMIN"
    ) {
      throw new BadRequestException(
        "不能降低自己的角色，请由另一位企业管理员操作",
      );
    }

    if (dto.role !== undefined && dto.role !== "ENTERPRISE_ADMIN") {
      await this.assertNotLastAdmin(member, ctx.enterpriseId);
    }

    return this.prisma.enterpriseMember.update({
      where: { id: memberId },
      data: {
        ...(dto.role !== undefined && { role: dto.role }),
        ...(dto.departmentId !== undefined && {
          departmentId: dto.departmentId,
        }),
        ...(dto.position !== undefined && { position: dto.position }),
      },
      select: {
        id: true,
        role: true,
        position: true,
        user: { select: { id: true, email: true, name: true } },
        department: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * 移出企业（离职）。
   *
   * 分界线是「个人持有的东西」与「企业侧的沉淀」：
   *
   *   回收（跟人走的授权，必须立即失效）
   *     · EmployeeGrant 中 memberId = 本人的记录 —— 个人席位
   *     · PENDING 的 SubscriptionRequest —— 非成员的申请无从批准，置为 CANCELED
   *     · 其所主管的部门 —— leaderId 置空，并在响应里报出待重新指派
   *
   *   保留（留在企业，这正是会议强调的"员工走了，东西全部沉淀在我这里"）
   *     · 已审批的 SubscriptionRequest 及审批结论 —— 审计链
   *     · 知识库、文档、技能覆写 —— 挂在 Enterprise 上，与成员身份无关
   *     · 会话与工作记录 —— 挂在 User 上，User 不删
   *
   * 为什么硬删 EnterpriseMember 而不是标记 LEFT：
   * 软删要求每个读路径都记得过滤 status，漏一处就是"已离职的人还能用"。
   * 最危险的是 EnterpriseContextService.resolve() —— 那里漏过滤等于权限失效。
   * 且 @@unique([userId, enterpriseId]) 会让残留行挡住此人日后重新入职。
   * 身份用硬删（边界清晰），沉淀靠 SetNull + 快照保住，比软删更难出错。
   *
   * 注意 User 一律保留：他可能还属于别家企业，且离职后应能凭原账号
   * 接受新邀请（见 create 的分支②）。
   */
  async remove(userId: string, memberId: string) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);

    const member = await this.loadForOffboard(memberId);
    // 越权返回 404，不泄漏该 id 是否存在
    if (!member || member.enterpriseId !== ctx.enterpriseId) {
      throw new NotFoundException(`成员 ${memberId} 不存在`);
    }

    if (member.id === ctx.memberId) {
      throw new BadRequestException("不能移除自己");
    }
    await this.assertNotLastAdmin(member, ctx.enterpriseId);

    return this.offboard(member);
  }

  /**
   * 主动离职。
   *
   * 存在的意义是给「原公司已经不管这事了」兜底 —— 若只有管理员移除
   * 这一个入口，一个人的账号会被前雇主的不作为永久卡住，既进不了新企业
   * 也用不了原企业。
   *
   * MVP 不走审批：需要原企业同意才能离职，等于把上面那个死锁又搬回来了。
   * 回收的东西全在企业侧（席位、部门归属），离职不带走任何数据，
   * 所以无需审批也不会造成企业损失。
   *
   * 处置逻辑与管理员移除**完全共用** offboard()，不另写一套 ——
   * 两套回收逻辑迟早漂移，届时一个入口回收席位、另一个漏掉，
   * 会留下已离职却仍占着授权的幽灵成员。
   */
  async leaveEnterprise(userId: string) {
    // 这里必须用 resolveOrNull：resolve() 对无归属用户抛 403，
    // 会把"你本来就没有企业"报成"你无权操作"，让人无从下手。
    const ctx = await this.ctx.resolveOrNull(userId);
    if (!ctx) {
      throw new BadRequestException("你当前未归属任何企业");
    }

    const member = await this.loadForOffboard(ctx.memberId);
    if (!member) {
      throw new NotFoundException("成员记录不存在");
    }

    // 唯一管理员不得离职：走掉之后企业永久失去管理能力，
    // 没人能加成员、建部门、订阅，也没人能把自己提回管理员。
    // 与 remove() 的约束保持一致，只是措辞针对"本人主动"。
    await this.assertNotLastAdmin(
      member,
      ctx.enterpriseId,
      "你是本企业唯一的管理员，请先指定其他管理员，再办理离职",
    );

    const result = await this.offboard(member);
    return {
      ...result,
      enterprise: { id: member.enterprise.id, name: member.enterprise.name },
    };
  }

  // ── 离职处置（管理员移除与主动离职共用）────────────────────────────────

  private async loadForOffboard(memberId: string) {
    return this.prisma.enterpriseMember.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        enterpriseId: true,
        role: true,
        user: { select: { id: true, email: true, name: true } },
        enterprise: { select: { id: true, name: true } },
        ledDepartments: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * 执行离职处置。调用方负责鉴权与前置校验，这里只管数据处置。
   *
   * 全程单事务：半途失败若已提交，会留下"授权已回收、人还在企业"
   * 这种谁都看不出问题的中间态。
   */
  private async offboard(member: {
    id: string;
    user: { email: string; name: string | null };
    ledDepartments: { id: string; name: string }[];
  }) {
    const memberId = member.id;

    return this.prisma.$transaction(async (tx) => {
      // 与知识库授权时的成员共享锁串行，避免枚举授权后又被并发新增。
      await tx.$queryRaw`SELECT id FROM enterprise_members WHERE id = ${memberId} FOR UPDATE`;
      const knowledgeGrants = await tx.knowledgeMemberGrant.findMany({
        where: { memberId }, select: { knowledgeBaseId: true },
      });
      // 待审批的使用申请随人一起终结 —— 留着会让审批人批出一条
      // requesterId 为空的悬空申请。已审批的保留：requesterId 已被
      // SetNull 置空，但 requesterEmail/Name 快照在创建时已写入，审计链不断。
      const canceled = await tx.subscriptionRequest.updateMany({
        where: { requesterId: memberId, status: "PENDING" },
        data: { status: "CANCELED" },
      });

      // 只回收授权给「本人」的席位。
      // 授权给部门的记录（departmentId 非空、memberId 为空）不动 ——
      // 那属于部门，不随离职人员消失。
      const reclaimed = await tx.employeeGrant.deleteMany({
        where: { memberId },
      });

      // leaderId 是 SetNull，删除时数据库会自动置空。
      // 这里不重复置空，只把名单带进响应 —— 部门无主是需要管理员
      // 补动作的状态，静默处理会留下没人负责的部门。
      await tx.enterpriseMember.delete({ where: { id: memberId } });
      const knowledgeBaseIds = [...new Set(knowledgeGrants.map((grant) => grant.knowledgeBaseId))];
      if (knowledgeBaseIds.length) {
        await tx.knowledgeBase.updateMany({
          where: { id: { in: knowledgeBaseIds } }, data: { revision: { increment: 1 } },
        });
      }

      return {
        id: memberId,
        removed: true,
        reclaimedGrants: reclaimed.count,
        canceledRequests: canceled.count,
        vacatedDepartments: member.ledDepartments,
      };
    });
  }

  // ── 内部校验 ──────────────────────────────────────────────────────────────

  private async assertMemberInEnterprise(id: string, enterpriseId: string) {
    const member = await this.prisma.enterpriseMember.findUnique({
      where: { id },
      select: { id: true, enterpriseId: true, role: true },
    });
    // 越权返回 404，不泄漏该 id 是否存在
    if (!member || member.enterpriseId !== enterpriseId) {
      throw new NotFoundException(`成员 ${id} 不存在`);
    }
    return member;
  }

  private async assertDepartmentInEnterprise(
    id: string,
    enterpriseId: string,
  ) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, enterpriseId: true },
    });
    if (!dept || dept.enterpriseId !== enterpriseId) {
      throw new NotFoundException(`部门 ${id} 不存在`);
    }
  }

  /**
   * 保证企业至少留有一名管理员。
   *
   * 若允许移除/降级最后一位管理员，企业将永久失去管理能力：
   * 没人能加成员、建部门、订阅员工，也没人能把自己提回管理员 ——
   * 只能改数据库救回。
   */
  private async assertNotLastAdmin(
    member: { id: string; role: string },
    enterpriseId: string,
    message = "企业至少需要保留一名管理员，请先指定其他管理员",
  ) {
    if (member.role !== "ENTERPRISE_ADMIN") return;

    const adminCount = await this.prisma.enterpriseMember.count({
      where: { enterpriseId, role: "ENTERPRISE_ADMIN" },
    });
    if (adminCount <= 1) {
      throw new ConflictException(message);
    }
  }
}
