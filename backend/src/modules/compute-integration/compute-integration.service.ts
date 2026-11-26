import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ComputeSpendingPolicyService } from './compute-spending-policy.service';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptSecret, decryptSecret, isEncrypted, maskSecret } from '../../common/crypto/secret-cipher';
import {
  ComputeIntegrationKindSchema, ComputeSettlementDecisionSchema, ComputeTransferIntentSchema,
  ProvisionedComputeAccountSchema, computeIntegrationErrorMessages,
  type ComputeIntegrationKind, type ComputeIntegrationList, type ComputeIntegrationView,
  type ComputeSettlementDecision, type ComputeTransferIntent,
  type ComputeIntegrationRecordsQuery,
} from 'shared';
import { ComputeRemoteAdapter, type ProvisionedComputeAccount } from './compute-remote.adapter';
import { StoredRegistrationSnapshot, wireParse } from './compute-wire-contract';

const kinds = ComputeIntegrationKindSchema.options;

@Injectable()
export class ComputeIntegrationService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly remote: ComputeRemoteAdapter,
    @Optional() private readonly spending?: ComputeSpendingPolicyService) {}

  async ensureBinding(enterpriseId: string, tx: Prisma.TransactionClient = this.prisma,
    identity?: { companyName: string; adminEmail: string; adminUserId?: string; passwordHash?: string | null }) {
    const binding = await tx.enterpriseComputeBinding.upsert({
      where: { enterpriseId }, update: {},
      create: { enterpriseId, registrationRef: `reg_${enterpriseId}` },
    });
    await tx.computeIntegrationJob.upsert({ where: { businessId: binding.registrationRef }, update: {}, create: {
      enterpriseId, businessId: binding.registrationRef, kind: 'PROVISION', status: this.remote.isConnected() ? 'PENDING' : 'BLOCKED',
      lastErrorCode: this.remote.isConnected() ? null : 'REMOTE_NOT_CONNECTED',
      ...(identity ? { requestPayload: this.registrationPayload({ enterpriseId, registrationRef: binding.registrationRef, ...identity }) } : {}),
    } });
    return binding;
  }

  registrationPayload(input: { enterpriseId: string; registrationRef: string; companyName: string; adminEmail: string;
    adminUserId?: string; passwordHash?: string | null; encryptionKeyId?: string }) {
    const { passwordHash, ...identity } = input;
    return { ...identity, ...(passwordHash ? { encryptedPasswordHash: encryptSecret(passwordHash, this.secret()) } : {}) };
  }

  registrationRequest(payload: unknown) {
    const { encryptedPasswordHash, adminUserId: _adminUserId, ...identity } = wireParse(StoredRegistrationSnapshot, payload);
    if (!encryptedPasswordHash) throw new ConflictException({ code: 'LOCAL_PASSWORD_REQUIRED', message: computeIntegrationErrorMessages.LOCAL_PASSWORD_REQUIRED });
    let passwordHash: string;
    try { passwordHash = decryptSecret(encryptedPasswordHash, this.secret()); }
    catch { throw new ServiceUnavailableException({ code: 'COMPUTE_REGISTRATION_SECRET_UNAVAILABLE', message: '开户密码凭证无法解密，请检查原加密配置' }); }
    return this.remote.registration({ ...identity, passwordHash });
  }

  async prepare(enterpriseId: string) {
    await this.prisma.$transaction(async tx => {
      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
      if (!enterprises[0]) throw new NotFoundException('企业不存在');
      if (enterprises[0].status !== 'ACTIVE') throw new ConflictException('企业当前状态不允许准备算力连接');
      const binding = await this.ensureBinding(enterpriseId, tx);
      if (binding.mode === 'ENTERPRISE' || binding.status === 'READY') return;
      const connected = this.remote.isConnected();
      await tx.enterpriseComputeBinding.update({ where: { enterpriseId }, data: {
        mode: 'PREPARING', status: connected ? 'PENDING' : 'NOT_CONNECTED',
        lastErrorCode: connected ? null : 'REMOTE_NOT_CONNECTED', version: { increment: 1 },
      } });
      await tx.computeIntegrationJob.upsert({ where: { businessId: binding.registrationRef },
        create: { enterpriseId, businessId: binding.registrationRef, kind: 'PROVISION',
          status: connected ? 'PENDING' : 'BLOCKED', lastErrorCode: connected ? null : 'REMOTE_NOT_CONNECTED' },
        update: {},
      });
      await tx.computeIntegrationJob.updateMany({ where: { businessId: binding.registrationRef, status: 'BLOCKED' },
        data: { status: connected ? 'PENDING' : 'BLOCKED', lastErrorCode: connected ? null : 'REMOTE_NOT_CONNECTED', nextRunAt: new Date() } });
    });
    return this.view(enterpriseId);
  }

  async retry(jobId: string) {
    const job = await this.prisma.computeIntegrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('同步操作不存在');
    if (!this.remote.isConnected()) throw new ServiceUnavailableException('算力平台接口尚未接通，不能执行远端重试');
    if (!['PROVISION', 'SETTLEMENT', 'TRANSFER', 'FEE'].includes(job.kind)) throw new ConflictException('该同步操作不支持重试');
    const updated = await this.prisma.computeIntegrationJob.updateMany({
      where: { id: jobId, status: { in: ['BLOCKED', 'PENDING'] } },
      data: { status: 'PENDING', nextRunAt: new Date(), lastErrorCode: null },
    });
    if (!updated.count) throw new ConflictException('原操作正在执行或已经完成，不能重新发起');
    return { id: jobId };
  }

  async view(enterpriseId: string): Promise<ComputeIntegrationView> {
    const enterprise = await this.prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { name: true } });
    if (!enterprise) throw new NotFoundException('企业不存在');
    const [binding, credentials, pendingJobs, reconciliation] = await Promise.all([
      this.prisma.enterpriseComputeBinding.findUnique({ where: { enterpriseId } }),
      this.prisma.enterpriseComputeCredential.findMany({ where: { enterpriseId, active: true },
        select: { kind: true, maskedKey: true, version: true }, orderBy: { version: 'desc' } }),
      this.prisma.computeIntegrationJob.count({ where: { enterpriseId, status: { not: 'SUCCEEDED' } } }),
      this.prisma.computeIntegrationReconciliation.findFirst({ where: { enterpriseId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const code = binding?.lastErrorCode ?? null;
    return {
      enterpriseId, enterpriseName: enterprise.name, remoteAccountId: binding?.remoteAccountId ?? null,
      mode: binding?.mode ?? 'LEGACY', status: binding?.status ?? 'NOT_CONNECTED',
      connected: this.remote.isConnected(),
      credentials: kinds.map(kind => { const value = credentials.find(item => item.kind === kind); return {
        kind, configured: !!value, maskedKey: value?.maskedKey ?? null, version: value?.version ?? null,
      }; }),
      lastErrorCode: code, lastErrorMessage: code ? binding?.lastErrorMessage ?? computeIntegrationErrorMessages[code] ?? '同步状态异常，请检查原操作' : null,
      lastSyncedAt: binding?.lastSyncedAt?.toISOString() ?? null, ledgerCursor: binding?.ledgerCursor ?? null, pendingJobs,
      lastReconciliation: reconciliation ? { status: reconciliation.status, differenceCny: reconciliation.differenceCny.toFixed(6), checkedAt: reconciliation.createdAt.toISOString() } : null,
      ...(this.spending ? { funds: await this.spending.summary(enterpriseId) } : {}),
    };
  }

  async list(query: ComputeIntegrationList) {
    const where = query.keyword ? { OR: [{ name: { contains: query.keyword, mode: 'insensitive' as const } }, { id: query.keyword }] } : {};
    const [enterprises, total] = await Promise.all([
      this.prisma.enterprise.findMany({ where, select: { id: true }, orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.enterprise.count({ where }),
    ]);
    return { items: await Promise.all(enterprises.map(item => this.view(item.id))), total, page: query.page, pageSize: query.pageSize };
  }

  async forEnterpriseAdmin(userId: string) {
    const member = await this.prisma.enterpriseMember.findFirst({ where: { userId, role: 'ENTERPRISE_ADMIN', enterprise: { status: 'ACTIVE' } }, select: { enterpriseId: true } });
    if (!member) throw new ForbiddenException('仅企业管理员可查看企业算力连接');
    return this.view(member.enterpriseId);
  }

  async records(enterpriseId: string, query: ComputeIntegrationRecordsQuery = { keyword: '', status: 'ALL' }) {
    await this.view(enterpriseId);
    const keyword = query.keyword ? { businessId: { contains: query.keyword } } : {};
    const jobStatus = query.status === 'SUCCEEDED' ? { status: 'SUCCEEDED' as const } : query.status === 'FAILED' ? { lastErrorCode: { not: null } }
      : query.status === 'PENDING' ? { status: { not: 'SUCCEEDED' as const } } : {};
    const [jobs, settlements, transfers, executions, reconciliations, passwordSync] = await Promise.all([
      this.prisma.computeIntegrationJob.findMany({ where: { enterpriseId, ...keyword, ...jobStatus }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, businessId: true, kind: true, status: true, attempts: true, lastErrorCode: true, lastErrorMessage: true, nextRunAt: true, updatedAt: true } }),
      this.prisma.computeIntegrationSettlement.findMany({ where: { enterpriseId,
        ...(query.keyword ? { OR: [{ executionId: { contains: query.keyword } }, { billId: { contains: query.keyword } }] } : {}),
        ...(query.status === 'SUCCEEDED' ? { status: 'COMMITTED' } : query.status === 'PENDING' ? { status: { not: 'COMMITTED' } } : query.status === 'FAILED' ? { status: 'UNPAID' } : {}),
      }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.computeIntegrationTransfer.findMany({ where: { enterpriseId, ...keyword,
        ...(query.status === 'SUCCEEDED' ? { status: 'COMMITTED' } : query.status === 'PENDING' ? { status: { not: 'COMMITTED' } } : query.status === 'FAILED' ? { status: 'FAILED' } : {}),
      }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.computeIntegrationExecution.findMany({ where: { enterpriseId,
        ...(query.keyword ? { OR: [{ id: { contains: query.keyword } }, { sourceRef: { contains: query.keyword } }] } : {}),
        ...(query.status === 'PENDING' ? { feeStatus: { in: ['PENDING', 'RECONCILING'] } } : query.status === 'SUCCEEDED' ? { feeStatus: 'FINAL' } : query.status === 'FAILED' ? { feeStatus: 'FAILED' } : {}),
      }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.computeIntegrationReconciliation.findMany({ where: { enterpriseId, ...keyword,
        ...(query.status === 'FAILED' ? { status: 'DIFFERENCE' } : query.status === 'SUCCEEDED' ? { status: 'MATCHED' } : query.status === 'PENDING' ? { status: 'PENDING' } : {}),
      }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.computePasswordSync.findUnique({ where: { enterpriseId }, select: {
        status: true, version: true, attempts: true, lastErrorCode: true, lastErrorMessage: true, nextRunAt: true, updatedAt: true,
      } }),
    ]);
    return { jobs, passwordSync, settlements: settlements.map(row => ({ ...row, grossCny: row.grossCny.toFixed(6), freeCny: row.freeCny.toFixed(6),
      paidCny: row.paidCny.toFixed(6), unpaidCny: row.unpaidCny.toFixed(6) })),
      transfers: transfers.map(row => ({ ...row, amountCny: row.amountCny.toFixed(6) })),
      executions: executions.map(row => ({ ...row, grossCny: row.grossCny?.toFixed(6) ?? null })),
      reconciliations: reconciliations.map(row => ({ ...row, localBalanceCny: row.localBalanceCny.toFixed(6), remoteBalanceCny: row.remoteBalanceCny.toFixed(6), differenceCny: row.differenceCny.toFixed(6) })) };
  }

  async isEnterpriseMode(enterpriseId: string, tx: Prisma.TransactionClient = this.prisma) {
    return (await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId } }))?.mode === 'ENTERPRISE';
  }

  async hasOpenAccounting(enterpriseId: string, tx: Prisma.TransactionClient = this.prisma) {
    if (!await this.isEnterpriseMode(enterpriseId, tx)) return false;
    const [jobs, executions, unsettled, credits, debits, consumption, external, pendingEvents, rotations] = await Promise.all([
      tx.computeIntegrationJob.count({ where: { enterpriseId, status: { not: 'SUCCEEDED' } } }),
      tx.computeIntegrationExecution.count({ where: { enterpriseId, dispatchStatus: { not: 'NOT_SUBMITTED' }, OR: [{ feeStatus: { not: 'FINAL' } }, { localUsageRecordId: null }] } }),
      tx.computeIntegrationSettlement.count({ where: { enterpriseId, status: { not: 'COMMITTED' } } }),
      tx.computeIntegrationTransfer.aggregate({ where: { enterpriseId, status: 'COMMITTED', direction: 'credit_compute' }, _sum: { amountCny: true } }),
      tx.computeIntegrationTransfer.aggregate({ where: { enterpriseId, status: 'COMMITTED', direction: 'debit_compute' }, _sum: { amountCny: true } }),
      tx.computeIntegrationSettlement.aggregate({ where: { enterpriseId, status: 'COMMITTED' }, _sum: { paidCny: true } }),
      tx.computeBalanceEvent.aggregate({ where: { enterpriseId, origin: 'compute', status: 'APPLIED' }, _sum: { deltaCny: true } }),
      tx.computeBalanceEvent.count({ where: { enterpriseId, OR: [{ status: { not: 'APPLIED' } }, { outstandingCny: { gt: 0 } }] } }),
      tx.computeCredentialRotation.count({ where: { enterpriseId, openSlot: 'open' } }),
    ]);
    const remaining = new Decimal(credits._sum.amountCny ?? 0).sub(debits._sum.amountCny ?? 0).sub(consumption._sum.paidCny ?? 0).add(external._sum.deltaCny ?? 0);
    return !!(jobs || executions || unsettled || pendingEvents || rotations || !remaining.isZero());
  }

  async completeConnection(enterpriseId: string) {
    if (await this.isEnterpriseMode(enterpriseId)) return this.view(enterpriseId);
    if (!this.remote.isConnected()) throw new ServiceUnavailableException('算力平台连接尚未配置');
    const remote = await this.remote.balance(enterpriseId);
    await this.prisma.$transaction(async tx => {
      await this.lockEnterprise(tx, enterpriseId);
      const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
      if (binding?.mode === 'ENTERPRISE') return;
      if (binding?.status !== 'READY' || !binding.remoteAccountId) throw new ConflictException('企业算力开户尚未就绪');
      const credentials = await tx.enterpriseComputeCredential.findMany({ where: { enterpriseId, active: true } });
      if (!kinds.every(kind => credentials.some(row => row.kind === kind))) throw new ConflictException('三种企业用途凭证必须齐全');
      const [gateway, media, recentMessages] = await Promise.all([
        tx.gatewayExecution.count({ where: { enterpriseId, status: { in: ['STARTED', 'USAGE_PENDING', 'NEEDS_RECONCILIATION'] } } }),
        tx.mediaRealBillingReservation.count({ where: { enterpriseId, status: { in: ['RESERVED', 'RECONCILING'] } } }),
        tx.message.count({ where: { session: { enterpriseId }, createdAt: { gte: new Date(Date.now() - 10 * 60000) } } }),
      ]);
      if (gateway || media || recentMessages) throw new ConflictException('请先完成旧模型任务及账务，并停止对话至少 10 分钟后切换');
      const wallet = await tx.enterpriseWallet.findUnique({ where: { enterpriseId } });
      const topUps = await tx.memberAllowanceTopUp.aggregate({ where: { enterpriseId }, _sum: { amountCNY: true, consumedCNY: true } });
      const starting = new Decimal(wallet?.computeReservedCNY ?? 0).add(topUps._sum.amountCNY ?? 0).sub(topUps._sum.consumedCNY ?? 0);
      if (starting.gt(0) && (!new Decimal(remote.total_paid_cny).isZero() || remote.sequence !== '0')) {
        throw new ConflictException({ code: 'COMPUTE_INITIAL_BALANCE_CONFLICT', message: '企业已有本地算力资金且远端已有流水，需先核对余额，不能重复导入' });
      }
      await tx.enterpriseComputeBinding.update({ where: { enterpriseId }, data: {
        mode: 'ENTERPRISE', lastErrorCode: null, lastErrorMessage: null, version: { increment: 1 },
      } });
      if (starting.gt(0)) {
        const transfer = await this.recordTransfer(tx, { enterpriseId, businessId: `initial_${binding.id}`, direction: 'credit_compute',
          currency: 'CNY', amountCny: starting.toFixed(6), fundingRef: `initial_${binding.id}` });
        await tx.computeIntegrationTransfer.update({ where: { id: transfer.id }, data: { walletAction: 'INITIAL' } });
      }
    });
    return this.view(enterpriseId);
  }

  async assertEnterpriseReady(enterpriseId: string) {
    const binding = await this.prisma.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
    if (binding?.mode !== 'ENTERPRISE') throw new ServiceUnavailableException({
      code: 'COMPUTE_ENTERPRISE_NOT_ENABLED', message: '企业算力开户或连接初始化尚未完成，请稍后重试',
    });
    if (!this.remote.isConnected() || binding.status !== 'READY') throw new ServiceUnavailableException({ message: '企业算力连接不可用', code: 'COMPUTE_SETTLEMENT_NOT_CONNECTED' });
    if (await this.prisma.computeIntegrationTransfer.count({ where: { enterpriseId, walletAction: 'INITIAL', status: { not: 'COMMITTED' } } })) {
      throw new ServiceUnavailableException({ code: 'COMPUTE_INITIAL_FUNDS_PENDING', message: '初始算力余额尚未同步完成，请查询原划转' });
    }
  }

  async selectEnterpriseCredential(enterpriseId: string, kind: ComputeIntegrationKind) {
    if (!ComputeIntegrationKindSchema.safeParse(kind).success) throw new BadRequestException('凭证用途无效');
    const enterprise = await this.prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { status: true } });
    if (enterprise?.status !== 'ACTIVE') throw new ForbiddenException('企业不可用');
    const binding = await this.prisma.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
    if (binding?.status !== 'READY' || !binding.remoteAccountId) throw new ServiceUnavailableException('企业算力账号尚未就绪');
    const key = await this.prisma.enterpriseComputeCredential.findFirst({ where: { enterpriseId, kind, active: true }, orderBy: { version: 'desc' } });
    if (!key || !isEncrypted(key.encryptedKey)) throw new ServiceUnavailableException('企业算力凭证缺失或不是有效密文');
    try {
      const apiKey = decryptSecret(key.encryptedKey, this.secret());
      if (!apiKey) throw new ServiceUnavailableException('企业算力凭证为空');
      return { apiKey, credentialId: key.id, version: key.version, remoteAccountId: binding.remoteAccountId };
    } catch { throw new ServiceUnavailableException('企业算力凭证解密失败'); }
  }

  /** Original task queries keep their pinned credential even after a rotation. */
  async selectExecutionCredential(enterpriseId: string, executionId: string) {
    const execution = await this.prisma.computeIntegrationExecution.findUnique({ where: { id: executionId } });
    if (!execution || execution.enterpriseId !== enterpriseId) throw new NotFoundException('执行记录不存在');
    const enterprise = await this.prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { status: true } });
    if (enterprise?.status !== 'ACTIVE') throw new ForbiddenException('企业不可用');
    const credential = await this.prisma.enterpriseComputeCredential.findFirst({ where: {
      id: execution.credentialId, enterpriseId, kind: execution.kind, version: execution.credentialVersion,
    } });
    if (!credential || !isEncrypted(credential.encryptedKey)) throw new ServiceUnavailableException('原任务所用凭证缺失或不是有效密文');
    try {
      const apiKey = decryptSecret(credential.encryptedKey, this.secret());
      if (!apiKey) throw new ServiceUnavailableException('原任务凭证为空');
      return { apiKey, credentialId: credential.id, version: credential.version, remoteAccountId: execution.remoteAccountId };
    } catch { throw new ServiceUnavailableException('原任务凭证解密失败'); }
  }

  private secret() { return this.config.get<string>('COMPUTE_CREDENTIAL_SECRET') || this.config.getOrThrow<string>('JWT_SECRET'); }

  private async lockEnterprise(tx: Prisma.TransactionClient, enterpriseId: string) {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
    if (rows[0]?.status !== 'ACTIVE') throw new ConflictException('企业状态不允许创建账务同步记录');
  }

  async saveProvisioned(enterpriseId: string, value: ProvisionedComputeAccount, jobId: string, leaseToken: string) {
    if (!ProvisionedComputeAccountSchema.safeParse(value).success) {
      throw new BadRequestException('远端开户响应缺少完整的三类凭证');
    }
    return this.prisma.$transaction(async tx => {
      await this.lockEnterprise(tx, enterpriseId);
      const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
      if (!binding) throw new ConflictException('企业算力绑定不存在');
      if (binding?.remoteAccountId && binding.remoteAccountId !== value.remoteAccountId) throw new ConflictException('企业已绑定其他算力账号');
      const held = await tx.computeIntegrationJob.updateMany({ where: { id: jobId, enterpriseId, kind: 'PROVISION', businessId: binding.registrationRef, status: 'RUNNING', leaseToken },
        data: { status: 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCode: null } });
      if (!held.count) throw new ConflictException('开户同步处理权已变化');
      for (const key of value.credentials) {
        const latest = await tx.enterpriseComputeCredential.findFirst({ where: { enterpriseId, kind: key.kind }, orderBy: { version: 'desc' } });
        if (latest && latest.version > key.version) throw new ConflictException('不能用旧版本覆盖企业算力凭证');
        const prior = await tx.enterpriseComputeCredential.findUnique({ where: { enterpriseId_kind_version: { enterpriseId, kind: key.kind, version: key.version } } });
        if (prior) {
          let same = false;
          try { same = prior.remoteId === key.remoteId && isEncrypted(prior.encryptedKey) && decryptSecret(prior.encryptedKey, this.secret()) === key.apiKey; }
          catch { throw new ServiceUnavailableException('已保存的企业凭证解密失败'); }
          if (!same) throw new ConflictException('凭证版本与原内容不一致');
        }
        await tx.enterpriseComputeCredential.updateMany({ where: { enterpriseId, kind: key.kind, active: true }, data: { active: false } });
        await tx.enterpriseComputeCredential.upsert({ where: { enterpriseId_kind_version: { enterpriseId, kind: key.kind, version: key.version } },
          create: { enterpriseId, kind: key.kind, remoteId: key.remoteId, version: key.version,
            encryptedKey: encryptSecret(key.apiKey, this.secret()), maskedKey: maskSecret(key.apiKey) },
          update: { active: true },
        });
      }
      await tx.enterpriseComputeBinding.update({ where: { enterpriseId }, data: { remoteAccountId: value.remoteAccountId,
        status: 'READY', lastErrorCode: null, lastErrorMessage: null, lastSyncedAt: new Date(), version: { increment: 1 } } });
    });
  }

  /** Caller must use the same transaction as its local money mutations. No money is moved here. */
  async recordSettlement(tx: Prisma.TransactionClient, raw: ComputeSettlementDecision) {
    const parsed = ComputeSettlementDecisionSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('结算字段、币种或人民币金额格式无效');
    const value = parsed.data;
    if (!new Decimal(value.grossCny).eq(new Decimal(value.freeCny).add(value.paidCny).add(value.unpaidCny))) throw new BadRequestException('人民币结算金额不守恒');
    await this.lockEnterprise(tx, value.enterpriseId);
    const execution = await tx.computeIntegrationExecution.findUnique({ where: { id: value.executionId } });
    if (!execution || execution.enterpriseId !== value.enterpriseId || execution.kind !== value.kind || execution.feeStatus !== 'FINAL'
      || execution.billId !== value.billId || execution.billVersion !== value.billVersion || !execution.grossCny?.eq(value.grossCny)) {
      throw new ConflictException('结算必须匹配所属企业已确认的实际人民币费用');
    }
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const existing = await tx.computeIntegrationSettlement.findUnique({ where: { executionId: value.executionId } });
    if (existing) {
      if (existing.enterpriseId !== value.enterpriseId || existing.decisionHash !== hash) throw new ConflictException('结算编号对应内容冲突');
      return existing;
    }
    const row = await tx.computeIntegrationSettlement.create({ data: {
      enterpriseId: value.enterpriseId, executionId: value.executionId, kind: value.kind,
      billId: value.billId, billVersion: value.billVersion, grossCny: value.grossCny,
      freeCny: value.freeCny, paidCny: value.paidCny, unpaidCny: value.unpaidCny, decisionHash: hash,
      status: new Decimal(value.unpaidCny).isZero() ? 'LOCAL_CONFIRMED' : 'UNPAID' } });
    if (row.status === 'LOCAL_CONFIRMED') await tx.computeIntegrationJob.create({ data: {
      enterpriseId: value.enterpriseId, businessId: `settle_${row.id}`, kind: 'SETTLEMENT', status: this.remote.isConnected() ? 'PENDING' : 'BLOCKED', lastErrorCode: this.remote.isConnected() ? null : 'REMOTE_NOT_CONNECTED',
    } });
    return row;
  }

  /** Persists an intent only; wallet locking/overbooking checks remain the caller's responsibility. */
  async recordTransfer(tx: Prisma.TransactionClient, raw: ComputeTransferIntent) {
    const parsed = ComputeTransferIntentSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('划转字段、币种或人民币金额格式无效');
    const value = parsed.data;
    await this.lockEnterprise(tx, value.enterpriseId);
    const existing = await tx.computeIntegrationTransfer.findUnique({ where: { businessId: value.businessId } });
    if (existing) {
      if (existing.enterpriseId !== value.enterpriseId || existing.direction !== value.direction || existing.fundingRef !== value.fundingRef
        || !existing.amountCny.eq(value.amountCny)) throw new ConflictException('划转编号对应内容冲突');
      return existing;
    }
    const row = await tx.computeIntegrationTransfer.create({ data: {
      enterpriseId: value.enterpriseId, businessId: value.businessId, direction: value.direction,
      amountCny: value.amountCny, fundingRef: value.fundingRef,
    } });
    await tx.computeIntegrationJob.create({ data: { enterpriseId: value.enterpriseId, businessId: value.businessId, kind: 'TRANSFER', status: this.remote.isConnected() ? 'PENDING' : 'BLOCKED', lastErrorCode: this.remote.isConnected() ? null : 'REMOTE_NOT_CONNECTED' } });
    return row;
  }
}
