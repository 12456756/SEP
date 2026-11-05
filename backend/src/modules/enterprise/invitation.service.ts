import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import * as crypto from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  INVITATION_EXPIRES_DAYS,
  InvitationCreateDto,
  InvitationEmailStatusValue,
  InvitationStatusValue,
} from "shared";
import type { InvitationNextAction } from "shared/invitation-routing";
import { EnterpriseContextService } from "./enterprise-context.service";
import { MailService } from "../mail/mail.service";

/** 邀请 token 字节数。32 字节 = 256 位 CSPRNG 熵，不可枚举。 */
const TOKEN_BYTES = 32;
const RESEND_COOLDOWN_MS = 60_000;
const SAFE_MAIL_ERROR = "邮件发送失败，请稍后重试";

@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: EnterpriseContextService,
    @Optional() private readonly mail?: MailService,
  ) {}

  /**
   * 生成邀请 token 的存储摘要。
   *
   * 用 SHA-256 而非 bcrypt，与 EnterpriseApiKey 的做法不同 ——
   * 校验邀请时只有 token、没有 email/企业上下文，必须能「由 token 直接定位记录」。
   * bcrypt 加盐后同一输入哈希不同，建不了唯一索引，只能全表扫描逐条 compare。
   * token 是 CSPRNG 随机值而非用户口令，无字典可猜，不需要慢哈希抗爆破。
   */
  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private invitationUrl(token: string): string {
    const base = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new BadRequestException("WEB_BASE_URL 配置无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    ) {
      throw new BadRequestException("WEB_BASE_URL 配置无效");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/join`;
    url.search = "";
    url.hash = "";
    url.searchParams.set("token", token);
    return url.toString();
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "P2034") {
        throw new ConflictException("邀请状态冲突，请刷新后重试");
      }
      throw error;
    }
  }

  private async checkEmailCooldown(tx: Prisma.TransactionClient, enterpriseId: string, email: string, now: Date) {
    const recent = await tx.enterpriseInvitation.findFirst({
      where: { enterpriseId, email, emailLastAttemptAt: { gt: new Date(now.getTime() - RESEND_COOLDOWN_MS) } },
      orderBy: { emailLastAttemptAt: "desc" },
      select: { emailLastAttemptAt: true },
    });
    if (recent?.emailLastAttemptAt) {
      const seconds = Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - recent.emailLastAttemptAt.getTime())) / 1000);
      if (seconds > 0) throw new ConflictException(`请等待 ${seconds} 秒后再发送邀请邮件`);
    }
  }

  private async deliver(invitation: any, token: string, invitationUrl: string, enterpriseName: string) {
    let emailStatus: InvitationEmailStatusValue = "NOT_CONFIGURED";
    let emailError: string | null = null;
    let emailSentAt: Date | null = null;
    try {
      emailStatus = this.mail
        ? await this.mail.sendEnterpriseInvitation({
            to: invitation.email,
            invitationUrl,
            enterpriseName,
          })
        : "NOT_CONFIGURED";
      if (emailStatus === "SENT") emailSentAt = new Date();
    } catch {
      emailStatus = "FAILED";
      emailError = SAFE_MAIL_ERROR;
    }

    await this.prisma.enterpriseInvitation.updateMany({
      where: { id: invitation.id, tokenHash: this.hashToken(token), emailStatus: "SENDING" },
      data: { emailStatus, emailSentAt, emailError },
    });
    return { ...invitation, emailStatus, emailLastAttemptAt: invitation.emailLastAttemptAt, emailSentAt, emailError, token, invitationUrl };
  }

  /**
   * 创建邀请，返回一次性明文 token。
   *
   * 明文只在本次响应里出现，库里只存摘要 —— 邀请链接等同于一次性登录凭证，
   * 明文入库意味着数据库泄露即可冒充任意被邀请人。
   *
   * 邮件发送失败不回滚邀请，响应仍返回一次性 token，便于管理员在邮件
   * Provider 暂不可用时安全地转达邀请链接。
   */
  async create(userId: string, dto: InvitationCreateDto) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);

    if (dto.departmentId) {
      await this.assertDepartmentInEnterprise(
        dto.departmentId,
        ctx.enterpriseId,
      );
    }

    const email = dto.email.toLowerCase().trim();

    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const invitationUrl = this.invitationUrl(token);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + INVITATION_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    );
    const invitation = await this.serializable(async (tx) => {
      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${ctx.enterpriseId} FOR UPDATE`;
      if (enterprises[0]?.status !== "ACTIVE") throw new ConflictException("企业已关闭，无法发送邀请");
      await this.checkEmailCooldown(tx, ctx.enterpriseId, email, now);
      const existingMember = await tx.enterpriseMember.findFirst({
        where: { enterpriseId: ctx.enterpriseId, user: { email } },
        select: { id: true },
      });
      if (existingMember) throw new ConflictException("该邮箱已是本企业成员");
      await tx.enterpriseInvitation.updateMany({
        where: { enterpriseId: ctx.enterpriseId, email, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      return tx.enterpriseInvitation.create({
        data: {
          enterpriseId: ctx.enterpriseId,
          email,
          tokenHash: this.hashToken(token),
          role: dto.role,
          departmentId: dto.departmentId ?? null,
          position: dto.position ?? null,
          expiresAt,
          invitedBy: userId,
          emailStatus: "SENDING",
          emailLastAttemptAt: now,
        },
        select: {
          id: true, email: true, role: true, position: true, status: true,
          expiresAt: true, createdAt: true, emailStatus: true,
          emailLastAttemptAt: true, emailSentAt: true, emailError: true,
          department: { select: { id: true, name: true } },
        },
      });
    });

    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: ctx.enterpriseId },
      select: { name: true },
    });
    return this.deliver(invitation, token, invitationUrl, enterprise?.name ?? ctx.enterpriseId);
  }

  async resend(userId: string, id: string) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);
    const now = new Date();
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const invitationUrl = this.invitationUrl(token);
    const expiresAt = new Date(now.getTime() + INVITATION_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    const invitation = await this.serializable(async (tx) => {
      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${ctx.enterpriseId} FOR UPDATE`;
      if (enterprises[0]?.status !== "ACTIVE") throw new ConflictException("企业已关闭，无法发送邀请");
      const current = await tx.enterpriseInvitation.findUnique({
        where: { id },
        select: { id: true, enterpriseId: true, email: true, status: true, tokenHash: true },
      });
      if (!current || current.enterpriseId !== ctx.enterpriseId) throw new NotFoundException(`邀请 ${id} 不存在`);
      if (current.status === "ACCEPTED") throw new ConflictException("该邀请已被接受，无法重发");
      await this.checkEmailCooldown(tx, current.enterpriseId, current.email, now);
      const member = await tx.enterpriseMember.findFirst({
        where: { enterpriseId: ctx.enterpriseId, user: { email: current.email } },
        select: { id: true },
      });
      if (member) throw new ConflictException("该邮箱已是本企业成员");
      await tx.enterpriseInvitation.updateMany({
        where: { enterpriseId: ctx.enterpriseId, email: current.email, status: "PENDING", id: { not: id } },
        data: { status: "REVOKED" },
      });
      const claimed = await tx.enterpriseInvitation.updateMany({
        where: { id, enterpriseId: ctx.enterpriseId, status: current.status, tokenHash: current.tokenHash },
        data: {
          tokenHash: this.hashToken(token), status: "PENDING", expiresAt,
          emailStatus: "SENDING", emailLastAttemptAt: now, emailSentAt: null, emailError: null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException("邀请状态已变化，请刷新后重试");
      return tx.enterpriseInvitation.findUniqueOrThrow({
        where: { id },
        select: {
          id: true, enterpriseId: true, email: true, role: true, position: true, status: true,
          expiresAt: true, createdAt: true, emailStatus: true, emailLastAttemptAt: true,
          emailSentAt: true, emailError: true, department: { select: { id: true, name: true } },
        },
      });
    });
    const enterprise = await this.prisma.enterprise.findUnique({
      where: { id: ctx.enterpriseId }, select: { name: true },
    });
    return this.deliver(invitation, token, invitationUrl, enterprise?.name ?? ctx.enterpriseId);
  }

  /** 本企业邀请列表。可按状态过滤并分页。顺带把已过期的 PENDING 收敛为 EXPIRED。 */
  async list(
    userId: string,
    status?: InvitationStatusValue,
    options?: {
      page?: number;
      pageSize?: number;
      search?: string;
      role?: 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER';
      departmentId?: string;
    },
  ) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);

    await this.expireStale(ctx.enterpriseId);

    const page = Number.isInteger(options?.page) && (options?.page as number) > 0
      ? (options.page as number)
      : 1;
    const pageSize = Number.isInteger(options?.pageSize) && (options?.pageSize as number) > 0
      ? Math.min(options.pageSize as number, 100)
      : 20;
    const search = options?.search?.trim();
    const where = {
      enterpriseId: ctx.enterpriseId,
      ...(status && { status }),
      ...(options?.role && { role: options.role }),
      ...(options?.departmentId && { departmentId: options.departmentId }),
      ...(search ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { position: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
    };

    if (!options) {
      return this.prisma.enterpriseInvitation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          position: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          acceptedAt: true,
          emailStatus: true,
          emailLastAttemptAt: true,
          emailSentAt: true,
          emailError: true,
          department: { select: { id: true, name: true } },
        },
      });
    }

    const [items, total] = await Promise.all([
      this.prisma.enterpriseInvitation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          role: true,
          position: true,
          status: true,
          expiresAt: true,
          createdAt: true,
          acceptedAt: true,
          emailStatus: true,
          emailLastAttemptAt: true,
          emailSentAt: true,
          emailError: true,
          department: { select: { id: true, name: true } },
        },
      }),
      this.prisma.enterpriseInvitation.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  /** 撤回邀请。已接受的不可撤回 —— 成员关系已生成，应走移出企业。 */
  async revoke(userId: string, id: string) {
    const ctx = await this.ctx.resolve(userId);
    this.ctx.assertEnterpriseAdmin(ctx);

    const invitation = await this.prisma.enterpriseInvitation.findUnique({
      where: { id },
      select: { id: true, enterpriseId: true, status: true, tokenHash: true },
    });
    // 越权返回 404，不泄漏该 id 是否存在
    if (!invitation || invitation.enterpriseId !== ctx.enterpriseId) {
      throw new NotFoundException(`邀请 ${id} 不存在`);
    }
    if (invitation.status === "ACCEPTED") {
      throw new ConflictException(
        "该邀请已被接受，请到成员管理中移出该成员",
      );
    }
    if (invitation.status !== "PENDING") {
      throw new ConflictException("该邀请已失效，无需撤回");
    }

    const revoked = await this.prisma.enterpriseInvitation.updateMany({
      where: { id, tokenHash: invitation.tokenHash, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    if (revoked.count !== 1) throw new ConflictException("邀请状态已变化，请刷新后重试");

    return { success: true };
  }

  /**
   * 校验 token，返回邀请详情供受邀注册页展示（企业名、角色、部门）。
   *
   * 公开接口（无需登录）—— 被邀请人此时还没有账号。
   * 故只返回展示所需字段，不返回 email 之外的任何成员信息，
   * 避免 token 泄露时被用来探查企业组织结构。
   */
  async verifyToken(token: string) {
    const invitation = await this.prisma.enterpriseInvitation.findUnique({
      where: { tokenHash: this.hashToken(token) },
      select: {
        id: true,
        email: true,
        role: true,
        position: true,
        status: true,
        expiresAt: true,
        enterprise: { select: { id: true, name: true, logo: true, status: true } },
        department: { select: { id: true, name: true } },
      },
    });

    // 统一用 400 + 同一措辞，不区分「不存在」与「已失效」——
    // 区分会让攻击者能用响应差异枚举有效 token
    if (!invitation || invitation.status !== "PENDING" || invitation.enterprise.status !== "ACTIVE") {
      throw new BadRequestException("邀请链接无效或已失效");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.prisma.enterpriseInvitation.updateMany({
        where: { id: invitation.id, tokenHash: this.hashToken(token), status: "PENDING", expiresAt: { lte: new Date() } },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("邀请链接无效或已失效");
    }

    const user = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { status: true },
    });
    const nextAction: InvitationNextAction = !user
      ? "REGISTER"
      : user.status === "ACTIVE"
        ? "LOGIN"
        : "CONTACT_SUPPORT";

    return { ...invitation, nextAction };
  }

  /**
   * 按 token 取出可用邀请的完整记录，供受邀注册流程内部使用。
   *
   * 与 verifyToken 的区别：这里返回写入 EnterpriseMember 所需的全部字段
   * （enterpriseId / departmentId / role），不做展示裁剪。
   */
  async findUsableByToken(token: string) {
    const invitation = await this.prisma.enterpriseInvitation.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { enterprise: { select: { status: true } } },
    });

    if (!invitation || invitation.status !== "PENDING" || invitation.enterprise.status !== "ACTIVE") {
      throw new BadRequestException("邀请链接无效或已失效");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.prisma.enterpriseInvitation.updateMany({
        where: { id: invitation.id, tokenHash: this.hashToken(token), status: "PENDING", expiresAt: { lte: new Date() } },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("邀请链接无效或已失效");
    }

    return invitation;
  }

  /**
   * 已登录用户接受邀请，加入企业。
   *
   * 补上 registerByInvitation 的另一半：那条路径只服务「还没有账号」的人，
   * 已有账号者会被它拒绝并提示"请登录后再接受邀请" —— 指的就是这里。
   *
   * 不走企业上下文：接受者此刻很可能**无企业归属**，
   * EnterpriseContextService.resolve 会对其抛 403。
   */
  async acceptByUser(userId: string, token: string) {
    const invitation = await this.findUsableByToken(token);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 与创建企业和第三方邀请共用用户行锁；ReadCommitted 确保锁后读取最新归属。
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, status: true, email: true, memberships: { select: { enterpriseId: true } } },
        });
        if (!user) throw new NotFoundException("用户不存在");
        if (user.status !== "ACTIVE") throw new ConflictException("账号当前不可加入企业，请联系平台");
        if (user.email.toLowerCase() !== invitation.email) {
          throw new BadRequestException("该邀请不是发给当前登录账号的");
        }
        if (user.memberships.some((m) => m.enterpriseId === invitation.enterpriseId)) {
          throw new ConflictException("你已是该企业成员");
        }
        if (user.memberships.length > 0) {
          throw new ConflictException("你已归属其他企业，请先在个人设置中退出当前企业，再接受本邀请");
        }
        const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${invitation.enterpriseId} FOR UPDATE`;
        if (enterprises[0]?.status !== "ACTIVE") throw new ConflictException("企业已关闭，无法接受邀请");
        const member = await tx.enterpriseMember.create({
          data: {
            userId: user.id,
            enterpriseId: invitation.enterpriseId,
            role: invitation.role,
            departmentId: invitation.departmentId,
            position: invitation.position,
          },
          select: {
            id: true,
            role: true,
            position: true,
            department: { select: { id: true, name: true } },
          },
        });

        // 条件消费失败会回滚上面的成员写入，防止重发、撤销或过期后的旧链接入职。
        const claimed = await tx.enterpriseInvitation.updateMany({
          where: {
            id: invitation.id,
            tokenHash: invitation.tokenHash,
            status: "PENDING",
            expiresAt: { gt: new Date() },
          },
          data: { status: "ACCEPTED", acceptedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new ConflictException("该邀请已被使用");
        }

        const enterprise = await tx.enterprise.findUniqueOrThrow({
          where: { id: invitation.enterpriseId },
          select: { id: true, name: true },
        });

        return { member, enterprise };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error.code === "P2034" || error.code === "P2002")) {
        throw new ConflictException("邀请状态冲突，请刷新后重试");
      }
      throw error;
    }
  }

  /** 把过了期的 PENDING 收敛为 EXPIRED，让列表状态与实际一致。 */
  private async expireStale(enterpriseId: string) {
    await this.prisma.enterpriseInvitation.updateMany({
      where: {
        enterpriseId,
        status: "PENDING",
        expiresAt: { lte: new Date() },
      },
      data: { status: "EXPIRED" },
    });
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
}
