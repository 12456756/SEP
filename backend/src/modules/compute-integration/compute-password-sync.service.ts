import { ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ComputePasswordSync, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../common/crypto/secret-cipher';
import { errorMessage, sanitizeError } from '../../common/errors/error-diagnostics';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { StoredRegistrationSnapshot, wireParse } from './compute-wire-contract';

@Injectable()
export class ComputePasswordSyncService {
  private readonly logger = new Logger(ComputePasswordSyncService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly remote: ComputeRemoteAdapter) {}

  private secret() { return this.config.get<string>('COMPUTE_CREDENTIAL_SECRET') || this.config.getOrThrow<string>('JWT_SECRET'); }

  // The caller holds the user lock and saves the password in this same transaction.
  async enqueue(tx: Prisma.TransactionClient, user: { id: string; email: string }, passwordHash: string) {
    const jobs = await tx.computeIntegrationJob.findMany({ where: { kind: 'PROVISION', OR: [
      { requestPayload: { path: ['adminUserId'], equals: user.id } },
      { requestPayload: { path: ['adminEmail'], equals: user.email } },
    ] }, select: { enterpriseId: true, requestPayload: true } });
    for (const job of jobs) {
      const original = wireParse(StoredRegistrationSnapshot, job.requestPayload);
      if (original.adminUserId ? original.adminUserId !== user.id : original.adminEmail !== user.email) continue;
      const encryptedPasswordHash = encryptSecret(passwordHash, this.secret());
      await tx.computePasswordSync.upsert({ where: { enterpriseId: job.enterpriseId },
        create: { enterpriseId: job.enterpriseId, userId: user.id, encryptedPasswordHash },
        update: { version: { increment: 1 }, encryptedPasswordHash, status: 'PENDING', attempts: 0,
          lastErrorCode: null, lastErrorMessage: null, nextRunAt: new Date() },
      });
    }
  }

  async syncUser(userId: string): Promise<'SYNCED' | 'PENDING' | 'NOT_REQUIRED'> {
    const rows = await this.prisma.computePasswordSync.findMany({ where: { userId, status: { in: ['PENDING', 'SYNCED'] } } });
    if (!rows.length) return 'NOT_REQUIRED';
    await Promise.all(rows.filter(row => row.status === 'PENDING').map(row => this.deliver(row)));
    return await this.prisma.computePasswordSync.count({ where: { userId, status: 'PENDING' } }) ? 'PENDING' : 'SYNCED';
  }

  @Cron('*/15 * * * * *')
  async retry() {
    if (!this.remote.isConnected()) return;
    const rows = await this.prisma.computePasswordSync.findMany({ where: { status: 'PENDING', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' }, take: 20 });
    for (const row of rows) await this.deliver(row);
  }

  private async deliver(row: ComputePasswordSync) {
    try {
      const enterprise = await this.prisma.enterprise.findUnique({ where: { id: row.enterpriseId }, select: { status: true } });
      if (enterprise?.status !== 'ACTIVE') throw new ConflictException({ code: 'ENTERPRISE_UNAVAILABLE', message: '企业不可用，密码同步暂缓' });
      const binding = await this.prisma.enterpriseComputeBinding.findUnique({ where: { enterpriseId: row.enterpriseId } });
      if (binding?.status !== 'READY' || !binding.remoteAccountId) throw new ServiceUnavailableException({ code: 'COMPUTE_ACCOUNT_PENDING', message: '开户尚未完成，完成后自动同步最新密码' });
      if (!row.encryptedPasswordHash) throw new ServiceUnavailableException({ code: 'COMPUTE_PASSWORD_SECRET_MISSING', message: '密码同步凭证缺失' });
      let passwordHash: string;
      try { passwordHash = decryptSecret(row.encryptedPasswordHash, this.secret()); }
      catch { throw new ServiceUnavailableException({ code: 'COMPUTE_PASSWORD_SECRET_INVALID', message: '密码同步凭证解密失败，请检查原加密配置' }); }
      const result = await this.remote.syncPassword({ enterpriseId: row.enterpriseId, remoteAccountId: binding.remoteAccountId,
        operationId: `pwd_${row.id}_${row.version}`, version: row.version, passwordHash });
      if (result.status !== 'applied') throw new ConflictException({ code: 'COMPUTE_PASSWORD_VERSION_CONFLICT', message: '远端密码版本较新，请核对原同步记录' });
      await this.prisma.computePasswordSync.updateMany({ where: { id: row.id, version: row.version, status: 'PENDING' },
        data: { status: 'SYNCED', encryptedPasswordHash: null, lastErrorCode: null, lastErrorMessage: null } });
    } catch (error) {
      const response = sanitizeError(error instanceof HttpException ? error.getResponse() : error);
      const record = response && typeof response === 'object' && !Array.isArray(response) ? response : {};
      const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error) ? record.error : {};
      const value = record.code ?? nested.code;
      const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'COMPUTE_PASSWORD_SYNC_PENDING';
      await this.prisma.computePasswordSync.updateMany({ where: { id: row.id, version: row.version, status: 'PENDING' }, data: {
        attempts: { increment: 1 }, lastErrorCode: code,
        lastErrorMessage: (errorMessage(record.message) ?? errorMessage(response) ?? '算力账号密码同步失败，后台将自动重试').slice(0, 2000),
        nextRunAt: new Date(Date.now() + Math.min(60000, 15000 * 2 ** Math.min(row.attempts, 2))),
      } });
      this.logger.warn({ event: 'compute_password_sync_pending', enterpriseId: row.enterpriseId, version: row.version, code });
    }
  }
}
