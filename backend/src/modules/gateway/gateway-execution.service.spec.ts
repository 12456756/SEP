import { ConfigService } from '@nestjs/config';
import { GatewayExecutionService } from './gateway-execution.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

describe('Gateway execution journal and recovery', () => {
  const claims = { sub: 'user', enterpriseId: 'enterprise', memberId: 'member', subscriptionId: 'subscription' } as never;
  const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
  const billingSnapshot = {
    modelId: 'model', isFree: false, billingMultiplier: 1, rate: 7,
    inputPriceUsdPerMillion: 0.15, outputPriceUsdPerMillion: 0.6, isFallback: false,
  };
  let service: GatewayExecutionService;
  let prisma: any;
  let credit: any;
  let execution: any;

  beforeEach(() => {
    execution = { id: 'server-execution', enterpriseId: 'enterprise', userId: 'user', subscriptionId: 'subscription',
      employeeId: 'employee', modelId: 'model', requestId: 'request', inputTokens: 12, outputTokens: 8,
      status: 'USAGE_PENDING', billingSnapshot };
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'user', status: 'ACTIVE' }]), $transaction: jest.fn(async (fn: any) => fn(prisma)), gatewayExecution: {
      create: jest.fn().mockResolvedValue(execution), update: jest.fn().mockResolvedValue(execution),
      updateMany: jest.fn().mockImplementation(async ({ data }) => {
        if (data.settlementLeaseUntil instanceof Date) execution.settlementLeaseUntil = data.settlementLeaseUntil;
        return { count: 1 };
      }), findUniqueOrThrow: jest.fn().mockResolvedValue(execution),
      findMany: jest.fn().mockResolvedValue([{ id: execution.id }]),
    } };
    credit = {
      getBillingSnapshot: jest.fn().mockResolvedValue(billingSnapshot),
      getLegacyBillingSnapshot: jest.fn().mockResolvedValue(billingSnapshot),
      chargeUsage: jest.fn().mockResolvedValue({ usageRecordId: 'bill', alreadyCharged: false }),
    };
    service = new GatewayExecutionService(prisma, credit, new ConfigService(), { isEnterpriseMode: jest.fn().mockResolvedValue(true) } as never);
  });

  it('accepts a late usage checkpoint after the remote final fee has already been settled', async () => {
    execution.status = 'SETTLED'; execution.billingSnapshot = { source: 'compute', currency: 'CNY' };
    prisma.gatewayExecution.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.saveUsage('server-execution', usage)).resolves.toBeUndefined();
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('creates a server-owned journal before any model request and rejects storage failure', async () => {
    await service.start(claims, 'employee', 'model', 'request');
    expect(prisma.gatewayExecution.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      enterpriseId: 'enterprise', userId: 'user', memberId: 'member', requestId: 'request',
    }) });
    expect(prisma.gatewayExecution.create.mock.calls[0][0].data).not.toHaveProperty('id');
    prisma.gatewayExecution.create.mockRejectedValue(new Error('private connection details'));
    await expect(service.start(claims, 'employee', 'model', 'request')).rejects.toMatchObject({
      status: 503, response: { error: { code: 'EXECUTION_JOURNAL_UNAVAILABLE' } },
    });
  });

  it.each(['CLOSURE_PENDING', 'CLOSED', 'DISABLED'])('refuses to start upstream work for %s accounts', async (status) => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'user', status }]);
    await expect(service.start(claims, 'employee', 'model', 'request')).rejects.toMatchObject({ status: 401 });
    expect(prisma.gatewayExecution.create).not.toHaveBeenCalled();
  });

  it('rejects a closed enterprise after locking its active user', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ status: 'ACTIVE' }]).mockResolvedValueOnce([{ status: 'CLOSED' }]);
    await expect(service.start(claims, 'employee', 'model', 'request')).rejects.toThrow('Enterprise is not active');
    expect(prisma.gatewayExecution.create).not.toHaveBeenCalled();
  });

  it('persists the authorized free snapshot without querying a newer price', async () => {
    const free = { ...billingSnapshot, isFree: true, billingMultiplier: 0,
      inputPriceUsdPerMillion: 0, outputPriceUsdPerMillion: 0 };
    await service.start(claims, 'employee', 'model', 'request', undefined, free);
    expect(prisma.gatewayExecution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ billingSnapshot: { source: 'compute', currency: 'CNY' } }),
    });
    expect(credit.getBillingSnapshot).not.toHaveBeenCalled();
  });

  it.each([null, billingSnapshot, { ...billingSnapshot, isFree: true, billingMultiplier: 0 },
    { ...billingSnapshot, paymentMode: 'PERSONAL_ONLY' }])(
    'keeps legacy execution for reconciliation without re-pricing: %p', async historical => {
      execution.billingSnapshot = historical;
      await service.settle(execution.id);
      expect(prisma.gatewayExecution.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
        data: { status: 'NEEDS_RECONCILIATION', errorCode: 'COMPUTE_FINAL_FEE_REQUIRED', settlementLeaseUntil: null },
      }));
      expect(credit.chargeUsage).not.toHaveBeenCalled();
      expect(credit.getBillingSnapshot).not.toHaveBeenCalled();
      expect(credit.getLegacyBillingSnapshot).not.toHaveBeenCalled();
    },
  );

  it('leaves compute executions to the final-fee worker without a local charge', async () => {
    execution.billingSnapshot = { source: 'compute', currency: 'CNY' };
    await service.settle(execution.id);
    expect(prisma.gatewayExecution.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { settlementLeaseUntil: null },
    }));
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('rejects starting without compute integration even with a free snapshot', async () => {
    const disconnected = new GatewayExecutionService(prisma, credit, new ConfigService());
    await expect(disconnected.start(claims, 'employee', 'model', 'request', undefined,
      { ...billingSnapshot, isFree: true })).rejects.toMatchObject({ response: { code: 'COMPUTE_FINAL_FEE_REQUIRED' } });
    expect(prisma.gatewayExecution.create).not.toHaveBeenCalled();
  });

  it('persists observed usage without making an active stream ready to settle', async () => {
    await service.saveUsage(execution.id, usage);
    expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'USAGE_PENDING', inputTokens: 12, outputTokens: 8 },
    }));
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('uses the request snapshot for journal expiry rather than the process timeout', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      service = new GatewayExecutionService(prisma, credit, new ConfigService({ GATEWAY_STREAM_TOTAL_TIMEOUT_MS: '1000' }), { isEnterpriseMode: jest.fn().mockResolvedValue(true) } as never);
      await service.start(claims, 'employee', 'model', 'request', policySnapshot({
        GATEWAY_STREAM_TOTAL_TIMEOUT_MS: 600000, GATEWAY_NON_STREAM_TIMEOUT_MS: 120000,
      }));
      expect(prisma.gatewayExecution.create.mock.calls[0][0].data.expiresAt).toEqual(new Date(now + 720000));
    } finally { jest.restoreAllMocks(); }
  });

  it.each([-1, 0.5, NaN, Infinity, 2147483648])('does not persist invalid provider tokens %s', async (tokens) => {
    await service.saveUsage(execution.id, { ...usage, prompt_tokens: tokens });
    expect(prisma.gatewayExecution.updateMany).not.toHaveBeenCalled();
  });

  it('does not report a rejected late usage write as a successful checkpoint', async () => {
    prisma.gatewayExecution.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.saveUsage(execution.id, usage)).rejects.toMatchObject({
      status: 503, response: { error: { code: 'EXECUTION_USAGE_CHECKPOINT_REJECTED' } },
    });
  });

  it('freezes an uncertain usage snapshot rather than opening it for settlement', async () => {
    await service.fail(execution.id, 'EXECUTION_JOURNAL_TIMEOUT', false, true);
    expect(prisma.gatewayExecution.update).not.toHaveBeenCalled();
    expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledWith({
      where: { id: execution.id, status: { in: ['STARTED', 'USAGE_PENDING'] }, settlementReady: false, settlementLeaseUntil: null },
      data: { status: 'NEEDS_RECONCILIATION', settlementReady: false, errorCode: 'USAGE_CHECKPOINT_UNCERTAIN' },
    });
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('does not charge if another worker holds the lease or execution is already settled', async () => {
    prisma.gatewayExecution.updateMany.mockResolvedValue({ count: 0 });
    await service.settle(execution.id);
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('releases a failed journal update for recovery without attempting a local charge', async () => {
    const original = prisma.gatewayExecution.updateMany.getMockImplementation();
    prisma.gatewayExecution.updateMany.mockImplementationOnce(original).mockRejectedValueOnce(new Error('database unavailable'));
    await service.settle(execution.id);
    expect(prisma.gatewayExecution.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { settlementLeaseUntil: null, errorCode: 'SETTLEMENT_FAILED' },
    }));
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('marks missing usage as reconciliation, not zero-cost settlement', async () => {
    prisma.gatewayExecution.updateMany.mockImplementation(async ({ where }) => ({ count: where.status === 'USAGE_PENDING' ? 0 : 1 }));
    await service.finish(execution.id, {});
    expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledWith({
      where: { id: execution.id, status: 'STARTED' }, data: { status: 'NEEDS_RECONCILIATION', errorCode: 'USAGE_MISSING' },
    });
    expect(credit.chargeUsage).not.toHaveBeenCalled();
  });

  it('recovers stale executions and bounds the settlement scan', async () => {
    await service.reconcile();
    expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'NEEDS_RECONCILIATION', errorCode: 'EXECUTION_EXPIRED_WITHOUT_USAGE' },
    }));
    expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'NEEDS_RECONCILIATION', errorCode: 'EXECUTION_EXPIRED_WITH_UNCONFIRMED_USAGE' },
    }));
    expect(prisma.gatewayExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('retains the owned lease when a journal read times out instead of freeing it early', async () => {
    jest.useFakeTimers();
    let complete!: () => void;
    prisma.gatewayExecution.findUniqueOrThrow.mockImplementation(() => new Promise(resolve => {
      complete = () => resolve(execution);
    }));
    const outcome = service.settle(execution.id);
    try {
      await jest.advanceTimersByTimeAsync(5000);
      await outcome;
      expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledTimes(1);
      expect(execution.settlementLeaseUntil).toBeInstanceOf(Date);
      complete();
      await jest.advanceTimersByTimeAsync(0);
      expect(prisma.gatewayExecution.updateMany).toHaveBeenCalledTimes(1);
    } finally { complete(); jest.useRealTimers(); }
  });
});
