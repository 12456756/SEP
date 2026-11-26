import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash } from 'node:crypto';
import { ComputeBalanceEventSchema, type ComputeBalanceEventPayload } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { equalFundsAllocation } from './equal-funds-allocation';
import { allocateTopUps } from '../compute-credit/allowance-carryover';

@Injectable()
export class ComputeBalanceSyncService {
  constructor(private readonly prisma: PrismaService, private readonly remote: ComputeRemoteAdapter) {}

  private conflict(code: string, message: string, event?: ComputeBalanceEventPayload): never {
    throw new ConflictException({ code, message, ...(event ? { event_id: event.event_id, enterprise_id: event.enterprise_id,
      sequence: event.sequence, business_ref: event.business_ref, accounting_status: 'not_applied' } : {}) });
  }

  private async lock(tx: Prisma.TransactionClient, enterpriseId: string) {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${enterpriseId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('余额事件对应的 SEP 企业不存在');
    const binding = await tx.enterpriseComputeBinding.findUnique({ where: { enterpriseId } });
    if (binding?.mode !== 'ENTERPRISE' || !binding.remoteAccountId) this.conflict('COMPUTE_EVENT_BINDING_NOT_READY', '企业算力模式或账户绑定未就绪');
    return binding;
  }

  async receive(value: ComputeBalanceEventPayload) {
    const event = ComputeBalanceEventSchema.parse(value);
    const payloadHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    // Persist a verified inbox record before applying; failed events remain inspectable and retryable.
    await this.prisma.$transaction(async tx => {
      const binding = await this.lock(tx, event.enterprise_id);
      if (binding.remoteAccountId !== String(event.compute_account_id)) this.conflict('COMPUTE_EVENT_ACCOUNT_MISMATCH', '余额事件的算力账户不属于当前企业', event);
      const existing = await tx.computeBalanceEvent.findUnique({ where: { eventId: event.event_id } });
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.enterpriseId !== event.enterprise_id) this.conflict('COMPUTE_EVENT_CONFLICT', '同一余额事件编号的内容发生变化', event);
        return;
      }
      const sequence = await tx.computeBalanceEvent.findUnique({ where: { enterpriseId_sequence: { enterpriseId: event.enterprise_id, sequence: BigInt(event.sequence) } } });
      if (sequence) this.conflict('COMPUTE_EVENT_SEQUENCE_CONFLICT', '同一企业流水序号对应多个事件', event);
      await tx.computeBalanceEvent.create({ data: { eventId: event.event_id, enterpriseId: event.enterprise_id,
        sequence: BigInt(event.sequence), origin: event.origin, type: event.type, deltaCny: event.delta_cny, payloadHash,
        payload: event as Prisma.InputJsonValue } });
    });
    try { return await this.apply(event); }
    catch (error) {
      await this.recordError(event.enterprise_id, error);
      throw error;
    }
  }

  private recordError(enterpriseId: string, error: unknown) {
    const message = JSON.stringify(exceptionDetails(error)).slice(0, 1000);
    return this.prisma.computeBalanceSyncState.upsert({ where: { enterpriseId },
      create: { enterpriseId, lastError: message, lastPolledAt: new Date() },
      update: { lastError: message, lastPolledAt: new Date() } });
  }

  private async apply(event: ComputeBalanceEventPayload) {
    await this.prisma.$transaction(async tx => {
      await this.lock(tx, event.enterprise_id);
      const row = await tx.computeBalanceEvent.findUniqueOrThrow({ where: { eventId: event.event_id } });
      if (row.status === 'APPLIED') return;
      const state = await tx.computeBalanceSyncState.upsert({ where: { enterpriseId: event.enterprise_id },
        create: { enterpriseId: event.enterprise_id }, update: {} });
      if (row.sequence !== state.sequence + 1n) this.conflict('COMPUTE_EVENT_SEQUENCE_GAP',
        `余额事件必须按顺序入账；本地水位 ${state.sequence}，收到 ${row.sequence}，请补拉或核对迁移起点`, event);
      if (event.origin === 'compute') await this.applyExternal(tx, event);
      else await this.matchReceipt(tx, event);
      await tx.computeBalanceEvent.update({ where: { id: row.id }, data: { status: 'APPLIED', appliedAt: new Date() } });
      await tx.computeBalanceSyncState.update({ where: { id: state.id }, data: { sequence: row.sequence, lastError: null,
        remoteAvailableCny: event.available_paid_cny, remoteFrozenCny: event.frozen_paid_cny } });
    });
    return { event_id: event.event_id, status: 'applied' as const };
  }

  private async applyExternal(tx: Prisma.TransactionClient, event: ComputeBalanceEventPayload) {
    const delta = new Decimal(event.delta_cny);
    const wallet = await tx.enterpriseWallet.upsert({ where: { enterpriseId: event.enterprise_id },
      create: { enterpriseId: event.enterprise_id }, update: {} });
    let publicDelta = delta;
    const memberDebits: Array<{ userId: string; amountCny: string; batches: Array<{ id: string; amountCny: string }> }> = [];
    const recovered: Array<{ eventId: string; amountCny: string }> = [];
    let outstanding = new Decimal(0);
    if (delta.isNegative()) {
      const debit = await this.debitFunds(tx, event.enterprise_id, wallet, delta.abs());
      publicDelta = debit.publicPaid.neg();
      outstanding = debit.outstanding;
      memberDebits.push(...debit.memberDebits);
    } else if (delta.gt(0)) {
      const gaps = await tx.computeBalanceEvent.findMany({ where: { enterpriseId: event.enterprise_id,
        status: 'APPLIED', outstandingCny: { gt: 0 } }, orderBy: { sequence: 'asc' } });
      for (const gap of gaps) {
        const paid = Decimal.min(publicDelta, gap.outstandingCny);
        if (paid.isZero()) break;
        await tx.computeBalanceEvent.update({ where: { id: gap.id }, data: { outstandingCny: { decrement: paid } } });
        recovered.push({ eventId: gap.eventId, amountCny: paid.toFixed(6) });
        publicDelta = publicDelta.sub(paid);
      }
    }
    const reserve = wallet.computeReservedCNY.add(publicDelta), balance = wallet.balance.add(publicDelta);
    if (balance.gte('100000000') || reserve.gte('100000000')) this.conflict('COMPUTE_LOCAL_BALANCE_LIMIT_EXCEEDED', '余额超出 SEP 钱包当前金额存储范围', event);
    const updated = await tx.enterpriseWallet.updateMany({ where: { id: wallet.id, version: wallet.version }, data: {
      balance, computeReservedCNY: reserve, version: { increment: 1 },
      ...(event.type === 'paid_consumption' ? { totalConsume: { increment: publicDelta.abs() } } : {}),
    } });
    if (!updated.count) this.conflict('COMPUTE_EVENT_WALLET_CONFLICT', '本地钱包并发变化，请重试原事件', event);
    await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT,
      amount: publicDelta, balanceBefore: wallet.balance, balanceAfter: balance, relatedType: 'compute_balance_event',
      relatedId: event.event_id, description: `算力平台独立账务同步：${event.type}`,
      metadata: { origin: 'compute', eventId: event.event_id, businessRef: event.business_ref, sequence: event.sequence,
        computeType: event.type, currency: 'CNY', exchangeRate: event.exchange_rate, occurredAt: event.occurred_at,
        computeReservedBefore: wallet.computeReservedCNY.toFixed(6), computeReservedAfter: reserve.toFixed(6),
        externalDeltaCny: delta.toFixed(6), memberDebits, recovered, outstandingCny: outstanding.toFixed(6), rule: 'equal-capped-v1' } } });
    await tx.computeBalanceEvent.update({ where: { eventId: event.event_id }, data: { outstandingCny: outstanding,
      allocation: { rule: 'equal-capped-v1', publicDeltaCny: publicDelta.toFixed(6), memberDebits, recovered,
        originalOutstandingCny: outstanding.toFixed(6) } } });
  }

  private async debitFunds(tx: Prisma.TransactionClient, enterpriseId: string,
    wallet: { balance: Decimal; computeReservedCNY: Decimal }, amount: Decimal) {
    // Pending transfers are already locked; media-held member funds are already consumed.
    const transfers = await tx.computeIntegrationTransfer.aggregate({ where: { enterpriseId, localApplied: false,
      walletAction: { in: ['RESERVE', 'RELEASE'] } }, _sum: { amountCny: true } });
    const publicPaid = Decimal.min(amount, Decimal.max(0, Decimal.min(wallet.balance, wallet.computeReservedCNY)
      .sub(transfers._sum.amountCny ?? 0)));
    const remainder = amount.sub(publicPaid);
    const memberDebits: Array<{ userId: string; amountCny: string; batches: Array<{ id: string; amountCny: string }> }> = [];
    if (remainder.isZero()) return { publicPaid, memberDebits, outstanding: new Decimal(0) };
    const members = await tx.enterpriseMember.findMany({ where: { enterpriseId }, select: { userId: true } });
    const rows = await tx.memberAllowanceTopUp.findMany({ where: { enterpriseId,
      userId: { in: members.map(member => member.userId) } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const balances = new Map<string, Decimal>();
    for (const row of rows) balances.set(row.userId, (balances.get(row.userId) ?? new Decimal(0))
      .add(Decimal.max(0, row.amountCNY.sub(row.consumedCNY))));
    const allocation = equalFundsAllocation(remainder, [...balances].map(([userId, balance]) => ({ userId, balance })));
    for (const member of allocation.allocations) {
      const batches = allocateTopUps(rows.filter(row => row.userId === member.userId), member.amount).allocations;
      for (const batch of batches) {
        const changed = await tx.memberAllowanceTopUp.updateMany({ where: { id: batch.id, version: batch.version },
          data: { consumedCNY: { increment: batch.consumeCNY }, version: { increment: 1 } } });
        if (!changed.count) this.conflict('COMPUTE_MEMBER_FUNDS_CONFLICT', '成员余额并发变化，请重试原账务');
      }
      memberDebits.push({ userId: member.userId, amountCny: member.amount.toFixed(6),
        batches: batches.map(batch => ({ id: batch.id, amountCny: batch.consumeCNY.toFixed(6) })) });
    }
    return { publicPaid, memberDebits, outstanding: allocation.outstanding };
  }

  async recoverOutstanding(enterpriseId: string) {
    await this.prisma.$transaction(async tx => {
      await this.lock(tx, enterpriseId);
      const gaps = await tx.computeBalanceEvent.findMany({ where: { enterpriseId, status: 'APPLIED', outstandingCny: { gt: 0 } },
        orderBy: { sequence: 'asc' } });
      for (const gap of gaps) {
        const wallet = await tx.enterpriseWallet.findUniqueOrThrow({ where: { enterpriseId } });
        const debit = await this.debitFunds(tx, enterpriseId, wallet, gap.outstandingCny);
        const paid = gap.outstandingCny.sub(debit.outstanding);
        if (paid.isZero()) break;
        const balance = wallet.balance.sub(debit.publicPaid);
        await tx.enterpriseWallet.update({ where: { id: wallet.id }, data: { balance,
          computeReservedCNY: { decrement: debit.publicPaid }, version: { increment: 1 } } });
        await tx.computeBalanceEvent.update({ where: { id: gap.id }, data: { outstandingCny: debit.outstanding } });
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT,
          amount: debit.publicPaid.neg(), balanceBefore: wallet.balance, balanceAfter: balance,
          relatedType: 'compute_balance_recovery', relatedId: gap.eventId, description: '算力平台原同步缺口补扣',
          metadata: { eventId: gap.eventId, recoveredCny: paid.toFixed(6), memberDebits: debit.memberDebits,
            outstandingCny: debit.outstanding.toFixed(6), rule: 'equal-capped-v1' } } });
        if (debit.outstanding.gt(0)) break;
      }
    });
  }

  private async matchReceipt(tx: Prisma.TransactionClient, event: ComputeBalanceEventPayload) {
    if (event.type === 'credit_compute' || event.type === 'debit_compute') {
      const transfer = event.transfer_id ? await tx.computeIntegrationTransfer.findUnique({ where: { businessId: event.transfer_id } }) : null;
      if (!transfer || transfer.enterpriseId !== event.enterprise_id || transfer.direction !== event.type
        || !transfer.amountCny.eq(event.amount_cny) || transfer.status !== 'COMMITTED' || transfer.remoteLedgerId !== event.event_id
        || transfer.remoteSequence !== event.sequence || transfer.walletAction && !transfer.localApplied) {
        this.conflict('COMPUTE_EVENT_ORIGINAL_TRANSFER_PENDING', '余额通知尚未匹配到已确认的 SEP 原划转，请等待原单恢复', event);
      }
    } else {
      const settlement = event.execution_id ? await tx.computeIntegrationSettlement.findUnique({ where: { executionId: event.execution_id } }) : null;
      // The receipt sequence is the settlement watermark; mixed settlements write paid then free.
      const mixed = settlement && settlement.paidCny.gt(0) && settlement.freeCny.gt(0);
      const expectedSequence = settlement?.remoteSequence
        ? BigInt(settlement.remoteSequence) - (event.type === 'paid_consumption' && mixed ? 1n : 0n) : null;
      if (!settlement || settlement.enterpriseId !== event.enterprise_id || event.settlement_id !== `settle_${settlement.id}`
        || settlement.status !== 'COMMITTED' || !settlement.unpaidCny.isZero()
        || expectedSequence !== BigInt(event.sequence)
        || (event.type === 'paid_consumption' ? settlement.remoteLedgerId !== event.event_id
            || !settlement.paidCny.eq(event.amount_cny) || !new Decimal(event.free_cny).isZero()
          : !settlement.freeCny.eq(event.free_cny)
            || settlement.paidCny.isZero() && settlement.remoteLedgerId !== event.event_id)) {
        this.conflict('COMPUTE_EVENT_ORIGINAL_SETTLEMENT_PENDING', '余额通知尚未匹配到已确认的 SEP 原结算，请等待原单恢复', event);
      }
    }
  }

  async initializeBaseline(enterpriseId: string, after: string) {
    const first = await this.remote.balanceEvents(enterpriseId, '0', 1);
    if (first.items.length && BigInt(first.items[0].sequence) !== BigInt(after) + 1n) {
      this.conflict('COMPUTE_EVENT_BASELINE_INVALID', '迁移起点必须恰好位于最早同步事件之前，不能跳过事件');
    }
    const snapshot = await this.remote.ledger(enterpriseId, after, after, 1);
    if (snapshot.snapshot_sequence !== after) this.conflict('COMPUTE_EVENT_BASELINE_INVALID', '迁移水位与远端快照不一致');
    await this.prisma.$transaction(async tx => {
      await this.lock(tx, enterpriseId);
      const current = await tx.computeBalanceSyncState.findUnique({ where: { enterpriseId } });
      if (current && current.sequence !== 0n) this.conflict('COMPUTE_EVENT_BASELINE_ALREADY_SET', '同步水位已推进，不能重新设置迁移起点');
      if (after !== '0') {
        const matched = await tx.computeIntegrationReconciliation.findFirst({ where: { enterpriseId, sequence: after, status: 'MATCHED' }, orderBy: { createdAt: 'desc' } });
        if (!matched || !matched.localBalanceCny.eq(snapshot.total_paid_cny)) this.conflict('COMPUTE_EVENT_BASELINE_NOT_RECONCILED', '该历史水位没有金额一致的已核对记录，请先完成原账务对账');
      }
      await tx.computeBalanceSyncState.upsert({ where: { enterpriseId }, create: { enterpriseId, sequence: BigInt(after), baselineSequence: BigInt(after) },
        update: { sequence: BigInt(after), baselineSequence: BigInt(after), lastError: null } });
    });
    return this.status(enterpriseId);
  }

  async acknowledge(enterpriseId: string, eventId: string) {
    const row = await this.prisma.computeBalanceEvent.findUniqueOrThrow({ where: { eventId } });
    if (row.enterpriseId !== enterpriseId || row.status !== 'APPLIED') this.conflict('COMPUTE_EVENT_NOT_APPLIED', '事件尚未在 SEP 完成入账，不能确认');
    if (row.acknowledgedAt) return;
    try { await this.remote.acknowledgeBalanceEvent(enterpriseId, eventId); }
    catch (error) {
      throw new ServiceUnavailableException({ code: 'COMPUTE_EVENT_ACK_PENDING',
        message: `余额事件已在 SEP 入账，远端确认待恢复：${error instanceof Error ? error.message : '确认失败'}`,
        event_id: eventId, enterprise_id: enterpriseId, accounting_status: 'committed', event_status: 'applied',
        retryable: true, next_action: 'retry_original_event_ack', diagnostic: exceptionDetails(error) });
    }
    await this.prisma.computeBalanceEvent.update({ where: { id: row.id }, data: { acknowledgedAt: new Date() } });
  }

  async sync(enterpriseId: string) {
    try {
      const state = await this.prisma.computeBalanceSyncState.findUnique({ where: { enterpriseId } });
      let after = (state?.sequence ?? 0n).toString();
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = await this.remote.balanceEvents(enterpriseId, after, 100);
        for (const item of page.items) {
          await this.receive(item.payload);
          await this.acknowledge(enterpriseId, item.event_id);
        }
        after = page.after_sequence;
        if (!page.has_more) break;
      }
      const pending = await this.prisma.computeBalanceEvent.findMany({ where: { enterpriseId, status: 'APPLIED', acknowledgedAt: null }, orderBy: { sequence: 'asc' }, take: 100 });
      for (const row of pending) await this.acknowledge(enterpriseId, row.eventId);
      await this.recoverOutstanding(enterpriseId);
      await this.prisma.computeBalanceSyncState.upsert({ where: { enterpriseId }, create: { enterpriseId, lastPolledAt: new Date() }, update: { lastPolledAt: new Date(), lastError: null } });
      return this.status(enterpriseId);
    } catch (error) {
      await this.recordError(enterpriseId, error);
      throw error;
    }
  }

  async status(enterpriseId: string) {
    const [state, events] = await Promise.all([
      this.prisma.computeBalanceSyncState.findUnique({ where: { enterpriseId } }),
      this.prisma.computeBalanceEvent.findMany({ where: { enterpriseId }, orderBy: { sequence: 'desc' }, take: 50 }),
    ]);
    return { state: state ? { ...state, sequence: state.sequence.toString(), baselineSequence: state.baselineSequence.toString() } : null,
      events: events.map(row => ({ eventId: row.eventId, sequence: row.sequence.toString(), origin: row.origin, type: row.type,
        deltaCny: row.deltaCny.toFixed(6), businessRef: (row.payload as Prisma.JsonObject).business_ref,
        outstandingCny: row.outstandingCny.toFixed(6), allocation: row.allocation,
        status: row.status, appliedAt: row.appliedAt, acknowledgedAt: row.acknowledgedAt })) };
  }
}
