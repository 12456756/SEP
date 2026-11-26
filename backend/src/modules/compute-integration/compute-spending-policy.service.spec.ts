import { ComputeSpendingPolicyService } from './compute-spending-policy.service';

describe('Enterprise spending gate', () => {
  it.each(['event','local','remote'] as const)('pauses new executions for %s debt or unprocessed events', async kind => {
    const db: any = {
      computeBalanceEvent: { count: jest.fn().mockResolvedValue(kind === 'event' ? 1 : 0) },
      computeIntegrationSettlement: { count: jest.fn().mockResolvedValue(kind === 'local' ? 1 : 0) },
      computeIntegrationJob: { count: jest.fn().mockResolvedValue(kind === 'remote' ? 1 : 0) },
    };
    await expect(new ComputeSpendingPolicyService(db).assertCanSpend(db, 'ent1'))
      .rejects.toMatchObject({ response: { code: 'COMPUTE_BILL_OUTSTANDING', accounting_status: 'pending' } });
    expect(db.computeIntegrationJob.count.mock.calls[0][0].where.status).toEqual({ not: 'SUCCEEDED' });
  });
  it('allows generation again once the original debt is resolved', async () => {
    const db: any = { computeBalanceEvent: { count: jest.fn().mockResolvedValue(0) },
      computeIntegrationSettlement: { count: jest.fn().mockResolvedValue(0) }, computeIntegrationJob: { count: jest.fn().mockResolvedValue(0) } };
    await expect(new ComputeSpendingPolicyService(db).assertCanSpend(db, 'ent1')).resolves.toBeUndefined();
  });
});
