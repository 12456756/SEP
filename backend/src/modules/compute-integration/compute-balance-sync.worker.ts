import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';

@Injectable()
export class ComputeBalanceSyncWorker {
  private running = false;
  private readonly logger = new Logger(ComputeBalanceSyncWorker.name);
  constructor(private readonly prisma: PrismaService, private readonly remote: ComputeRemoteAdapter,
    private readonly sync: ComputeBalanceSyncService, private readonly config: ConfigService) {}

  @Cron('*/30 * * * * *')
  async pull() {
    if (this.running || !this.remote.isConnected() || this.config.get('COMPUTE_BALANCE_SYNC_ENABLED') !== 'true'
      || this.config.get('COMPUTE_BALANCE_POLL_ENABLED') === 'false') return;
    this.running = true;
    try {
      const bindings = await this.prisma.enterpriseComputeBinding.findMany({ where: { mode: 'ENTERPRISE', status: 'READY' }, select: { enterpriseId: true } });
      for (const binding of bindings) await this.prisma.computeBalanceSyncState.upsert({ where: { enterpriseId: binding.enterpriseId }, create: { enterpriseId: binding.enterpriseId }, update: {} });
      const states = await this.prisma.computeBalanceSyncState.findMany({ where: { enterpriseId: { in: bindings.map(row => row.enterpriseId) } },
        orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } }, take: 10 });
      for (const state of states) {
        try { await this.sync.sync(state.enterpriseId); }
        catch (error) { this.logger.warn({ event: 'compute_balance_sync_pending', enterpriseId: state.enterpriseId,
          message: error instanceof Error ? error.message : '余额同步失败' }); }
      }
    } finally { this.running = false; }
  }
}
