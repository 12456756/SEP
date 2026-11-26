import { ConflictException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, type MediaRealBillingReservation } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveWindow, USED_SUM_SELECT } from '../compute-credit/member-allowance-window';
import { computeAvailability, allocateTopUps, sumTopUpRemaining } from '../compute-credit/allowance-carryover';
import { resolvePeriodWindow } from '../compute-credit/allowance-period';
import { isSupportedImageModel } from './image-model-contract';
import type { PaymentMode } from 'shared';
import { readPaymentMode } from '../compute-credit/payment-preference';

export interface MediaFunding { creditCny: string; memberWalletCny: string; personalCny: string; paymentMode?: PaymentMode }

type MutableJsonObject = { [key: string]: Prisma.InputJsonValue | null };

type Status = 'RESERVED' | 'SETTLED' | 'RELEASED' | 'RECONCILING';
const zero = () => new Decimal(0);
const MAX_MONEY = new Decimal('99999999.999999');
const forbidden = (code: 'INSUFFICIENT_FUNDS' | 'INVALID_PARAMETER' | 'IDEMPOTENCY_CONFLICT' | 'BILLING_PENDING'): never => {
  const status = code === 'INSUFFICIENT_FUNDS' ? 402 : 409;
  const message = {
    INSUFFICIENT_FUNDS: 'Insufficient funds',
    INVALID_PARAMETER: 'Invalid media billing parameter',
    IDEMPOTENCY_CONFLICT: 'Media billing request conflicts with the original reservation',
    BILLING_PENDING: 'Media billing is pending; query the original request',
  }[code];
  throw new HttpException({ message, error: {
    code, message, type: 'invalid_request_error',
    source: 'platform', param: null,
  } }, status);
};
class BillingConcurrencyConflict extends ConflictException {
  constructor() { super('media billing changed concurrently'); }
}

