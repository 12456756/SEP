import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, UnauthorizedException, Optional } from '@nestjs/common';
import { ComputeIntegrationService } from '../compute-integration/compute-integration.service';
import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AccountClosureEligibility, AccountClosureRequestDto, AccountClosureResult } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuthRateLimitService } from './auth-rate-limit.service';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AccountClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly limits: AuthRateLimitService,
    @Optional() private readonly computeIntegration?: ComputeIntegrationService,
  ) {}

  private link(token: string): string {
    let url: URL;
    try {
      url = new URL(this.config.getOrThrow<string>('WEB_BASE_URL'));
    } catch {
      throw new BadRequestException('平台邮件链接地址尚未配置');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (this.config.get('NODE_ENV') === 'production' && url.protocol !== 'https:')) {
      throw new BadRequestException('平台邮件链接地址配置无效');
    }
    url = new URL('/account-closure', url.origin);
    url.searchParams.set('token', token);
    return url.toString();
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<User> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('账号不存在');
    if (user.status !== 'ACTIVE') throw new ConflictException('账号当前不可申请注销');
    return user;
  }

  private async inspect(tx: Prisma.TransactionClient, user: User): Promise<AccountClosureEligibility> {
    const blockers: AccountClosureEligibility['blockers'] = [];
    const enterprisesToClose: AccountClosureEligibility['enterprisesToClose'] = [];
    const memberships = await tx.enterpriseMember.findMany({
      where: { userId: user.id }, orderBy: { enterpriseId: 'asc' }, select: { enterpriseId: true },
    });
    // Member creation and financial writers share these locks, after the user lock.
    for (const { enterpriseId } of memberships) {
      await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
      const enterprise = await tx.enterprise.findUnique({
        where: { id: enterpriseId },
        select: { id: true, name: true, status: true, members: { select: { userId: true, role: true } } },
      });
      if (!enterprise) throw new ConflictException('企业状态已变化，请刷新后重试');
      if (enterprise.status !== 'ACTIVE') {
        blockers.push({ code: 'ENTERPRISE_CLOSED', message: '所属企业已关闭，请联系平台处理成员关系' });
        continue;
      }
      const member = enterprise.members.find((item) => item.userId === user.id);
      if (!member) throw new ConflictException('企业成员关系已变化，请刷新后重试');
      if (enterprise.members.length !== 1) {
        blockers.push({ code: 'ENTERPRISE_MEMBERSHIP', message: `企业「${enterprise.name}」还有其他成员，请先移交管理职责并退出企业，再注销账号` });
        continue;
      }
      if (member.role !== 'ENTERPRISE_ADMIN') {
        blockers.push({ code: 'ENTERPRISE_ADMIN_REQUIRED', message: `你不是企业「${enterprise.name}」的管理员，请联系平台处理后再注销` });
        continue;
      }
      enterprisesToClose.push({ id: enterprise.id, name: enterprise.name });
      if (await this.computeIntegration?.hasOpenAccounting(enterprise.id, tx)) blockers.push({ code: 'BILLING_RECONCILIATION',
        message: `企业「${enterprise.name}」仍有未结清的算力任务、账务或远端余额，请先完成对账并退回余额` });
    }
    const enterpriseIds = enterprisesToClose.map((enterprise) => enterprise.id);
    const scope = { OR: [{ userId: user.id }, { enterpriseId: { in: enterpriseIds } }] };
    const [wallet, recharges, rewards, tasks, mirrors, executions, media, orders] = await Promise.all([
      tx.personalWallet.findUnique({ where: { userId: user.id }, select: { balance: true } }),
      tx.personalRechargeOrder.count({ where: { userId: user.id, status: 'PENDING' } }),
      tx.contributionRewardEvent.count({ where: { recipientId: user.id, status: { in: ['PENDING', 'AVAILABLE'] } } }),
      tx.taskRun.count({ where: { ...scope, status: { in: ['RUNNING', 'AWAITING_CONFIRMATION'] } } }),
      tx.clientTaskMirror.count({ where: { ...scope, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'] } } }),
      tx.gatewayExecution.count({ where: { ...scope, status: { in: ['STARTED', 'USAGE_PENDING', 'NEEDS_RECONCILIATION'] } } }),
      tx.mediaRealBillingReservation.count({ where: { ...scope, status: { in: ['RESERVED', 'RECONCILING'] } } }),
      tx.order.count({ where: { OR: [{ createdBy: user.id }, { enterpriseId: { in: enterpriseIds } }], status: 'PENDING' } }),
    ]);
    if (user.role === 'ADMIN') blockers.push({ code: 'PLATFORM_ADMIN', message: '平台管理员请先联系平台完成管理职责交接' });
    if (wallet && !wallet.balance.isZero()) blockers.push({ code: 'PERSONAL_BALANCE', message: '个人钱包余额尚未结清，请联系平台处理' });
    if (recharges || orders) blockers.push({ code: 'PENDING_PAYMENT', message: '存在待支付订单，请先完成支付或关闭订单' });
    if (rewards) blockers.push({ code: 'UNSETTLED_REWARD', message: '个人贡献收益尚未结算，请联系平台处理' });
    if (tasks || mirrors) blockers.push({ code: 'ACTIVE_TASK', message: '账号或待关闭企业存在运行中、排队中或待确认任务，请先完成或停止任务' });
    if (executions || media) blockers.push({ code: 'BILLING_RECONCILIATION', message: '账号或待关闭企业存在未完成的用量结算或对账，请稍后重试或联系平台' });
    if (enterpriseIds.length) {
      const [wallets, pendingRecharges, memberBalances] = await Promise.all([
        tx.enterpriseWallet.findMany({ where: { enterpriseId: { in: enterpriseIds } }, select: { balance: true, frozenAmount: true } }),
        tx.rechargeOrder.count({ where: { account: { enterpriseId: { in: enterpriseIds } }, status: 'PENDING' } }),
        tx.memberAllowanceTopUp.findMany({ where: { enterpriseId: { in: enterpriseIds } }, select: { amountCNY: true, consumedCNY: true } }),
      ]);
      if (wallets.some((item) => !item.balance.isZero() || !item.frozenAmount.isZero())) {
        blockers.push({ code: 'ENTERPRISE_BALANCE', message: '待关闭企业的钱包余额或冻结资金尚未结清，请联系平台处理' });
      }
      if (pendingRecharges) blockers.push({ code: 'ENTERPRISE_PENDING_PAYMENT', message: '待关闭企业存在待支付充值订单，请先支付或关闭订单' });
      if (memberBalances.some((item) => !item.amountCNY.equals(item.consumedCNY))) {
        blockers.push({ code: 'ENTERPRISE_MEMBER_BALANCE', message: '待关闭企业仍有未结清的成员算力余额，请联系平台处理' });
      }
    }
    return { eligible: blockers.length === 0, enterprisesToClose, blockers };
  }

  private assertEligible(eligibility: AccountClosureEligibility): void {
    if (!eligibility.eligible) throw new ConflictException({ message: '暂不满足注销条件', blockers: eligibility.blockers });
  }

  async eligibility(userId: string): Promise<AccountClosureEligibility> {
    return this.prisma.$transaction(async (tx) => this.inspect(tx, await this.lockUser(tx, userId)), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  async requestVerification(userId: string): Promise<{ message: string }> {
    const rate = await this.limits.consume('account_closure_email', userId, { limit: 1, windowSeconds: 60 });
    if (!rate.allowed) throw new HttpException('请稍后再发送注销确认邮件', HttpStatus.TOO_MANY_REQUESTS);
    const token = randomBytes(32).toString('base64url');
    const verificationUrl = this.link(token);
    const { user, enterprisesToClose } = await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      const eligibility = await this.inspect(tx, user);
      this.assertEligible(eligibility);
      await tx.authOneTimeToken.updateMany({ where: { userId, type: 'ACCOUNT_CLOSURE', consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.authOneTimeToken.create({ data: {
        userId, type: 'ACCOUNT_CLOSURE', tokenHash: hash(token),
        metadata: { email: user.email, enterpriseIds: eligibility.enterprisesToClose.map((enterprise) => enterprise.id) },
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      } });
      return { user, enterprisesToClose: eligibility.enterprisesToClose };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    try {
      await this.mail.sendAccountClosureVerification({ to: user.email, verificationUrl, enterpriseNames: enterprisesToClose.map((enterprise) => enterprise.name) });
    } catch (error) {
      await this.prisma.authOneTimeToken.updateMany({ where: { tokenHash: hash(token), consumedAt: null }, data: { consumedAt: new Date() } });
      throw error;
    }
    return { message: '注销确认邮件已发送，请在 20 分钟内打开邮件链接；确认后立即生效且无法撤回' };
  }

  async request(userId: string, dto: AccountClosureRequestDto): Promise<AccountClosureResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      const proof = await tx.authOneTimeToken.findUnique({ where: { tokenHash: hash(dto.token) } });
      const metadata = proof?.metadata as { email?: string; enterpriseIds?: string[] } | null;
      if (!proof || proof.userId !== user.id || proof.type !== 'ACCOUNT_CLOSURE' || proof.consumedAt ||
        proof.expiresAt <= new Date() || metadata?.email !== user.email || !Array.isArray(metadata.enterpriseIds)) {
        throw new BadRequestException('注销确认链接无效或已过期，请重新发送');
      }
      const eligibility = await this.inspect(tx, user);
      this.assertEligible(eligibility);
      if (JSON.stringify(metadata.enterpriseIds) !== JSON.stringify(eligibility.enterprisesToClose.map((enterprise) => enterprise.id))) {
        throw new ConflictException('企业归属已变化，请重新发送注销确认邮件');
      }
      const now = new Date();
      if (proof.expiresAt <= now) throw new BadRequestException('注销确认链接已过期，请重新发送');
      const request = await tx.accountClosureRequest.create({ data: {
        userId, status: 'COMPLETED', scheduledFor: now, completedAt: now, lastAttemptAt: now, attempts: 1,
      } });
      for (const enterprise of eligibility.enterprisesToClose) {
        await tx.enterprise.update({ where: { id: enterprise.id }, data: { status: 'CLOSED', closedAt: now } });
        await tx.enterpriseApiKey.updateMany({ where: { enterpriseId: enterprise.id, revokedAt: null }, data: { revokedAt: now } });
        await tx.enterpriseInvitation.updateMany({ where: { enterpriseId: enterprise.id, status: 'PENDING' }, data: { status: 'REVOKED' } });
        await tx.subscription.updateMany({ where: { enterpriseId: enterprise.id, status: { in: ['ACTIVE', 'PAUSED'] } }, data: {
          status: 'TERMINATED', terminatedAt: now, terminatedBy: userId, terminatedReason: 'enterprise_closed',
        } });
        await tx.subscriptionCredit.updateMany({ where: { enterpriseId: enterprise.id, status: 'ACTIVE' }, data: { status: 'EXPIRED', version: { increment: 1 } } });
        await tx.enterpriseMember.deleteMany({ where: { enterpriseId: enterprise.id, userId } });
        await tx.auditLog.create({ data: {
          actorId: userId, enterpriseId: enterprise.id, action: 'ENTERPRISE_CLOSED', resourceType: 'enterprise', resourceId: enterprise.id,
          summary: '唯一成员经邮件确认后关闭企业并注销账号',
        } });
      }
      await this.anonymize(tx, user);
      await tx.authEvent.create({ data: { userId, action: 'ACCOUNT_CLOSED', metadata: {
        requestId: request.id, closedEnterpriseIds: eligibility.enterprisesToClose.map((enterprise) => enterprise.id),
      } } });
      return { status: 'CLOSED', closedAt: now.toISOString(), closedEnterprises: eligibility.enterprisesToClose };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  }

  private async anonymize(tx: Prisma.TransactionClient, user: User): Promise<void> {
    const userId = user.id;
    const now = new Date();
    await tx.authSession.updateMany({ where: { userId }, data: { revokedAt: now, revokeReason: 'account_closure', ipAddress: null, userAgent: null } });
    await tx.authToken.deleteMany({ where: { session: { userId } } });
    await tx.enterpriseInvitation.updateMany({ where: { email: { equals: user.email, mode: 'insensitive' }, status: 'PENDING' }, data: { status: 'REVOKED' } });
    await tx.device.deleteMany({ where: { userId } });
    await tx.authCredential.deleteMany({ where: { userId } });
    await tx.authIdentity.deleteMany({ where: { userId } });
    await tx.authOneTimeToken.deleteMany({ where: { userId } });
    await tx.authOAuthTransaction.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.authEvent.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null, metadata: Prisma.DbNull } });
    await tx.user.update({ where: { id: userId }, data: {
      status: 'CLOSED', email: `closed+${userId}.${randomBytes(16).toString('hex')}@account.invalid`, name: '已注销用户',
      avatar: null, emailVerifiedAt: null, role: 'USER',
    } });
  }
}
