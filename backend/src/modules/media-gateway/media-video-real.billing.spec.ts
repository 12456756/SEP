import { Decimal } from '@prisma/client/runtime/library';
import { MediaRealBillingService } from './media-real-billing.service';

const decimal = (value: string | number) => new Decimal(value);
const reservation = () => ({ receiptId: 'video-receipt', enterpriseId: 'enterprise-1', userId: 'user-1', subscriptionId: 'subscription-1',
  creditId: null, reservedCny: decimal(7), creditCny: decimal(0), memberWalletCny: decimal(0), personalCny: decimal(7),
  usdToCnyRate: null, status: 'RESERVED', settledCny: null, settledUsd: null,
  sourceSnapshot: { memberWalletAllocations: [], personalWalletId: 'wallet-1' } });
describe('MediaRealBillingService video settlement isolation', () => {
  let tx: any;
  let service: MediaRealBillingService;
  let prisma: any;
  let execution: any;
  beforeEach(() => {
    execution = { id: 'compute-1', enterpriseId: 'enterprise-1', sourceRef: 'video-receipt',
      kind: 'video', feeStatus: 'FINAL', grossCny: decimal(7), billId: 'bill-1', billVersion: '1',
      fundingContext: { modelId: 'minimax-h3' } };
    tx = {
      computeIntegrationExecution: { findUniqueOrThrow: jest.fn(async () => execution), update: jest.fn() },
      $queryRaw: jest.fn(async () => [{ id: 'user-1', status: 'ACTIVE' }]),
      mediaRealBillingReservation: { findUnique: jest.fn(async () => reservation()), updateMany: jest.fn(async () => ({ count: 1 })), update: jest.fn() },
      subscription: { findFirst: jest.fn(async () => ({ employeeId: 'employee-1' })) },
      computeUsageRecord: { create: jest.fn(async ({ data }) => ({ id: 'usage-1', ...data })) },
      personalWallet: { findUnique: jest.fn(async () => ({ id: 'wallet-1', balance: decimal(10), totalConsumeCNY: decimal(7), version: 0 })),
        updateMany: jest.fn(async () => ({ count: 1 })) },
      personalWalletTransaction: { create: jest.fn(async () => ({ id: 'refund-1' })) },
    };
    prisma = { computeIntegrationExecution: tx.computeIntegrationExecution, $transaction: jest.fn(async fn => fn(tx)) };
    service = new MediaRealBillingService(prisma as never, {
      recordSettlement: jest.fn(), recordTransfer: jest.fn(),
    } as never);
  });

  it('settles minimax-h3 through the original atomic journal and refund transaction', async () => {
    execution.grossCny = decimal('3.5');
    await expect(service.settleCompute('video-receipt', execution.id, 'minimax-h3')).resolves.toBe('SETTLED');
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      modelId: 'minimax-h3', idempotencyKey: 'media-real:video-receipt', costCNY: decimal('3.5'), employeeId: 'employee-1',
    }) });
    expect(tx.mediaRealBillingReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ receiptId: 'video-receipt', status: 'RESERVED' }),
      data: expect.objectContaining({ status: 'SETTLED', settledCny: decimal('3.5'), settledUsd: null }),
    }));
    expect(tx.personalWallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ balance: { increment: decimal('3.5') } }) }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['gpt-image-2', 'MiniMax-H3', 'minimax-h3-max', 'another-model'])('does not let video settle accept %s', async model => {
    await expect(service.settleCompute('video-receipt', execution.id, model)).rejects.toMatchObject({ response: { error: { code: 'BILLING_PENDING' } } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects the retired image settlement method for video too', async () => {
    await expect(service.settle('video-receipt', '7.000000', '1.000000', 'minimax-h3')).rejects.toMatchObject({ response: { error: { code: 'BILLING_PENDING' } } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('settles a V3 model only when verified usage matches the frozen model', async () => {
    execution.fundingContext.modelId = 'new-video-model';
    await expect(service.settleCompute('video-receipt', execution.id, 'new-video-model'))
      .resolves.toBe('SETTLED');
    expect(tx.computeUsageRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ modelId: 'new-video-model' }) });
  });

  it.each(['another-model', '', 'model\nkey'])('rejects a V3 usage model differing from frozen model: %s', async model => {
    await expect(service.settleNegotiated('video-receipt', '7.000000', '1.000000', model, 'new-video-model'))
      .rejects.toMatchObject({ response: { error: { code: 'BILLING_PENDING' } } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps above-quote liabilities reconciling without refunding or posting duplicate usage', async () => {
    execution.grossCny = decimal(8);
    await expect(service.settleCompute('video-receipt', execution.id, 'minimax-h3')).resolves.toBe('RECONCILING');
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    expect(tx.computeUsageRecord.create).not.toHaveBeenCalled();
  });

  it('is idempotent for an already settled original bill', async () => {
    tx.mediaRealBillingReservation.findUnique.mockResolvedValue({ ...reservation(), status: 'SETTLED', settledCny: decimal(7), settledUsd: decimal(1) });
    await expect(service.settleCompute('video-receipt', execution.id, 'minimax-h3')).resolves.toBe('SETTLED');
    expect(tx.computeUsageRecord.create).not.toHaveBeenCalled();
    expect(tx.mediaRealBillingReservation.updateMany).not.toHaveBeenCalled();
  });
});
