import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { PrismaService } from "../../prisma/prisma.service";
import { EnterpriseContextService } from "./enterprise-context.service";
import { EmployeeUsageService } from "./employee-usage.service";
import { PackageService } from "../digital-employee/package.service";
import {
  GrantBatchCreateDto,
  GrantBatchResult,
  GrantCreateDto,
  GrantView,
  MyEmployeeView,
  MemberGrantBatchCreateDto,
  MemberGrantBatchResult,
  MemberGrantCandidateQuery,
  MemberEmployeeGrantCandidate,
  MemberEmployeeGrantCandidatesResponse,
} from "shared";
import { withEmployeeAvatar } from '../../common/employee-avatar';

const employeeSummarySelect = {
  id: true, name: true, avatar: true, avatarStyle: true, avatarBindings: true, description: true, position: true, functionalCategory: true,
  bindings: {
    where: {
      enabled: true,
      capability: { status: 'APPROVED' },
    },
    select: { id: true, priority: true, capability: { select: {
      id: true, name: true, type: true, description: true,
    } } },
    orderBy: { priority: 'asc' },
  },
} as const;

@Injectable()
export class GrantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    private readonly packages: PackageService,
    private readonly usage: EmployeeUsageService,
  ) {}

  /**
   * 列出某雇佣关系的所有授权记录（管理员视角）。
   * 不过滤过期记录 —— 让管理员看到历史授权，前端标灰即可。
   */
  async listForSubscription(
    userId: string,
    subscriptionId: string,
  ): Promise<GrantView[]> {
    const context = await this.ctx.resolve(userId);
    await this.assertSubscriptionInEnterprise(subscriptionId, context.enterpriseId);

    const rows = await this.prisma.employeeGrant.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: "desc" },
      include: {
        department: { select: { id: true, name: true } },
        member: {
          select: {
            id: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      department: r.department,
      member: r.member
        ? {
            id: r.member.id,
            name: r.member.user.name,
            email: r.member.user.email,
          }
        : null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      expired: r.expiresAt !== null && r.expiresAt < now,
      createdAt: r.createdAt,
    }));
  }

  /**
   * 开通授权（企业管理员专用）。
   *
   * 授权对象二选一：部门或成员，DTO 层已用 refine 确保。
   * 已有相同授权 → 409（幂等意义上重复创建不如提示清楚）。
   */
  async create(
    userId: string,
    subscriptionId: string,
    dto: GrantCreateDto,
  ): Promise<GrantView> {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);

    const subscription = await this.assertSubscriptionInEnterprise(
      subscriptionId,
      context.enterpriseId,
    );

    if (subscription.status === "EXPIRED") {
      throw new BadRequestException("已过期的雇佣关系无法授权");
    }
    if (subscription.status === "TERMINATED") {
      throw new BadRequestException("已终止的雇佣关系无法授权");
    }
    if (subscription.endDate !== null && subscription.endDate <= new Date()) {
      throw new BadRequestException("已结束的雇佣关系无法授权");
    }

    if (dto.departmentId) {
      await this.assertDeptInEnterprise(
        dto.departmentId,
        context.enterpriseId,
      );
    }

    if (dto.memberId) {
      await this.assertMemberInEnterprise(
        dto.memberId,
        context.enterpriseId,
      );
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("授权到期时间必须晚于当前时间");
    }

    try {
      const grant = await this.prisma.employeeGrant.create({
        data: {
          subscriptionId,
          departmentId: dto.departmentId ?? null,
          memberId: dto.memberId ?? null,
          expiresAt,
        },
        include: {
          department: { select: { id: true, name: true } },
          member: {
            select: {
              id: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      });

      return {
        id: grant.id,
        department: grant.department,
        member: grant.member
          ? {
              id: grant.member.id,
              name: grant.member.user.name,
              email: grant.member.user.email,
            }
          : null,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        expired: false,
        createdAt: grant.createdAt,
      };
    } catch (e: unknown) {
      // Prisma P2002 = unique constraint violation
      if (
        e &&
        typeof e === "object" &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        throw new ConflictException("该授权已存在");
      }
      throw e;
    }
  }

  /** 一次为单个雇佣关系授权给多个成员或部门。 */
  async createBatch(
    userId: string,
    subscriptionId: string,
    dto: GrantBatchCreateDto,
  ): Promise<GrantBatchResult> {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);
    const target: GrantBatchResult["target"] = dto.memberIds ? "member" : "department";
    const targetIds = (dto.memberIds ?? dto.departmentIds)!;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("授权到期时间必须晚于当前时间");
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM enterprise_members WHERE id = ${context.memberId} FOR SHARE`;
      const admin = await tx.enterpriseMember.findUnique({
        where: { id: context.memberId },
        select: { id: true, enterpriseId: true, role: true },
      });
      if (!admin || admin.enterpriseId !== context.enterpriseId || admin.role !== "ENTERPRISE_ADMIN") {
        throw new ForbiddenException("仅企业管理员可操作");
      }
      // 串行化批次，同时兼容单条新增授权的外键 KEY SHARE 锁。
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${subscriptionId} FOR NO KEY UPDATE`;
      const subscription = await tx.subscription.findUnique({
        where: { id: subscriptionId },
        select: { id: true, enterpriseId: true, status: true, endDate: true },
      });
      if (!subscription || subscription.enterpriseId !== context.enterpriseId) {
        throw new NotFoundException(`雇佣关系 ${subscriptionId} 不存在`);
      }
      if (!["ACTIVE", "PAUSED"].includes(subscription.status) ||
          (subscription.endDate !== null && subscription.endDate <= new Date())) {
        throw new BadRequestException("当前雇佣关系无法授权");
      }
      if (expiresAt && expiresAt <= new Date()) {
        throw new BadRequestException("授权到期时间必须晚于当前时间");
      }

      const sortedTargetIds = [...targetIds].sort();
      if (target === "member") {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM enterprise_members WHERE id IN (${Prisma.join(sortedTargetIds)}) ORDER BY id FOR SHARE`);
      } else {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM departments WHERE id IN (${Prisma.join(sortedTargetIds)}) ORDER BY id FOR SHARE`);
      }
      const targets = target === "member"
        ? await tx.enterpriseMember.findMany({
            where: { id: { in: targetIds }, enterpriseId: context.enterpriseId },
            select: { id: true },
          })
        : await tx.department.findMany({
        where: { id: { in: targetIds }, enterpriseId: context.enterpriseId },
        select: { id: true },
      });
      if (targets.length !== targetIds.length) {
        throw new BadRequestException("存在不属于本企业的授权对象");
      }
      // 在读取有效期前锁住现有授权，避免并发收回使续期更新丢失目标。
      const targetColumn = target === "member" ? Prisma.sql`"memberId"` : Prisma.sql`"departmentId"`;
      await tx.$queryRaw(Prisma.sql`SELECT id FROM employee_grants WHERE "subscriptionId" = ${subscriptionId} AND ${targetColumn} IN (${Prisma.join(sortedTargetIds)}) ORDER BY id FOR UPDATE`);
      const existing = await tx.employeeGrant.findMany({
        where: target === "member"
          ? { subscriptionId, memberId: { in: targetIds } }
          : { subscriptionId, departmentId: { in: targetIds } },
        select: { id: true, expiresAt: true, memberId: true, departmentId: true },
      });
      type ExistingGrant = (typeof existing)[number];
      const byTarget = new Map<string, ExistingGrant>();
      for (const row of existing) byTarget.set(target === "member" ? row.memberId : row.departmentId, row);
      const createdIds: string[] = [];
      const renewedIds: string[] = [];
      const skippedIds: string[] = [];
      const now = new Date();

      for (const id of targetIds) {
        const current = byTarget.get(id);
        if (current) {
          const expired = current.expiresAt !== null && current.expiresAt <= now;
          if (expired && dto.renewExpired) {
            await tx.employeeGrant.update({ where: { id: current.id }, data: { expiresAt } });
            renewedIds.push(id);
          } else {
            skippedIds.push(id);
          }
          continue;
        }
        const inserted = await tx.employeeGrant.createMany({
          data: {
            subscriptionId,
            departmentId: target === "department" ? id : null,
            memberId: target === "member" ? id : null,
            expiresAt,
          },
          skipDuplicates: true,
        });
        if (inserted.count) createdIds.push(id);
        else skippedIds.push(id);
      }
      return { target, createdIds, renewedIds, skippedIds };
    }, { isolationLevel: "ReadCommitted" });
  }

  /**
   * 成员中心的授权候选列表：固定一个碳基员工，反向枚举本企业已雇佣的硅基员工。
   * 直接授权与部门覆盖分别返回，避免前端把部门权限误认为个人授权。
   */
  async listForMember(
    userId: string,
    memberId: string,
    query: MemberGrantCandidateQuery,
  ): Promise<MemberEmployeeGrantCandidatesResponse> {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);

    const member = await this.prisma.enterpriseMember.findUnique({
      where: { id: memberId },
      select: { id: true, enterpriseId: true, departmentId: true },
    });
    if (!member || member.enterpriseId !== context.enterpriseId) {
      throw new NotFoundException(`成员 ${memberId} 不存在`);
    }

    const statusWhere: Prisma.SubscriptionWhereInput["status"] = query.status === "history"
      ? { in: ["EXPIRED", "TERMINATED"] }
      : query.status === "grantable" || query.status === "granted"
        ? { in: ["ACTIVE", "PAUSED"] }
        : undefined;
    const keyword = query.keyword?.trim();
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        enterpriseId: context.enterpriseId,
        ...(statusWhere ? { status: statusWhere } : {}),
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword, mode: "insensitive" } },
                { employee: { name: { contains: keyword, mode: "insensitive" } } },
                { employee: { position: { contains: keyword, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        status: true,
        endDate: true,
        employee: { select: { id: true, name: true, avatar: true, position: true } },
        grants: {
          where: {
            OR: [
              { memberId },
              ...(member.departmentId ? [{ departmentId: member.departmentId }] : []),
            ],
          },
          select: { id: true, memberId: true, departmentId: true, expiresAt: true },
        },
      },
    });

    const now = new Date();
    let items = subscriptions.map((subscription) => {
      const direct = subscription.grants.find((grant) => grant.memberId === memberId) ?? null;
      const department = member.departmentId
        ? subscription.grants.find((grant) =>
            grant.departmentId === member.departmentId &&
            (grant.expiresAt === null || grant.expiresAt > now),
          )
        : null;
      const item: MemberEmployeeGrantCandidate = {
        subscriptionId: subscription.id,
        name: subscription.name ?? subscription.employee.name,
        status: subscription.status,
        endDate: subscription.endDate?.toISOString() ?? null,
        employee: subscription.employee,
        directGrant: direct
          ? {
              id: direct.id,
              expiresAt: direct.expiresAt?.toISOString() ?? null,
              expired: direct.expiresAt !== null && direct.expiresAt <= now,
            }
          : null,
        coveredByDepartment: Boolean(department),
      };
      return item;
    });

    if (query.status === "granted") {
      items = items.filter((item) => item.directGrant !== null);
    } else if (query.status === "grantable") {
      items = items.filter((item) => item.directGrant === null || item.directGrant.expired);
    }

    const total = items.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: items.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** 一次为单个碳基员工授权多个硅基员工。 */
  async createBatchForMember(
    userId: string,
    memberId: string,
    dto: MemberGrantBatchCreateDto,
  ): Promise<MemberGrantBatchResult> {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      throw new BadRequestException("授权到期时间必须晚于当前时间");
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM enterprise_members WHERE id = ${memberId} FOR UPDATE`;
      const member = await tx.enterpriseMember.findUnique({
        where: { id: memberId },
        select: { id: true, enterpriseId: true },
      });
      if (!member || member.enterpriseId !== context.enterpriseId) {
        throw new NotFoundException(`成员 ${memberId} 不存在`);
      }

      const sortedIds = [...dto.subscriptionIds].sort();
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM subscriptions WHERE id IN (${Prisma.join(sortedIds)}) ORDER BY id FOR NO KEY UPDATE`,
      );
      const subscriptions = await tx.subscription.findMany({
        where: { id: { in: dto.subscriptionIds }, enterpriseId: context.enterpriseId },
        select: { id: true, status: true, endDate: true },
      });
      if (subscriptions.length !== dto.subscriptionIds.length) {
        throw new NotFoundException("存在不属于本企业的雇佣关系");
      }
      const now = new Date();
      if (subscriptions.some((s) =>
        !["ACTIVE", "PAUSED"].includes(s.status) ||
        (s.endDate !== null && s.endDate <= now),
      )) {
        throw new BadRequestException("存在当前无法授权的雇佣关系");
      }

      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM employee_grants WHERE "memberId" = ${memberId} AND "subscriptionId" IN (${Prisma.join(sortedIds)}) ORDER BY id FOR UPDATE`,
      );
      const existing = await tx.employeeGrant.findMany({
        where: { memberId, subscriptionId: { in: dto.subscriptionIds } },
        select: { id: true, subscriptionId: true, expiresAt: true },
      });
      const bySubscription = new Map(existing.map((grant) => [grant.subscriptionId, grant]));
      const createdIds: string[] = [];
      const renewedSubscriptionIds: string[] = [];
      const skippedSubscriptionIds: string[] = [];

      for (const subscriptionId of dto.subscriptionIds) {
        const current = bySubscription.get(subscriptionId);
        if (current) {
          const expired = current.expiresAt !== null && current.expiresAt <= now;
          if (expired && dto.renewExpired) {
            await tx.employeeGrant.update({ where: { id: current.id }, data: { expiresAt } });
            renewedSubscriptionIds.push(subscriptionId);
          } else {
            skippedSubscriptionIds.push(subscriptionId);
          }
          continue;
        }
        // Use createMany(skipDuplicates) instead of catching P2002: in PostgreSQL
        // a statement error aborts the transaction even when the exception is caught.
        const inserted = await tx.employeeGrant.createMany({
          data: { subscriptionId, memberId, departmentId: null, expiresAt },
          skipDuplicates: true,
        });
        if (inserted.count === 0) {
          skippedSubscriptionIds.push(subscriptionId);
          continue;
        }
        const created = await tx.employeeGrant.findFirst({
          where: { subscriptionId, memberId },
          select: { id: true },
        });
        if (created) createdIds.push(created.id);
      }
      return { memberId, createdIds, renewedSubscriptionIds, skippedSubscriptionIds };
    }, { isolationLevel: "ReadCommitted" });
  }

  /**
   * 收回授权（企业管理员专用）。
   *
   * 注意：收回授权**不影响**雇佣关系状态，只删除这条授权记录。
   * 如果要让整个雇佣关系下线，用 PATCH /subscriptions/:id/status 改成 PAUSED。
   */
  async remove(userId: string, grantId: string): Promise<{ id: string }> {
    const context = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(context);

    // 先查再删，确保这条授权属于本企业
    const grant = await this.prisma.employeeGrant.findUnique({
      where: { id: grantId },
      include: {
        subscription: { select: { enterpriseId: true } },
      },
    });

    if (
      !grant ||
      grant.subscription.enterpriseId !== context.enterpriseId
    ) {
      throw new NotFoundException(`授权记录 ${grantId} 不存在`);
    }

    await this.prisma.employeeGrant.delete({ where: { id: grantId } });
    return { id: grantId };
  }

  /**
   * 「我的员工」—— 当前成员可用的雇佣关系（使用者视角）。
   *
   * 合并两条授权路径（OR 关系，决策已确认）：
   * 1. 直接授权给当前成员（memberId = 我的 EnterpriseMember.id）
   * 2. 授权给我所在部门（departmentId = 我的 departmentId）
   *
   * 过滤条件：
   * - 雇佣关系处于 ACTIVE 状态（暂停/过期的即使授权也不能用）
   * - 授权未过期（expiresAt 为空或 > now）
   *
   * 同一雇佣关系如果两条路径都命中，只返回一条，直接授权优先。
   */
  async myEmployees(userId: string): Promise<MyEmployeeView[]> {
    const context = await this.ctx.resolve(userId);
    const now = new Date();

    // 直接授权给我个人
    const directGrants = await this.prisma.employeeGrant.findMany({
      where: {
        memberId: context.memberId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        subscription: {
          enterpriseId: context.enterpriseId,
          status: "ACTIVE",
        },
      },
      include: {
        subscription: {
          include: {
            employee: {
              select: employeeSummarySelect,
            },
          },
        },
      },
    });

    // 授权给我所在部门
    const deptGrants =
      context.departmentId
        ? await this.prisma.employeeGrant.findMany({
            where: {
              departmentId: context.departmentId,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              subscription: {
                enterpriseId: context.enterpriseId,
                status: "ACTIVE",
              },
            },
            include: {
              subscription: {
                include: {
                  employee: {
                    select: employeeSummarySelect,
                  },
                },
              },
            },
          })
        : [];

    // 去重，直接授权优先
    const seen = new Map<string, MyEmployeeView>();

    for (const g of directGrants) {
      const sub = g.subscription;
      seen.set(sub.id, {
        subscriptionId: sub.id,
        name: sub.name ?? sub.employee.name,
        templateVersion: sub.templateVersion,
        employee: withEmployeeAvatar(sub.employee),
        department: null,
        grantSource: "DIRECT",
        expiresAt: g.expiresAt?.toISOString() ?? null,
      });
    }

    for (const g of deptGrants) {
      const sub = g.subscription;
      // 已有直接授权的不覆盖
      if (!seen.has(sub.id)) {
        seen.set(sub.id, {
          subscriptionId: sub.id,
          name: sub.name ?? sub.employee.name,
          templateVersion: sub.templateVersion,
          employee: withEmployeeAvatar(sub.employee),
          department: null,
          grantSource: "DEPARTMENT",
          expiresAt: g.expiresAt?.toISOString() ?? null,
        });
      }
    }

    const rows = Array.from(seen.values());

    // 标注哪些模板有包可下 —— 否则前端只能盲点下载按钮，
    // 运营还没上传包时用户会拿到 404 却不知道为什么
    const employeeIds = [...new Set(rows.map((r) => r.employee.id))];
    const withPackage = await this.packages.employeeIdsWithPackage(employeeIds);
    for (const r of rows) {
      r.packageAvailable = withPackage.has(r.employee.id);
    }

    // 附上每个员工的剩余赠送算力余额。使用者最关心「这个员工还能用多少钱」，
    // 让他们为此再跳一次算力中心是没必要的。
    await this.attachGiftBalances(rows);

    // 附上使用情况（在用人数 / 已授权人数 / 上次使用 / 本月消费 / 成功率）。
    // 6 条查询覆盖全部卡片，与员工数无关。
    const usageBySubscription = await this.usage.forSubscriptions(
      context.enterpriseId,
      rows.map((r) => ({
        subscriptionId: r.subscriptionId,
        employeeId: r.employee.id,
      })),
    );
    for (const row of rows) {
      row.usage = usageBySubscription.get(row.subscriptionId);
    }

    // 默认按「最近用过的在前」返回，从没用过的排在末尾（按名称）。
    // 前端的「最近使用」排序直接沿用这个顺序 —— 排序依据只有后端有
    // （lastUsedAt 是聚合出来的），放前端就得再造一次口径。
    rows.sort((a, b) => {
      const at = a.usage?.lastUsedAt ?? null;
      const bt = b.usage?.lastUsedAt ?? null;
      if (at && bt) return bt.localeCompare(at);
      if (at) return -1;
      if (bt) return 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });

    return rows;
  }

  /**
   * 批量补上赠送余额。一次查询覆盖所有订阅，避免按行 N+1。
   *
   * 只有 ACTIVE 的额度算作剩余：EXPIRED（订阅已终止）的余额花不掉，
   * 显示成剩余会让使用者以为还有钱。
   */
  private async attachGiftBalances(rows: MyEmployeeView[]): Promise<void> {
    if (rows.length === 0) return;

    const credits = await this.prisma.subscriptionCredit.findMany({
      where: { subscriptionId: { in: rows.map((r) => r.subscriptionId) } },
      select: {
        subscriptionId: true,
        grantedCNY: true,
        usedCNY: true,
        status: true,
      },
    });
    const bySubscription = new Map(credits.map((c) => [c.subscriptionId, c]));

    for (const row of rows) {
      const credit = bySubscription.get(row.subscriptionId);
      if (!credit) {
        row.giftGrantedCNY = '0.00';
        row.giftUsedCNY = '0.00';
        row.giftRemainingCNY = '0.00';
        row.giftStatus = 'NONE';
        continue;
      }
      row.giftGrantedCNY = credit.grantedCNY.toFixed(2);
      row.giftUsedCNY = credit.usedCNY.toFixed(2);
      row.giftRemainingCNY =
        credit.status === 'ACTIVE'
          ? Decimal.max(0, credit.grantedCNY.sub(credit.usedCNY)).toFixed(2)
          : '0.00';
      row.giftStatus = credit.status as MyEmployeeView['giftStatus'];
    }
  }

  // ── 内部校验 ──────────────────────────────────────────────────────────────

  private async assertSubscriptionInEnterprise(
    subscriptionId: string,
    enterpriseId: string,
  ) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, enterpriseId: true, status: true, endDate: true },
    });
    if (
      !sub ||
      sub.enterpriseId !== enterpriseId ||
      (sub.endDate !== null && sub.endDate <= new Date())
    ) {
      throw new NotFoundException(`雇佣关系 ${subscriptionId} 不存在`);
    }
    return sub;
  }

  private async assertDeptInEnterprise(id: string, enterpriseId: string) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, enterpriseId: true },
    });
    if (!dept || dept.enterpriseId !== enterpriseId) {
      throw new NotFoundException(`部门 ${id} 不存在`);
    }
  }

  private async assertMemberInEnterprise(id: string, enterpriseId: string) {
    const member = await this.prisma.enterpriseMember.findUnique({
      where: { id },
      select: { id: true, enterpriseId: true },
    });
    if (!member || member.enterpriseId !== enterpriseId) {
      throw new NotFoundException(`成员 ${id} 不存在`);
    }
  }
}
