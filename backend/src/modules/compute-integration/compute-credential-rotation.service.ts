import { ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ComputeCredentialRotation, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { ComputeCredentialRotationRequest } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptSecret, maskSecret } from '../../common/crypto/secret-cipher';
import { errorMessage, sanitizeError } from '../../common/errors/error-diagnostics';
import { ComputeCredentialRotationRemote } from './compute-credential-rotation.remote';

const publicSelect = { id: true, operationId: true, kind: true, expectedVersion: true, status: true,
  lastErrorCode: true, lastErrorMessage: true, createdAt: true } satisfies Prisma.ComputeCredentialRotationSelect;

@Injectable()
export class ComputeCredentialRotationService {
  private readonly logger = new Logger(ComputeCredentialRotationService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly remote: ComputeCredentialRotationRemote) {}

  private async membership(tx: Prisma.TransactionClient, userId: string) {
    const member = await tx.enterpriseMember.findFirst({ where: { userId, role: 'ENTERPRISE_ADMIN',
      user: { status: 'ACTIVE' }, enterprise: { status: 'ACTIVE' } }, select: { enterpriseId: true } });
    if (!member) throw new ForbiddenException('仅企业管理员可以更换本企业凭证');
    return member;
  }

  async list(userId: string) {
    const member = await this.membership(this.prisma, userId);
    const [open, recent] = await Promise.all([
      this.prisma.computeCredentialRotation.findMany({ where: { enterpriseId: member.enterpriseId, openSlot: 'open' }, select: publicSelect }),
      this.prisma.computeCredentialRotation.findMany({ where: { enterpriseId: member.enterpriseId }, select: publicSelect, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return [...new Map([...open, ...recent].map(row => [row.id, row])).values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async get(userId: string, operationId: string) {
    const member = await this.membership(this.prisma, userId);
    const row = await this.prisma.computeCredentialRotation.findFirst({ where: { enterpriseId: member.enterpriseId, operationId }, select: publicSelect });
    if (!row) throw new NotFoundException('凭证更换操作不存在');
    return row;
  }

  async retry(userId: string, operationId: string) {
    return this.prisma.$transaction(async tx => {
      const member = await this.membership(tx, userId);
      await tx.$queryRaw`SELECT id FROM enterprises WHERE id=${member.enterpriseId} FOR UPDATE`;
      await this.membership(tx, userId);
      const row = await tx.computeCredentialRotation.findFirst({ where: { enterpriseId: member.enterpriseId, operationId } });
      if (!row) throw new NotFoundException('凭证更换操作不存在');
      if (row.status === 'BLOCKED') await tx.computeCredentialRotation.update({ where: { id: row.id }, data: {
        status: row.newCredentialId ? 'SWITCHED' : 'PENDING', nextRunAt: new Date(), lastErrorCode: null, lastErrorMessage: null } });
      return tx.computeCredentialRotation.findUnique({ where: { id: row.id }, select: publicSelect });
    });
  }

  async start(userId: string, request: ComputeCredentialRotationRequest) {
    if (!this.remote.connected()) throw new ServiceUnavailableException('算力平台连接不可用，暂时无法更换凭证');
    return this.prisma.$transaction(async tx => {
      const member = await this.membership(tx, userId);
      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id=${member.enterpriseId} FOR UPDATE`;
      if (enterprises[0]?.status !== 'ACTIVE') throw new ConflictException('企业不可用');
      await this.membership(tx, userId);
      const existing = await tx.computeCredentialRotation.findUnique({ where: { operationId: request.operationId } });
      if (existing) {
        if (existing.enterpriseId !== member.enterpriseId || existing.kind !== request.kind || existing.expectedVersion !== request.expectedVersion) {
          throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '更换编号已用于不同请求' });
        }
        return tx.computeCredentialRotation.findUnique({ where: { id: existing.id }, select: publicSelect });
      }
      const open = await tx.computeCredentialRotation.findFirst({ where: { enterpriseId: member.enterpriseId, kind: request.kind, openSlot: 'open' } });
      if (open) throw new ConflictException({ code: 'CREDENTIAL_ROTATION_IN_PROGRESS', message: '该用途已有未完成的更换，请等待原操作', operationId: open.operationId });
      const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId: member.enterpriseId } });
      if (binding?.mode !== 'ENTERPRISE' || binding.status !== 'READY' || !binding.remoteAccountId) throw new ConflictException('企业算力尚未开通');
      const current = await tx.enterpriseComputeCredential.findFirst({ where: { enterpriseId: member.enterpriseId, kind: request.kind, active: true }, orderBy: { version: 'desc' } });
      if (!current || current.version !== request.expectedVersion) throw new ConflictException({ code: 'CREDENTIAL_VERSION_CONFLICT', message: '凭证版本已变化，请刷新后重试' });
      return tx.computeCredentialRotation.create({ data: { operationId: request.operationId, kind: request.kind,
        expectedVersion: request.expectedVersion, enterpriseId: member.enterpriseId, oldCredentialId: current.id,
        oldRemoteId: current.remoteId, remoteAccountId: binding.remoteAccountId, encryptionKeyId: this.remote.encryptionKeyId(),
        requestedById: userId, openSlot: 'open' }, select: publicSelect });
    });
  }

  @Cron('*/15 * * * * *')
  async recover() {
    if (!this.remote.connected()) return;
    const rows = await this.prisma.computeCredentialRotation.findMany({ where: { openSlot: 'open', status: { not: 'BLOCKED' },
      nextRunAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] }, orderBy: { nextRunAt: 'asc' }, take: 20 });
    for (const row of rows) await this.deliver(row);
  }

  private async lock(tx: Prisma.TransactionClient, row: ComputeCredentialRotation, token: string) {
    const enterprise = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id=${row.enterpriseId} FOR UPDATE`;
    if (enterprise[0]?.status !== 'ACTIVE') throw new ConflictException({ code: 'ENTERPRISE_UNAVAILABLE', message: '企业不可用，更换暂缓' });
    const current = await tx.computeCredentialRotation.findUniqueOrThrow({ where: { id: row.id } });
    if (current.leaseToken !== token || !current.leaseUntil || current.leaseUntil.getTime() <= Date.now()) throw new ConflictException({ code: 'LEASE_LOST', message: '凭证更换处理权已转移' });
    return current;
  }

  async deliver(row: ComputeCredentialRotation) {
    const token = randomUUID(), now = new Date();
    const claimed = await this.prisma.computeCredentialRotation.updateMany({ where: { id: row.id, status: row.status, openSlot: 'open',
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + 120000), attempts: { increment: 1 } } });
    if (!claimed.count) return;
    try {
      await this.prisma.$transaction(tx => this.lock(tx, row, token));
      if (row.status === 'PENDING') {
        const clear = await this.remote.prepare(row);
        row = await this.prisma.$transaction(async tx => {
          await this.lock(tx, row, token);
          const binding = await tx.enterpriseComputeBinding.findUniqueOrThrow({ where: { enterpriseId: row.enterpriseId } });
          const old = await tx.enterpriseComputeCredential.findUniqueOrThrow({ where: { id: row.oldCredentialId } });
          if (binding.remoteAccountId !== row.remoteAccountId || !old.active || old.version !== row.expectedVersion) {
            throw new ConflictException({ code: 'CREDENTIAL_VERSION_CONFLICT', message: '原凭证版本或账号已变化，拒绝覆盖' });
          }
          const secret = this.config.get<string>('COMPUTE_CREDENTIAL_SECRET') || this.config.getOrThrow<string>('JWT_SECRET');
          const next = await tx.enterpriseComputeCredential.create({ data: { enterpriseId: row.enterpriseId, kind: row.kind,
            remoteId: clear.credential_id, version: clear.credential_version, encryptedKey: encryptSecret(clear.key, secret), maskedKey: maskSecret(clear.key) } });
          await tx.enterpriseComputeCredential.update({ where: { id: old.id }, data: { active: false } });
          return tx.computeCredentialRotation.update({ where: { id: row.id }, data: { status: 'SWITCHED', newCredentialId: next.id } });
        });
      }
      const next = await this.prisma.enterpriseComputeCredential.findUniqueOrThrow({ where: { id: row.newCredentialId! } });
      const identity = { ...row, newRemoteId: next.remoteId };
      if (row.status === 'SWITCHED') {
        await this.remote.advance(identity, 'ack');
        await this.prisma.$transaction(async tx => {
          await this.lock(tx, row, token);
          await tx.computeCredentialRotation.update({ where: { id: row.id }, data: { status: 'DRAINING' } });
        });
        row = { ...row, status: 'DRAINING' };
      }
      if (row.status === 'DRAINING') {
        await this.prisma.$transaction(async tx => {
          await this.lock(tx, row, token);
          const pending = await tx.computeIntegrationExecution.count({ where: { enterpriseId: row.enterpriseId,
            credentialId: row.oldCredentialId, dispatchStatus: { not: 'NOT_SUBMITTED' }, OR: [
              { dispatchStatus: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } }, { feeStatus: { not: 'FINAL' } }, { localUsageRecordId: null },
            ] } });
          const [settlements] = await tx.$queryRaw<Array<{ pending: boolean }>>`SELECT EXISTS(
            SELECT 1 FROM compute_integration_settlements s JOIN compute_integration_executions x ON x.id=s."executionId"
            WHERE s."enterpriseId"=${row.enterpriseId} AND x."credentialId"=${row.oldCredentialId} AND s.status<>'COMMITTED'
          ) AS pending`;
          if (pending || settlements.pending) throw new ConflictException({ code: 'CREDENTIAL_TASKS_PENDING', message: '新凭证已启用，旧凭证仍有任务或结算处理中' });
        });
        await this.remote.advance(identity, 'retire');
        await this.prisma.$transaction(async tx => {
          await this.lock(tx, row, token);
          await tx.computeCredentialRotation.update({ where: { id: row.id }, data: { status: 'COMPLETED', openSlot: null,
            leaseToken: null, leaseUntil: null, lastErrorCode: null, lastErrorMessage: null } });
        });
      }
    } catch (error) {
      const response = sanitizeError(error instanceof HttpException ? error.getResponse() : {});
      const details: any = response && typeof response === 'object' ? response : {};
      const code = typeof (details.code ?? details.error?.code) === 'string' ? details.code ?? details.error.code : 'CREDENTIAL_ROTATION_PENDING';
      const blocked = ['CREDENTIAL_VERSION_CONFLICT', 'CREDENTIAL_ROTATION_RECEIPT_MISMATCH', 'IDEMPOTENCY_CONFLICT', 'COMPUTE_CONTRACT_INVALID'].includes(code);
      await this.prisma.computeCredentialRotation.updateMany({ where: { id: row.id, leaseToken: token }, data: {
        ...(blocked ? { status: 'BLOCKED' } : {}), leaseToken: null, leaseUntil: null, lastErrorCode: code,
        lastErrorMessage: (errorMessage(response) ?? '凭证更换尚未完成，后台将重试原操作').slice(0, 1000), nextRunAt: new Date(Date.now() + 15000) } });
      if (code !== 'CREDENTIAL_TASKS_PENDING') this.logger.warn({ event: 'compute_credential_rotation_pending', operationId: row.operationId, code });
    }
  }
}
