import { ConflictException, HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { ComputeSettlementReceiptSchema, ComputeTransferReceiptSchema, computeIntegrationErrorMessages } from 'shared';
import { ComputeIntegrationJob, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeIntegrationService } from './compute-integration.service';
import { errorMessage, sanitizeError } from '../../common/errors/error-diagnostics';
import { ComputeFundsService } from './compute-funds.service';
import { StoredRegistrationSnapshot, wireParse } from './compute-wire-contract';

@Injectable()
export class ComputeIntegrationWorker {
  private readonly logger = new Logger(ComputeIntegrationWorker.name);
  constructor(private readonly prisma: PrismaService, private readonly remote: ComputeRemoteAdapter, private readonly service: ComputeIntegrationService, @Optional() private readonly funds?: ComputeFundsService) {}

  @Cron('*/1 * * * *')
  async deliver() {
    if (!this.remote.isConnected()) return;
    const ready = await this.prisma.enterpriseComputeBinding.findMany({
      where: { status: 'READY', mode: { not: 'ENTERPRISE' } },
      select: { enterpriseId: true }, orderBy: { updatedAt: 'asc' }, take: 20,
    });
    for (const binding of ready) await this.completeConnection(binding.enterpriseId);
    const now = new Date();
    const jobs = await this.prisma.computeIntegrationJob.findMany({ where: { kind: { in: ['PROVISION', 'SETTLEMENT', 'TRANSFER'] }, OR: [
      { status: 'PENDING', nextRunAt: { lte: now } }, { status: 'RUNNING', leaseUntil: { lte: now } },
    ] }, orderBy: { nextRunAt: 'asc' }, take: 20 });
    for (const job of jobs) {
      const token = randomUUID();
      const acquired = await this.prisma.computeIntegrationJob.updateMany({ where: { id: job.id, OR: [
        { status: 'PENDING', nextRunAt: { lte: now } }, { status: 'RUNNING', leaseUntil: { lte: now } },
      ] }, data: { status: 'RUNNING', leaseToken: token, leaseUntil: new Date(Date.now() + 120000), attempts: { increment: 1 } } });
      if (!acquired.count) continue;
      try {
        if (job.kind !== 'PROVISION') {
          await this.deliverAccounting(job, token);
          continue;
        }
        const enterprise = await this.prisma.enterprise.findUnique({ where: { id: job.enterpriseId }, select: { name: true, status: true,
          members: { where: { role: 'ENTERPRISE_ADMIN' }, select: { user: { select: { email: true,
            id: true,
            authCredentials: { where: { type: 'LOCAL_PASSWORD' }, select: { passwordHash: true }, take: 1 },
          } } }, orderBy: { createdAt: 'asc' } } } });
        if (enterprise?.status !== 'ACTIVE' || !enterprise.members[0]) throw new ConflictException({ message: '企业或管理员不可用', code: 'ENTERPRISE_UNAVAILABLE' });
        let stored = job.requestPayload ? wireParse(StoredRegistrationSnapshot, job.requestPayload) : null;
        if (stored && (stored.enterpriseId !== job.enterpriseId || stored.registrationRef !== job.businessId)) {
          throw new ConflictException({ code: 'COMPUTE_IDENTITY_MISMATCH', message: '开户快照与原任务不一致' });
        }
        const persist = async (payload: Prisma.JsonObject) => {
          const frozen = await this.prisma.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
            data: { requestPayload: payload } });
          if (!frozen.count) throw new ConflictException({ code: 'LEASE_LOST', message: '开户同步处理权已转移' });
        };
        if (!stored?.encryptedPasswordHash) {
          const admin = stored ? enterprise.members.find(member => stored.adminUserId
            ? member.user.id === stored.adminUserId : member.user.email === stored.adminEmail)?.user : enterprise.members[0].user;
          if (!admin) throw new ConflictException({ code: 'ENTERPRISE_UNAVAILABLE', message: '原开户管理员已不可用，不能改用其他管理员开户' });
          const payload = this.service.registrationPayload({ enterpriseId: job.enterpriseId, registrationRef: job.businessId,
            companyName: stored?.companyName ?? enterprise.name, adminEmail: stored?.adminEmail ?? admin.email,
            adminUserId: stored?.adminUserId ?? admin.id, encryptionKeyId: stored?.encryptionKeyId,
            passwordHash: admin.authCredentials?.[0]?.passwordHash });
          await persist(payload);
          stored = wireParse(StoredRegistrationSnapshot, payload);
        }
        const request = this.service.registrationRequest(stored);
        if (!stored.encryptionKeyId) await persist({ ...stored, encryptionKeyId: request.encryptionKeyId });
        if (request.enterpriseId !== job.enterpriseId || request.registrationRef !== job.businessId) throw new ConflictException({ code: 'COMPUTE_IDENTITY_MISMATCH', message: '开户快照与原任务不一致' });
        const result = await this.remote.provision(request);
        await this.service.saveProvisioned(job.enterpriseId, result, job.id, token);
        await this.completeConnection(job.enterpriseId);
      } catch (error) {
        const response = sanitizeError(error instanceof HttpException ? error.getResponse() : error);
        const record = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
        const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? record.error : {};
        const remoteCode = record.code ?? nested.code ?? record.reason;
        const code = typeof remoteCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(remoteCode) ? remoteCode
          : job.kind === 'PROVISION' ? 'PROVISIONING_FAILED' : 'ACCOUNTING_SYNC_FAILED';
        const message = (errorMessage(response) ?? computeIntegrationErrorMessages[code] ?? '远端同步失败，请查询原操作').slice(0, 2000);
        const rejected = job.kind === 'TRANSFER' && code === 'COMPUTE_TRANSFER_REJECTED';
        const blocked = ['MODE_NOT_ENABLED', 'ENTERPRISE_UNAVAILABLE', 'LOCAL_DECISION_NOT_READY', 'IDEMPOTENCY_CONFLICT',
          'INVALID_SERVICE_SIGNATURE', 'INVALID_SERVICE_AUTH', 'SEP_INTEGRATION_DISABLED', 'COMPUTE_CREDENTIAL_DELIVERY_INVALID',
          'COMPUTE_IDENTITY_MISMATCH', 'INVALID_ENTERPRISE_IDENTITY', 'ENCRYPTION_KEY_VERSION_MISMATCH',
          'LOCAL_PASSWORD_REQUIRED', 'INVALID_PASSWORD_HASH', 'EMAIL_ALREADY_EXISTS',
          'COMPUTE_REGISTRATION_SECRET_UNAVAILABLE'].includes(code)
          || job.kind === 'PROVISION' && code === 'COMPUTE_CONTRACT_INVALID';
        await this.prisma.$transaction(async tx => {
          if (rejected) await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${job.enterpriseId} FOR UPDATE`;
          const updated = await tx.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
            data: { status: rejected ? 'SUCCEEDED' : blocked ? 'BLOCKED' : 'PENDING', leaseToken: null, leaseUntil: null,
              lastErrorCode: code, lastErrorMessage: message,
              nextRunAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)) + Math.floor(Math.random() * 1000)) } });
          if (updated.count && job.kind === 'PROVISION') await tx.enterpriseComputeBinding.updateMany({ where: { enterpriseId: job.enterpriseId, status: { not: 'READY' } },
            data: { status: 'FAILED', lastErrorCode: code, lastErrorMessage: message } });
          if (updated.count && rejected) {
            const row = await tx.computeIntegrationTransfer.findUniqueOrThrow({ where: { businessId: job.businessId } });
            if (row.walletAction) await this.funds.finalize(tx, row.id, false);
            await tx.computeIntegrationTransfer.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'FAILED' } });
          }
        });
        this.logger.warn({ event: 'compute_integration_pending', enterpriseId: job.enterpriseId, jobId: job.id, kind: job.kind });
      }
    }
  }

  private async completeConnection(enterpriseId: string) {
    try {
      await this.service.completeConnection(enterpriseId);
    } catch (error) {
      const response = sanitizeError(error instanceof HttpException ? error.getResponse() : error);
      const record = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
      const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? record.error : {};
      const remoteCode = record.code ?? nested.code;
      const code = typeof remoteCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(remoteCode)
        ? remoteCode : 'COMPUTE_CONNECTION_PENDING';
      await this.prisma.enterpriseComputeBinding.updateMany({ where: { enterpriseId, status: 'READY', mode: { not: 'ENTERPRISE' } },
        data: { lastErrorCode: code, lastErrorMessage: (errorMessage(record.message) ?? errorMessage(response) ?? '企业算力连接初始化未完成，后台将自动重试').slice(0, 2000) } });
      this.logger.warn({ event: 'compute_connection_pending', enterpriseId, code });
    }
  }

  private async deliverAccounting(job: ComputeIntegrationJob, token: string) {
    const binding = await this.prisma.enterpriseComputeBinding.findUnique({ where: { enterpriseId: job.enterpriseId } });
    const enterprise = await this.prisma.enterprise.findUnique({ where: { id: job.enterpriseId }, select: { status: true } });
    if (enterprise?.status !== 'ACTIVE' || binding?.status !== 'READY' || binding.mode !== 'ENTERPRISE' || !binding.remoteAccountId) {
      throw new ConflictException({ message: '企业新模式账务尚未允许同步', code: 'MODE_NOT_ENABLED' });
    }
    const accountId = binding.remoteAccountId;
    if (job.kind === 'SETTLEMENT') {
      const row = await this.prisma.computeIntegrationSettlement.findUnique({ where: { id: job.businessId.replace(/^settle_/, '') } });
      if (!row || row.enterpriseId !== job.enterpriseId || row.status !== 'LOCAL_CONFIRMED' || !row.unpaidCny.isZero()) throw new ConflictException({ message: '本地结算决定尚未完整确认', code: 'LOCAL_DECISION_NOT_READY' });
      const execution = await this.prisma.computeIntegrationExecution.findUnique({ where: { id: row.executionId } });
      if (execution?.localUsageRecordId) {
        const funding = await this.prisma.computeIntegrationTransfer.findUnique({ where: { businessId: `personal_${execution.localUsageRecordId}` } });
        if (funding && funding.status !== 'COMMITTED') throw new ConflictException({ code: 'COMPUTE_PERSONAL_FUNDING_PENDING', message: '本次个人自费对应的资金尚未同步，请等待原划转' });
      }
      const receipt = ComputeSettlementReceiptSchema.safeParse(await this.remote.settle({
        enterpriseId: row.enterpriseId, businessId: job.businessId, remoteAccountId: accountId, executionId: row.executionId,
        kind: row.kind as 'chat' | 'image' | 'video', billId: row.billId, billVersion: row.billVersion, currency: 'CNY',
        grossCny: row.grossCny.toFixed(6), freeCny: row.freeCny.toFixed(6), paidCny: row.paidCny.toFixed(6), unpaidCny: row.unpaidCny.toFixed(6),
      }));
      if (!receipt.success || receipt.data.enterpriseId !== row.enterpriseId || receipt.data.businessId !== job.businessId
        || receipt.data.remoteAccountId !== accountId || receipt.data.executionId !== row.executionId || receipt.data.billId !== row.billId
        || receipt.data.billVersion !== row.billVersion || !row.freeCny.eq(receipt.data.freeCny) || !row.paidCny.eq(receipt.data.paidCny)) throw new ConflictException({ message: '远端结算回执与原决定不一致', code: 'SETTLEMENT_RECEIPT_MISMATCH' });
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${job.enterpriseId} FOR UPDATE`;
        const held = await tx.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
          data: { status: 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null } });
        if (!held.count) throw new ConflictException({ message: '结算同步处理权已变化', code: 'LEASE_LOST' });
        await tx.computeIntegrationSettlement.update({ where: { id: row.id }, data: { status: 'COMMITTED', remoteLedgerId: receipt.data.remoteLedgerId,
          ...(receipt.data.remoteSequence ? { remoteSequence: receipt.data.remoteSequence } : {}) } });
      });
    } else {
      const row = await this.prisma.computeIntegrationTransfer.findUnique({ where: { businessId: job.businessId } });
      if (!row || row.enterpriseId !== job.enterpriseId || row.status !== 'PENDING') throw new ConflictException({ message: '原划转记录不可同步', code: 'LOCAL_DECISION_NOT_READY' });
      const receipt = ComputeTransferReceiptSchema.safeParse(await this.remote.transfer({
        enterpriseId: row.enterpriseId, businessId: row.businessId, remoteAccountId: accountId,
        direction: row.direction as 'credit_compute' | 'debit_compute', currency: 'CNY', amountCny: row.amountCny.toFixed(6), fundingRef: row.fundingRef,
      }));
      if (!receipt.success || receipt.data.enterpriseId !== row.enterpriseId || receipt.data.businessId !== job.businessId
        || receipt.data.remoteAccountId !== accountId || receipt.data.direction !== row.direction || !row.amountCny.eq(receipt.data.amountCny)) throw new ConflictException({ message: '远端划转回执与原操作不一致', code: 'TRANSFER_RECEIPT_MISMATCH' });
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM enterprises WHERE id = ${job.enterpriseId} FOR UPDATE`;
        const held = await tx.computeIntegrationJob.updateMany({ where: { id: job.id, status: 'RUNNING', leaseToken: token },
          data: { status: 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null } });
        if (!held.count) throw new ConflictException({ message: '划转同步处理权已变化', code: 'LEASE_LOST' });
        if (row.walletAction) await this.funds.finalize(tx, row.id, true);
        await tx.computeIntegrationTransfer.update({ where: { id: row.id }, data: { status: 'COMMITTED', remoteLedgerId: receipt.data.remoteLedgerId,
          ...(receipt.data.remoteSequence ? { remoteSequence: receipt.data.remoteSequence } : {}) } });
      });
    }
  }
}
