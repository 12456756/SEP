import { EnterpriseDeletionCleanupService } from '../admin/enterprise-deletion-cleanup.service';

it('erases only the deleted tenant keys, stops pending delivery and preserves accounting evidence', async () => {
  const writes = new Map<string, any>();
  const tx: any = new Proxy({}, { get: (_, name: string) => {
    if (!writes.has(name)) writes.set(name, { deleteMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn() });
    return writes.get(name);
  } });
  const cleanup = new EnterpriseDeletionCleanupService({} as any, {} as any, {} as any, {} as any, {} as any);
  await cleanup.deleteDatabase(tx, 'deleted-tenant', { conversationSessionIds: [] } as any);
  expect(writes.get('enterpriseComputeCredential').deleteMany).toHaveBeenCalledWith({ where: { enterpriseId: 'deleted-tenant' } });
  expect(writes.get('computeIntegrationJob').updateMany).toHaveBeenCalledWith({ where: { enterpriseId: 'deleted-tenant', status: { not: 'SUCCEEDED' } },
    data: { status: 'BLOCKED', leaseToken: null, leaseUntil: null, lastErrorCode: 'ENTERPRISE_UNAVAILABLE' } });
  expect(writes.has('computeIntegrationSettlement')).toBe(false);
  expect(writes.has('computeIntegrationTransfer')).toBe(false);
  expect(writes.get('enterpriseComputeCredential').deleteMany.mock.invocationCallOrder[0]).toBeLessThan(writes.get('enterprise').delete.mock.invocationCallOrder[0]);
});