@Injectable()
export class MediaRealBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async quoteFunding(claims: ClientEmploymentClaims, amountCny: string): Promise<MediaFunding> {
    const amount = this.amount(amountCny);
    const split = await this.transaction(tx => this.allocate(tx, claims, amount));
    return { creditCny: split.creditCny.toFixed(6), memberWalletCny: split.memberWalletCny.toFixed(6), personalCny: split.personalCny.toFixed(6), paymentMode: split.paymentMode };
  }

  async reserve(claims: ClientEmploymentClaims, receiptId: string, amountCny: string, usdToCnyRate: number, paymentMode: PaymentMode = 'AUTO'): Promise<void> {
    const amount = this.amount(amountCny);
    if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0) forbidden('INVALID_PARAMETER');
    const rate = new Decimal(usdToCnyRate);
    // Decimal(10,4): reject loss of precision rather than silently freezing a different rate.
    if (rate.greaterThan('999999.9999') || !rate.equals(rate.toDecimalPlaces(4))) forbidden('INVALID_PARAMETER');
    await this.transaction(async tx => {
      const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${claims.sub} FOR UPDATE`;
      if (!users[0] || users[0].status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
      const enterprises = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM enterprises WHERE id = ${claims.enterpriseId} FOR UPDATE`;
      if (enterprises[0]?.status !== 'ACTIVE') throw new UnauthorizedException('Enterprise is not active');
      const prior = await tx.mediaRealBillingReservation.findUnique({ where: { receiptId } });
      if (prior) {
        if (prior.enterpriseId !== claims.enterpriseId || prior.userId !== claims.sub || prior.subscriptionId !== claims.subscriptionId
          || !prior.reservedCny.equals(amount) || !prior.usdToCnyRate.equals(rate)) forbidden('IDEMPOTENCY_CONFLICT');
        if (prior.status !== 'RESERVED') forbidden('BILLING_PENDING');
        return;
      }
      const split = await this.allocate(tx, claims, amount, receiptId, paymentMode);
      await tx.mediaRealBillingReservation.create({ data: {
        receiptId, enterpriseId: claims.enterpriseId, userId: claims.sub, subscriptionId: claims.subscriptionId,
        creditId: split.creditId, reservedCny: amount, creditCny: split.creditCny,
        memberWalletCny: split.memberWalletCny, personalCny: split.personalCny,
        usdToCnyRate: rate, sourceSnapshot: split.sourceSnapshot,
      } });
    });
  }

  async settle(receiptId: string, actualCny: string, actualUsd: string, verifiedModel: string): Promise<'SETTLED' | 'RECONCILING'> {
    if (!isSupportedImageModel(verifiedModel)) forbidden('INVALID_PARAMETER');
    return this.settleVerified(receiptId, actualCny, actualUsd, verifiedModel);
  }

  async settleVideo(receiptId: string, actualCny: string, actualUsd: string, verifiedModel: string): Promise<'SETTLED' | 'RECONCILING'> {
    if (verifiedModel !== 'minimax-h3') forbidden('INVALID_PARAMETER');
    return this.settleVerified(receiptId, actualCny, actualUsd, verifiedModel);
  }

  async settleNegotiated(receiptId: string, actualCny: string, actualUsd: string,
    verifiedModel: string, frozenModel: string): Promise<'SETTLED' | 'RECONCILING'> {
    if (typeof frozenModel !== 'string' || !/^[^\s\p{Cc}\p{Cf}]{1,160}$/u.test(frozenModel)
      || verifiedModel !== frozenModel) forbidden('BILLING_PENDING');
    return this.settleVerified(receiptId, actualCny, actualUsd, verifiedModel);
  }

  private async settleVerified(receiptId: string, actualCny: string, actualUsd: string, verifiedModel: string): Promise<'SETTLED' | 'RECONCILING'> {
    const cny = this.amount(actualCny, true); const usd = this.amount(actualUsd, true);
    return this.transaction(async tx => {
      const row = await tx.mediaRealBillingReservation.findUnique({ where: { receiptId } });
      if (!row) forbidden('BILLING_PENDING');
      await this.lockExistingUser(tx, row.userId);
      if (row.status === 'SETTLED' || row.status === 'RECONCILING') {
        if (!row.settledCny?.equals(cny) || !row.settledUsd?.equals(usd)) forbidden('IDEMPOTENCY_CONFLICT');
        return row.status;
      }
      if (row.status !== 'RESERVED') forbidden('BILLING_PENDING');
      const status = cny.greaterThan(row.reservedCny) ? 'RECONCILING' : 'SETTLED';
      // Claim the transition before refunding. All source mutations and audit records roll back
      // together if a competing settle/release wins or any source balance has changed.
      await this.transition(tx, receiptId, { status, settledCny: cny, settledUsd: usd });
      if (status === 'RECONCILING') return status;
      const subscription = await tx.subscription.findFirst({
        where: { id: row.subscriptionId, enterpriseId: row.enterpriseId }, select: { employeeId: true },
      });
      const snapshot = this.snapshot(row);
      const refund = await this.refundDifference(tx, row, row.reservedCny.sub(cny));
      await tx.computeUsageRecord.create({ data: {
        paymentMode: snapshot.paymentMode === 'PERSONAL_ONLY' ? 'PERSONAL_ONLY' : snapshot.paymentMode === 'ENTERPRISE_ONLY' ? 'ENTERPRISE_ONLY' : 'AUTO',
        enterpriseId: row.enterpriseId, subscriptionId: row.subscriptionId, creditId: row.creditId,
        employeeId: subscription?.employeeId ?? null,
        userId: row.userId, modelId: verifiedModel, inputTokens: 0, outputTokens: 0,
        inputPriceUsdPerMillion: 0, outputPriceUsdPerMillion: 0, usdToCnyRate: row.usdToCnyRate,
        costCNY: cny, creditPaidCNY: Decimal.min(row.creditCny, cny),
        memberWalletPaidCNY: Decimal.min(row.memberWalletCny, Decimal.max(0, cny.sub(row.creditCny))),
        personalPaidCNY: Decimal.max(0, cny.sub(row.creditCny).sub(row.memberWalletCny)),
        allowanceWindowId: typeof snapshot.allowanceWindowId === 'string' ? snapshot.allowanceWindowId : null,
        personalWalletTransactionId: typeof snapshot.personalWalletTransactionId === 'string' ? snapshot.personalWalletTransactionId : null,
        unpaidCNY: 0, idempotencyKey: `media-real:${receiptId}`,
      } });
      await tx.mediaRealBillingReservation.update({ where: { receiptId }, data: { sourceSnapshot: { ...snapshot, refund } } });
      return status;
    });
  }

  async release(receiptId: string): Promise<void> {
    await this.transaction(async tx => {
      const row = await tx.mediaRealBillingReservation.findUnique({ where: { receiptId } });
      if (!row || row.status === 'RELEASED') return;
      await this.lockExistingUser(tx, row.userId);
      if (row.status !== 'RESERVED') forbidden('BILLING_PENDING');
      await this.transition(tx, receiptId, { status: 'RELEASED' });
      const refund = await this.refundDifference(tx, row, row.reservedCny);
      await tx.mediaRealBillingReservation.update({ where: { receiptId }, data: { sourceSnapshot: { ...this.snapshot(row), refund } } });
    });
  }

  async status(receiptId: string): Promise<Status> {
    const row = await this.prisma.mediaRealBillingReservation.findUnique({ where: { receiptId }, select: { status: true } });
    if (!row || !['RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING'].includes(row.status)) forbidden('BILLING_PENDING');
    return row.status as Status;
  }

  private async allocate(tx: Prisma.TransactionClient, claims: ClientEmploymentClaims, amount: Decimal, receiptId?: string, expectedMode?: PaymentMode) {
    const paymentMode = await readPaymentMode(tx, claims.enterpriseId, claims.sub);
    if (expectedMode !== undefined && paymentMode !== expectedMode) {
      throw new HttpException({ error: { code: 'PAYMENT_MODE_CHANGED', message: '付款方式已变化，请重新报价',
        type: 'invalid_request_error', source: 'platform', param: 'quoteId' } }, 409);
    }
    const credit = await tx.subscriptionCredit.findUnique({ where: { subscriptionId: claims.subscriptionId } });
    const creditAvailable = credit?.enterpriseId === claims.enterpriseId && credit.status === 'ACTIVE'
      ? Decimal.max(0, credit.grantedCNY.sub(credit.usedCNY)) : zero();
    const allowance = await tx.memberComputeAllowance.findUnique({ where: { enterpriseId_userId: { enterpriseId: claims.enterpriseId, userId: claims.sub } } });
    const topUps = (await tx.memberAllowanceTopUp.findMany({ where: { enterpriseId: claims.enterpriseId, userId: claims.sub }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
      .filter(row => row.consumedCNY.lessThan(row.amountCNY));
    const memberAvailable = sumTopUpRemaining(topUps);
    let enterpriseCap: Decimal | null = null;
    let allowanceWindowId: string | null = null;
    if (paymentMode !== 'PERSONAL_ONLY' && allowance?.enabled && (allowance.limitCNY || allowance.dailyLimitCNY || allowance.monthlyLimitCNY)) {
      const now = new Date();
      const window = await resolveWindow(tx, allowance, now, receiptId !== undefined);
      allowanceWindowId = window.windowId;
      // Unresolved freezes remain liabilities across period boundaries, including unknown
      // execution outcomes and reconciliation. Only settled/released rows free this capacity.
      const pending = await tx.mediaRealBillingReservation.aggregate({
        where: { enterpriseId: claims.enterpriseId, userId: claims.sub, status: { in: ['RESERVED', 'RECONCILING'] } },
        _sum: { creditCny: true, memberWalletCny: true },
      });
      const frozen = (pending._sum.creditCny ?? zero()).add(pending._sum.memberWalletCny ?? 0);
      const usedFor = async (period: 'DAY' | 'MONTH') => {
        const { start, end } = resolvePeriodWindow(period, now);
        const usage = await tx.computeUsageRecord.aggregate({
          where: { enterpriseId: claims.enterpriseId, userId: claims.sub, paymentMode: { not: 'PERSONAL_ONLY' }, createdAt: { gte: start, lt: end } }, _sum: USED_SUM_SELECT,
        });
        return Object.values(usage._sum).reduce((sum, value) => sum.add(value ?? 0), frozen);
      };
      const parallelConfigured = Boolean(allowance.dailyLimitCNY || allowance.monthlyLimitCNY);
      // Shared window usage already includes unresolved freezes. Only the direct
      // settled-usage aggregates in usedFor above need the local frozen amount.
      const base = computeAvailability({ limitCNY: window.limitCNY, carriedInCNY: window.carriedInCNY,
        usedCNY: window.usedCNY, topUpRemainingCNY: memberAvailable });
      enterpriseCap = parallelConfigured ? null : base.totalRemainingCNY;
      const cap = (remaining: Decimal) => { enterpriseCap = enterpriseCap === null ? remaining : Decimal.min(enterpriseCap, remaining); };
      // Match the member charge gate's legacy DAY/MONTH fallback and bypass semantics.
      const dailyLimit = allowance.dailyLimitCNY ?? (allowance.period === 'DAY' ? allowance.limitCNY : null);
      const monthlyLimit = allowance.monthlyLimitCNY ?? (allowance.period === 'MONTH' ? allowance.limitCNY : null);
      if (dailyLimit && !(allowance.dailyBypassUntil && allowance.dailyBypassUntil > now)) cap(dailyLimit.sub(await usedFor('DAY')));
      if (monthlyLimit) cap(monthlyLimit.add(window.carriedInCNY).sub(await usedFor('MONTH')));
      if (enterpriseCap !== null) enterpriseCap = Decimal.max(0, enterpriseCap);
    }
    // Both gift credit and member top-ups are enterprise funds subject to the same cap.
    const enterpriseAmount = paymentMode === 'PERSONAL_ONLY' ? zero() : enterpriseCap === null ? amount : Decimal.min(amount, enterpriseCap);
    const creditCny = Decimal.min(enterpriseAmount, creditAvailable);
    const memberWalletCny = Decimal.min(enterpriseAmount.sub(creditCny), memberAvailable);
    const personalCny = amount.sub(creditCny).sub(memberWalletCny);
    if (paymentMode === 'ENTERPRISE_ONLY' && personalCny.gt(0)) {
      throw new HttpException({ error: { code: 'INSUFFICIENT_FUNDS', message: '已选择仅企业余额，当前可用企业资金或分配限额不足，请充值或切换付款方式',
        type: 'invalid_request_error', source: 'platform', paymentMode } }, 402);
    }
    const personal = await tx.personalWallet.findUnique({ where: { userId: claims.sub } });
    if (personalCny.greaterThan(personal?.balance ?? 0)) forbidden('INSUFFICIENT_FUNDS');
    const topUpAllocations = allocateTopUps(topUps, memberWalletCny).allocations;
    const creditId = creditCny.greaterThan(0) && credit ? credit.id : null;
    const sourceSnapshot: MutableJsonObject = {
      paymentMode,
      creditId, creditBefore: creditId ? credit!.usedCNY.toFixed(6) : null,
      creditAfter: creditId ? credit!.usedCNY.add(creditCny).toFixed(6) : null,
      memberWalletAllocations: topUpAllocations.map(a => {
        const source = topUps.find(t => t.id === a.id)!;
        return { id: a.id, amount: a.consumeCNY.toFixed(6), consumedBefore: source.consumedCNY.toFixed(6), consumedAfter: source.consumedCNY.add(a.consumeCNY).toFixed(6) };
      }),
      creditCny: creditCny.toFixed(6), memberWalletCny: memberWalletCny.toFixed(6), personalCny: personalCny.toFixed(6),
      personalWalletId: personalCny.greaterThan(0) ? personal?.id ?? null : null,
      personalBalanceBefore: personalCny.greaterThan(0) ? personal?.balance.toFixed(6) ?? null : null,
      personalBalanceAfter: personalCny.greaterThan(0) ? personal?.balance.sub(personalCny).toFixed(6) ?? null : null,
      allowanceWindowId,
    };
    if (receiptId !== undefined) {
      if (creditCny.greaterThan(0) && credit) {
        const result = await tx.subscriptionCredit.updateMany({ where: { id: credit.id, version: credit.version, status: 'ACTIVE', usedCNY: { lte: credit.grantedCNY.sub(creditCny) } },
          data: { usedCNY: { increment: creditCny }, status: credit.usedCNY.add(creditCny).equals(credit.grantedCNY) ? 'EXHAUSTED' : 'ACTIVE', version: { increment: 1 } } });
        if (!result.count) throw new BillingConcurrencyConflict();
      }
      for (const part of topUpAllocations) {
        const source = topUps.find(t => t.id === part.id)!;
        const result = await tx.memberAllowanceTopUp.updateMany({ where: { id: part.id, version: part.version, consumedCNY: { lte: source.amountCNY.sub(part.consumeCNY) } }, data: { consumedCNY: { increment: part.consumeCNY }, version: { increment: 1 } } });
        if (!result.count) throw new BillingConcurrencyConflict();
      }
      if (personalCny.greaterThan(0) && personal) {
        const result = await tx.personalWallet.updateMany({ where: { id: personal.id, version: personal.version, balance: { gte: personalCny }, totalConsumeCNY: { lte: MAX_MONEY.sub(personalCny) } }, data: { balance: { decrement: personalCny }, totalConsumeCNY: { increment: personalCny }, version: { increment: 1 } } });
        if (!result.count) throw new BillingConcurrencyConflict();
        const entry = await tx.personalWalletTransaction.create({ data: { walletId: personal.id, type: 'CONSUME', amount: personalCny.neg(), balanceBefore: personal.balance, balanceAfter: personal.balance.sub(personalCny), relatedType: 'media-real', relatedId: receiptId, description: '真实图片费用预留' } });
        sourceSnapshot.personalWalletTransactionId = entry.id;
      }
    }
    return { creditId, creditCny, memberWalletCny, personalCny, sourceSnapshot, paymentMode };
  }

  private async refundDifference(tx: Prisma.TransactionClient, row: MediaRealBillingReservation, amount: Decimal): Promise<Prisma.InputJsonObject> {
    const snapshot = this.snapshot(row);
    if (!row.creditCny.add(row.memberWalletCny).add(row.personalCny).equals(row.reservedCny)
      || [row.creditCny, row.memberWalletCny, row.personalCny, amount].some(value => value.lessThan(0))
      || amount.greaterThan(row.reservedCny)) forbidden('BILLING_PENDING');
    const allocations = snapshot.memberWalletAllocations;
    if (!Array.isArray(allocations)) forbidden('BILLING_PENDING');
    const parts: { id: string; amount: Decimal }[] = [];
    for (const value of allocations as unknown[]) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) forbidden('BILLING_PENDING');
      const item = value as Record<string, unknown>;
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || typeof item.amount !== 'string'
        || parts.some(part => part.id === item.id)) forbidden('BILLING_PENDING');
      parts.push({ id: item.id as string, amount: this.amount(item.amount as string) });
    }
    if (!parts.reduce((sum, part) => sum.add(part.amount), zero()).equals(row.memberWalletCny)) forbidden('BILLING_PENDING');
    let refund = amount;
    const audit: MutableJsonObject = { amountCny: amount.toFixed(6) };
    const personal = Decimal.min(refund, row.personalCny); refund = refund.sub(personal);
    if (personal.greaterThan(0)) {
      const wallet = await tx.personalWallet.findUnique({ where: { userId: row.userId } });
      if (!wallet || (snapshot.personalWalletId && snapshot.personalWalletId !== wallet.id)) forbidden('BILLING_PENDING');
      const result = await tx.personalWallet.updateMany({ where: { id: wallet.id, version: wallet.version, balance: { lte: MAX_MONEY.sub(personal) }, totalConsumeCNY: { gte: personal } },
        data: { balance: { increment: personal }, totalConsumeCNY: { decrement: personal }, version: { increment: 1 } } });
      if (!result.count) throw new BillingConcurrencyConflict();
      const entry = await tx.personalWalletTransaction.create({ data: { walletId: wallet.id, type: 'REFUND', amount: personal, balanceBefore: wallet.balance, balanceAfter: wallet.balance.add(personal), relatedType: 'media-real', relatedId: row.receiptId, description: '真实图片费用预留退回' } });
      audit.personal = { amount: personal.toFixed(6), balanceBefore: wallet.balance.toFixed(6), balanceAfter: wallet.balance.add(personal).toFixed(6), transactionId: entry.id };
    }
    const member = Decimal.min(refund, row.memberWalletCny); refund = refund.sub(member);
    const memberAudit: Prisma.InputJsonObject[] = [];
    let remaining = member;
    for (const item of [...parts].reverse()) {
      if (!remaining.greaterThan(0)) break;
      const part = Decimal.min(remaining, item.amount); remaining = remaining.sub(part);
      const source = await tx.memberAllowanceTopUp.findUnique({ where: { id: item.id } });
      if (!source || source.enterpriseId !== row.enterpriseId || source.userId !== row.userId) forbidden('BILLING_PENDING');
      const result = await tx.memberAllowanceTopUp.updateMany({ where: { id: source.id, version: source.version, consumedCNY: { gte: part } }, data: { consumedCNY: { decrement: part }, version: { increment: 1 } } });
      if (!result.count) throw new BillingConcurrencyConflict();
      memberAudit.push({ id: source.id, amount: part.toFixed(6), consumedBefore: source.consumedCNY.toFixed(6), consumedAfter: source.consumedCNY.sub(part).toFixed(6) });
    }
    audit.memberWallet = memberAudit;
    if (refund.greaterThan(0)) {
      if (!row.creditId) forbidden('BILLING_PENDING');
      const credit = await tx.subscriptionCredit.findUnique({ where: { id: row.creditId } });
      if (!credit || credit.enterpriseId !== row.enterpriseId || credit.subscriptionId !== row.subscriptionId) forbidden('BILLING_PENDING');
      // Only an exhausted credit can be reopened; expiry/admin disablement survives refunds.
      const status = credit.status === 'EXHAUSTED' && credit.usedCNY.sub(refund).lessThan(credit.grantedCNY) ? 'ACTIVE' : credit.status;
      const result = await tx.subscriptionCredit.updateMany({ where: { id: credit.id, version: credit.version, status: credit.status, usedCNY: { gte: refund } }, data: { usedCNY: { decrement: refund }, status, version: { increment: 1 } } });
      if (!result.count) throw new BillingConcurrencyConflict();
      audit.credit = { id: credit.id, amount: refund.toFixed(6), usedBefore: credit.usedCNY.toFixed(6), usedAfter: credit.usedCNY.sub(refund).toFixed(6), statusBefore: credit.status, statusAfter: status };
    }
    return audit;
  }

  private snapshot(row: MediaRealBillingReservation): Prisma.InputJsonObject {
    if (!row.sourceSnapshot || typeof row.sourceSnapshot !== 'object' || Array.isArray(row.sourceSnapshot)) forbidden('BILLING_PENDING');
    return row.sourceSnapshot as Prisma.InputJsonObject;
  }

  private async transition(tx: Prisma.TransactionClient, receiptId: string, data: Prisma.MediaRealBillingReservationUpdateManyMutationInput) {
    const result = await tx.mediaRealBillingReservation.updateMany({ where: { receiptId, status: 'RESERVED' }, data });
    if (!result.count) throw new BillingConcurrencyConflict();
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const retryable = error instanceof BillingConcurrencyConflict || (error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === 'P2034' || (error.code === 'P2002' && String(error.meta?.target).includes('receiptId'))));
        if (!retryable) throw error;
        if (attempt >= 2) throw new BillingConcurrencyConflict();
      }
    }
  }

  private async lockExistingUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const users = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!users[0] || !['ACTIVE', 'CLOSURE_PENDING'].includes(users[0].status)) {
      throw new ConflictException('账号状态不允许关闭待处理媒体账单');
    }
  }

  private amount(value: string, allowZero = false): Decimal {
    if (typeof value !== 'string' || !/^\d{1,8}\.\d{6}$/.test(value)) forbidden('INVALID_PARAMETER');
    const result = new Decimal(value);
    if (result.greaterThan(MAX_MONEY) || result.lessThan(0) || (!allowZero && result.isZero())) forbidden('INVALID_PARAMETER');
    return result;
  }
}
