import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import * as allowanceWindow from '../compute-credit/member-allowance-window';
import { MediaRealBillingService } from './media-real-billing.service';

const d = (value: string | number) => new Decimal(value);
const claims: ClientEmploymentClaims = {
  sub: 'user-1', sid: 'session-1', enterpriseId: 'enterprise-1', subscriptionId: 'subscription-1',
  memberId: 'member-1', type: 'client-employment', iat: 1, exp: 9999999999,
};
const wallet = () => ({ id: 'wallet-1', userId: claims.sub, balance: d(20), totalConsumeCNY: d(5), version: 0 });
const credit = () => ({ id: 'credit-1', enterpriseId: claims.enterpriseId, subscriptionId: claims.subscriptionId,
  status: 'ACTIVE', grantedCNY: d(10), usedCNY: d(3), version: 4 });
const topUp = (id = 'topup-1') => ({ id, enterpriseId: claims.enterpriseId, userId: claims.sub,
  amountCNY: d(5), consumedCNY: d(1), version: 2, createdAt: new Date() });
const reservation = () => ({ receiptId: 'receipt-1', enterpriseId: claims.enterpriseId,
  userId: claims.sub, subscriptionId: claims.subscriptionId, creditId: null, reservedCny: d(5),
  creditCny: d(0), memberWalletCny: d(0), personalCny: d(5),
  sourceSnapshot: { memberWalletAllocations: [], personalWalletId: 'wallet-1', allowanceWindowId: 'window-1', personalWalletTransactionId: 'consume-1' },
  settledCny: null, settledUsd: null, usdToCnyRate: d(7), status: 'RESERVED' });
const allowance = () => ({ id: 'allowance-1', enterpriseId: claims.enterpriseId, userId: claims.sub,
  enabled: true, limitCNY: d(5), period: 'MONTH', carryOver: false,
  dailyLimitCNY: null as Decimal | null, monthlyLimitCNY: null as Decimal | null, dailyBypassUntil: null as Date | null });
const txMock = () => ({
  enterpriseMember: { findUnique: jest.fn().mockResolvedValue({ paymentMode: 'AUTO' }) },
  $queryRaw: jest.fn().mockResolvedValue([{ id: claims.sub, status: 'ACTIVE' }]),
  mediaRealBillingReservation: {
    findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    aggregate: jest.fn().mockResolvedValue({ _sum: { creditCny: d(0), memberWalletCny: d(0) } }),
  },
  subscription: { findFirst: jest.fn().mockResolvedValue({ employeeId: 'employee-1' }) },
  subscriptionCredit: { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  memberComputeAllowance: { findUnique: jest.fn().mockResolvedValue(null) },
  memberAllowanceWindow: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'window-1' }) },
  memberAllowanceTopUp: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(topUp()), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  personalWallet: { findUnique: jest.fn().mockResolvedValue(wallet()), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  personalWalletTransaction: { create: jest.fn().mockResolvedValue({ id: 'transaction-1' }) },
  computeUsageRecord: { create: jest.fn(), aggregate: jest.fn().mockResolvedValue({ _sum: { creditPaidCNY: d(0), memberWalletPaidCNY: d(0), walletPaidCNY: d(0), unpaidCNY: d(0) } }) },
});
const code = (value: string) => ({ response: { error: { code: value } } });

describe('MediaRealBillingService', () => {
  let tx: ReturnType<typeof txMock>;
  let service: MediaRealBillingService;
  let prisma: { $transaction: jest.Mock };
  beforeEach(() => {
    tx = txMock();
    prisma = { $transaction: jest.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)) };
    service = new MediaRealBillingService(prisma as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('personal-only ignores company caps and gifts, and freezes the source for later refund', async () => {
    tx.enterpriseMember.findUnique.mockResolvedValue({ paymentMode: 'PERSONAL_ONLY' });
    tx.subscriptionCredit.findUnique.mockResolvedValue(credit());
    tx.memberAllowanceTopUp.findMany.mockResolvedValue([topUp()]);
    tx.memberComputeAllowance.findUnique.mockResolvedValue({ ...allowance(), dailyLimitCNY: d(0) });
    expect(await service.quoteFunding(claims, '5.000000')).toEqual({
      paymentMode: 'PERSONAL_ONLY', creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '5.000000',
    });
    await service.reserve(claims, 'receipt-personal', '5.000000', 7, 'PERSONAL_ONLY');
    expect(tx.subscriptionCredit.updateMany).not.toHaveBeenCalled();
    expect(tx.memberAllowanceTopUp.updateMany).not.toHaveBeenCalled();
    expect(tx.memberAllowanceWindow.create).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      personalCny: d(5), sourceSnapshot: expect.objectContaining({ paymentMode: 'PERSONAL_ONLY', allowanceWindowId: null }),
    }) });
    tx.enterpriseMember.findUnique.mockResolvedValue({ paymentMode: 'ENTERPRISE_ONLY' });
    const row = { ...reservation(), sourceSnapshot: { ...reservation().sourceSnapshot, paymentMode: 'PERSONAL_ONLY' } };
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(row);
    await service.release('receipt-1');
    expect(tx.personalWallet.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ balance: { increment: d(5) } }) }));
  });

  it('enterprise-only rejects insufficient company funding before touching personal funds', async () => {
    tx.enterpriseMember.findUnique.mockResolvedValue({ paymentMode: 'ENTERPRISE_ONLY' });
    await expect(service.quoteFunding(claims, '5.000000')).rejects.toMatchObject({ status: 402 });
    await expect(service.reserve(claims, 'receipt-company', '5.000000', 7, 'ENTERPRISE_ONLY')).rejects.toMatchObject({ status: 402 });
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.create).not.toHaveBeenCalled();
  });

  it('requires a fresh quote after changing preference, without reserving or debiting', async () => {
    tx.enterpriseMember.findUnique.mockResolvedValue({ paymentMode: 'PERSONAL_ONLY' });
    await expect(service.reserve(claims, 'receipt-change', '5.000000', 7, 'AUTO'))
      .rejects.toMatchObject({ status: 409, response: { error: { code: 'PAYMENT_MODE_CHANGED', message: '付款方式已变化，请重新报价' } } });
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(tx.subscriptionCredit.updateMany).not.toHaveBeenCalled();
  });

  it('replays an existing reservation after switching without allocating again', async () => {
    tx.enterpriseMember.findUnique.mockResolvedValue({ paymentMode: 'PERSONAL_ONLY' });
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    await service.reserve(claims, 'receipt-1', '5.000000', 7, 'AUTO');
    expect(tx.enterpriseMember.findUnique).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('quotes without mutations and reserves the same receipt only once', async () => {
    await expect(service.quoteFunding(claims, '3.500000')).resolves.toEqual({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '3.500000', paymentMode: 'AUTO' });
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    tx.mediaRealBillingReservation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...reservation(), reservedCny: d('3.5'), usdToCnyRate: d('7.1234'),
    });
    await service.reserve(claims, 'receipt-1', '3.500000', 7.1234);
    await service.reserve(claims, 'receipt-1', '3.500000', 7.1234);
    expect(tx.personalWallet.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledTimes(1);
    expect(tx.personalWalletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ relatedId: 'receipt-1', type: 'CONSUME', balanceBefore: d(20), balanceAfter: d('16.5') }) });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('rejects even an idempotent reserve for %s accounts', async status => {
    tx.$queryRaw.mockResolvedValue([{ id: claims.sub, status }]);
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    await expect(service.reserve(claims, 'receipt-1', '5.000000', 7)).rejects.toMatchObject({ status: 401 });
    expect(tx.mediaRealBillingReservation.findUnique).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('rejects idempotent replay when enterprise closed after authentication', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    await expect(service.reserve(claims, 'receipt-1', '5.000000', 7)).rejects.toThrow('Enterprise is not active');
    expect(tx.mediaRealBillingReservation.findUnique).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'rate', 'amount'])('rejects reuse with a changed %s', async field => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(),
      ...(field === 'subscription' ? { subscriptionId: 'other' } : field === 'rate' ? { usdToCnyRate: d(6) } : { reservedCny: d(6) }),
    });
    await expect(service.reserve(claims, 'receipt-1', '5.000000', 7)).rejects.toMatchObject(code('IDEMPOTENCY_CONFLICT'));
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('refuses insufficient funds before any debit', async () => {
    tx.personalWallet.findUnique.mockResolvedValue({ ...wallet(), balance: d(1) });
    await expect(service.reserve(claims, 'receipt-low', '2.000000', 7)).rejects.toMatchObject({
      status: 402, response: { error: { code: 'INSUFFICIENT_FUNDS', source: 'platform' } },
    });
    expect(tx.mediaRealBillingReservation.create).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('uses gift, member wallet, then personal and snapshots source balances before debit', async () => {
    tx.subscriptionCredit.findUnique.mockResolvedValue({ ...credit(), grantedCNY: d(5) });
    tx.memberAllowanceTopUp.findMany.mockResolvedValue([{ ...topUp(), amountCNY: d(4) }]);
    await service.reserve(claims, 'receipt-order', '6.000000', 7);
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      creditCny: d(2), memberWalletCny: d(3), personalCny: d(1), sourceSnapshot: expect.objectContaining({
        creditBefore: '3.000000', creditAfter: '5.000000', personalWalletTransactionId: 'transaction-1',
        memberWalletAllocations: [{ id: 'topup-1', amount: '3.000000', consumedBefore: '1.000000', consumedAfter: '4.000000' }],
      }),
    }) });
    expect(tx.subscriptionCredit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'EXHAUSTED' }) }));
  });

  it.each(['legacy', 'legacy-weekly', 'daily', 'monthly', 'daily-and-monthly'])('caps gift and top-ups under %s member limits including all unresolved freezes', async mode => {
    const limits = allowance();
    if (mode !== 'legacy') limits.period = 'WEEK';
    if (!mode.startsWith('legacy')) limits.limitCNY = d(100);
    if (mode.includes('daily')) limits.dailyLimitCNY = d(5);
    if (mode.includes('monthly')) limits.monthlyLimitCNY = d(5);
    tx.memberComputeAllowance.findUnique.mockResolvedValue(limits);
    tx.subscriptionCredit.findUnique.mockResolvedValue({ ...credit(), grantedCNY: d(4) }); // only 1 gift available
    tx.memberAllowanceTopUp.findMany.mockResolvedValue([topUp()]);
    tx.computeUsageRecord.aggregate.mockResolvedValue({ _sum: { creditPaidCNY: d(1), memberWalletPaidCNY: d(0), walletPaidCNY: d(0), unpaidCNY: d(0) } });
    tx.mediaRealBillingReservation.aggregate.mockResolvedValue({ _sum: { creditCny: d(1), memberWalletCny: d(1) } });
    await expect(service.quoteFunding(claims, '6.000000')).resolves.toEqual({ creditCny: '1.000000', memberWalletCny: '1.000000', personalCny: '4.000000', paymentMode: 'AUTO' });
    expect(tx.mediaRealBillingReservation.aggregate).toHaveBeenCalledWith({ where: {
      enterpriseId: claims.enterpriseId, userId: claims.sub, status: { in: ['RESERVED', 'RECONCILING'] },
    }, _sum: { creditCny: true, memberWalletCny: true } });
    expect(tx.memberAllowanceWindow.create).not.toHaveBeenCalled();
    expect(tx.subscriptionCredit.updateMany).not.toHaveBeenCalled();
  });

  it.each(['WEEK', 'DAY', 'MONTH'])('counts shared %s window freezes once in quotes and reservations', async period => {
    tx.memberComputeAllowance.findUnique.mockResolvedValue({ ...allowance(), period });
    tx.subscriptionCredit.findUnique.mockResolvedValue({ ...credit(), grantedCNY: d(4) });
    tx.memberAllowanceTopUp.findMany.mockResolvedValue([topUp()]);
    tx.computeUsageRecord.aggregate.mockResolvedValue({ _sum: { creditPaidCNY: d(1), memberWalletPaidCNY: d(0), walletPaidCNY: d(0), unpaidCNY: d(0) } });
    tx.mediaRealBillingReservation.aggregate.mockResolvedValue({ _sum: { creditCny: d(1), memberWalletCny: d(1) } });
    // Shared usage already contains 1 settled + 2 frozen. The local day/month
    // aggregate is deliberately settled-only, so it must still add frozen once.
    const sharedWindow = jest.spyOn(allowanceWindow, 'resolveWindow').mockResolvedValue({
      windowId: 'window-1', periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-11-01T00:00:00Z'),
      limitCNY: d(5), carriedInCNY: d(0), usedCNY: d(3), dailyUsedCNY: d(3), monthlyUsedCNY: d(3),
    });
    await expect(service.quoteFunding(claims, '6.000000')).resolves.toEqual({
      creditCny: '1.000000', memberWalletCny: '1.000000', personalCny: '4.000000', paymentMode: 'AUTO',
    });
    await service.reserve(claims, 'receipt-shared', '6.000000', 7);
    expect(sharedWindow.mock.calls.map(call => call[3])).toEqual([false, true]);
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      creditCny: d(1), memberWalletCny: d(1), personalCny: d(4),
    }) });
    if (period !== 'WEEK') expect(tx.computeUsageRecord.aggregate).toHaveBeenCalledTimes(2);
  });

  it('does not let gift alone bypass an exhausted daily allowance', async () => {
    tx.subscriptionCredit.findUnique.mockResolvedValue(credit());
    tx.memberComputeAllowance.findUnique.mockResolvedValue({ ...allowance(), dailyLimitCNY: d(0) });
    await expect(service.quoteFunding(claims, '3.000000')).resolves.toEqual({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '3.000000', paymentMode: 'AUTO' });
  });

  it('keeps monthly limit while daily bypass is active and ignores legacy cap when parallel limits configured', async () => {
    tx.memberComputeAllowance.findUnique.mockResolvedValue({ ...allowance(), limitCNY: d(1), period: 'WEEK', dailyLimitCNY: d(0), monthlyLimitCNY: d(4), dailyBypassUntil: new Date(Date.now() + 60000) });
    tx.subscriptionCredit.findUnique.mockResolvedValue(credit());
    await expect(service.quoteFunding(claims, '6.000000')).resolves.toEqual({ creditCny: '4.000000', memberWalletCny: '0.000000', personalCny: '2.000000', paymentMode: 'AUTO' });
  });

  it('creates an allowance window only when reserving and attaches it to frozen sources', async () => {
    tx.memberComputeAllowance.findUnique.mockResolvedValue(allowance());
    tx.subscriptionCredit.findUnique.mockResolvedValue(credit());
    await service.quoteFunding(claims, '1.000000');
    expect(tx.memberAllowanceWindow.create).not.toHaveBeenCalled();
    await service.reserve(claims, 'receipt-1', '1.000000', 7);
    expect(tx.memberAllowanceWindow.create).toHaveBeenCalledTimes(1);
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sourceSnapshot: expect.objectContaining({ allowanceWindowId: 'window-1' }) }) });
  });

  it('records the verified model and subscription employee while retaining the media idempotency key', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    await service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2');
    expect(tx.subscription.findFirst).toHaveBeenCalledWith({
      where: { id: claims.subscriptionId, enterpriseId: claims.enterpriseId }, select: { employeeId: true },
    });
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      modelId: 'gpt-image-2', employeeId: 'employee-1', subscriptionId: claims.subscriptionId,
      idempotencyKey: 'media-real:receipt-1', inputTokens: 0, outputTokens: 0,
    }) });
  });

  it('leaves employee attribution empty when the scoped subscription is unavailable', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    tx.subscription.findFirst.mockResolvedValue(null);
    await service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2');
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ employeeId: null }) });
  });

  it('settles confirmed zero, refunds the full reservation and records zero usage', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    await expect(service.settle('receipt-1', '0.000000', '0.000000', 'gpt-image-2')).resolves.toBe('SETTLED');
    expect(tx.personalWallet.updateMany).toHaveBeenCalledWith({ where: { id: 'wallet-1', version: 0, balance: { lte: d('99999994.999999') }, totalConsumeCNY: { gte: d(5) } }, data: { balance: { increment: d(5) }, totalConsumeCNY: { decrement: d(5) }, version: { increment: 1 } } });
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ costCNY: d(0), personalPaidCNY: d(0), creditPaidCNY: d(0), memberWalletPaidCNY: d(0), allowanceWindowId: 'window-1', personalWalletTransactionId: 'consume-1' }) });
    expect(tx.mediaRealBillingReservation.update).toHaveBeenCalledWith({ where: { receiptId: 'receipt-1' }, data: { sourceSnapshot: expect.objectContaining({ refund: expect.objectContaining({ amountCny: '5.000000', personal: { amount: '5.000000', balanceBefore: '20.000000', balanceAfter: '25.000000', transactionId: 'transaction-1' } }) }) } });
  });

  it('refunds personal then newest member batch then gift, leaving costs on earlier sources', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(), reservedCny: d(7), creditCny: d(2), memberWalletCny: d(4), personalCny: d(1), creditId: 'credit-1',
      sourceSnapshot: { memberWalletAllocations: [{ id: 'old', amount: '2.000000' }, { id: 'new', amount: '2.000000' }] } });
    tx.memberAllowanceTopUp.findUnique.mockImplementation(async ({ where }) => ({ ...topUp(where.id), consumedCNY: d(2) }));
    await service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2');
    expect(tx.memberAllowanceTopUp.updateMany.mock.calls.map(([arg]) => [arg.where.id, arg.data.consumedCNY.decrement.toFixed(6)])).toEqual([['new', '2.000000'], ['old', '1.000000']]);
    expect(tx.subscriptionCredit.updateMany).not.toHaveBeenCalled();
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ creditPaidCNY: d(2), memberWalletPaidCNY: d(1), personalPaidCNY: d(0) }) });
  });

  it.each(['EXPIRED', 'DISABLED', 'EXHAUSTED', 'ACTIVE'])('preserves %s credit lifecycle when refunding', async status => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(), creditId: 'credit-1', creditCny: d(5), personalCny: d(0) });
    tx.subscriptionCredit.findUnique.mockResolvedValue({ ...credit(), status, usedCNY: d(5) });
    await service.release('receipt-1');
    expect(tx.subscriptionCredit.updateMany).toHaveBeenCalledWith({ where: { id: 'credit-1', version: 4, status, usedCNY: { gte: d(5) } }, data: { usedCNY: { decrement: d(5) }, status: status === 'EXHAUSTED' ? 'ACTIVE' : status, version: { increment: 1 } } });
  });

  it('retains freeze on over-reserve cost and makes reconciliation retries idempotent', async () => {
    const row = reservation();
    tx.mediaRealBillingReservation.findUnique.mockResolvedValueOnce(row).mockResolvedValue({ ...row, status: 'RECONCILING', settledCny: d('5.000001'), settledUsd: d('0.714286') });
    await expect(service.settle('receipt-1', '5.000001', '0.714286', 'gpt-image-2')).resolves.toBe('RECONCILING');
    await expect(service.settle('receipt-1', '5.000001', '0.714286', 'gpt-image-2')).resolves.toBe('RECONCILING');
    await expect(service.release('receipt-1')).rejects.toMatchObject(code('BILLING_PENDING'));
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(tx.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(tx.subscription.findFirst).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a legacy settled ledger and rejects conflicting actual costs', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(), status: 'SETTLED', settledCny: d(3), settledUsd: d('0.428571') });
    await expect(service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2')).resolves.toBe('SETTLED');
    await expect(service.settle('receipt-1', '0.000000', '0.000000', 'gpt-image-2')).rejects.toMatchObject(code('IDEMPOTENCY_CONFLICT'));
    expect(tx.mediaRealBillingReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(tx.subscription.findFirst).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.update).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('records the model and employee only once when settlement is retried', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValueOnce(reservation()).mockResolvedValue({
      ...reservation(), status: 'SETTLED', settledCny: d(3), settledUsd: d('0.428571'),
    });
    await expect(service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2')).resolves.toBe('SETTLED');
    await expect(service.settle('receipt-1', '3.000000', '0.428571', 'gpt-image-2')).resolves.toBe('SETTLED');
    expect(tx.computeUsageRecord.create).toHaveBeenCalledTimes(1);
    expect(tx.subscription.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.personalWalletTransaction.create).toHaveBeenCalledTimes(1);
    expect(tx.mediaRealBillingReservation.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '', 'media-real', 'other-model'])('rejects missing or unsupported settlement model %s before database access', async model => {
    await expect(service.settle('receipt-1', '3.000000', '0.428571', model as string)).rejects.toMatchObject(code('INVALID_PARAMETER'));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not refund when another operation wins the reservation transition', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValueOnce(reservation()).mockResolvedValue({ ...reservation(), status: 'RELEASED' });
    tx.mediaRealBillingReservation.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.release('receipt-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(tx.personalWalletTransaction.create).not.toHaveBeenCalled();
  });

  it('bounds transaction retries for conflicting source refunds and does not write audit on failure', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue(reservation());
    tx.personalWallet.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.release('receipt-1')).rejects.toThrow('media billing changed concurrently');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.personalWalletTransaction.create).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.update).not.toHaveBeenCalled();
  });

  it('retries a database serialization conflict in a new transaction', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: '6' }));
    await service.reserve(claims, 'receipt-1', '0.000001', 7);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.mediaRealBillingReservation.create).toHaveBeenCalledTimes(1);
  });

  it('rejects corrupt source allocations before refunding any funds', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(), sourceSnapshot: { memberWalletAllocations: [{ id: 'topup-1', amount: '1.000000' }] } });
    await expect(service.release('receipt-1')).rejects.toMatchObject(code('BILLING_PENDING'));
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it.each(['0.000000', '-1.000000', '0.0000001', '100000000.000000', 'NaN', '1e2', '1.1'])('rejects invalid reserve amount %s before database access', async amount => {
    await expect(service.reserve(claims, 'receipt-1', amount, 7)).rejects.toMatchObject(code('INVALID_PARAMETER'));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([0, NaN, Infinity, 0.00001, 7.12345, 1000000])('rejects unrepresentable frozen rate %s', async rate => {
    await expect(service.reserve(claims, 'receipt-1', '1.000000', rate)).rejects.toMatchObject(code('INVALID_PARAMETER'));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each(['-0.000001', '0.0000001', '100000000.000000'])('rejects invalid actual cost %s', async amount => {
    await expect(service.settle('receipt-1', amount, '0.000000', 'gpt-image-2')).rejects.toMatchObject(code('INVALID_PARAMETER'));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('MediaRealBillingService concurrent refunds', () => {
  it('retries a competing pair of releases and refunds the reservation exactly once', async () => {
    let committed = { row: reservation(), balance: d(15), totalConsume: d(5), version: 0, ledger: [] as Decimal[] };
    let revision = 0;
    let calls = 0;
    const prisma = { $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      calls++;
      const startedAt = revision;
      const local = { ...committed, row: { ...committed.row }, ledger: [...committed.ledger] };
      const tx = txMock();
      tx.mediaRealBillingReservation.findUnique.mockImplementation(async () => ({ ...local.row }));
      tx.mediaRealBillingReservation.updateMany.mockImplementation(async ({ where, data }) => {
        if (local.row.status !== where.status) return { count: 0 };
        Object.assign(local.row, data);
        return { count: 1 };
      });
      tx.personalWallet.findUnique.mockImplementation(async () => ({ ...wallet(), balance: local.balance, totalConsumeCNY: local.totalConsume, version: local.version }));
      tx.personalWallet.updateMany.mockImplementation(async ({ where, data }) => {
        if (where.version !== local.version || local.totalConsume.lessThan(where.totalConsumeCNY.gte)) return { count: 0 };
        local.balance = local.balance.add(data.balance.increment);
        local.totalConsume = local.totalConsume.sub(data.totalConsumeCNY.decrement);
        local.version++;
        return { count: 1 };
      });
      tx.personalWalletTransaction.create.mockImplementation(async ({ data }) => {
        local.ledger.push(data.amount);
        return { id: `refund-${local.ledger.length}` };
      });
      const result = await work(tx);
      if (revision !== startedAt) throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: '6' });
      committed = local;
      revision++;
      return result;
    } };
    const billing = new MediaRealBillingService(prisma as never);
    await Promise.all([billing.release('receipt-1'), billing.release('receipt-1')]);
    expect(calls).toBe(3);
    expect(committed.row.status).toBe('RELEASED');
    expect(committed.balance.toFixed(6)).toBe('20.000000');
    expect(committed.totalConsume.toFixed(6)).toBe('0.000000');
    expect(committed.version).toBe(1);
    expect(committed.ledger.map(value => value.toFixed(6))).toEqual(['5.000000']);
  });
});
