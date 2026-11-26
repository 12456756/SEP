import { ComputeMediaService } from './compute-media.service';

describe('Media dispatch recovery ownership', () => {
  it('recovers an existing async task with its original credential after the current key rotates', async () => {
    const db: any = { computeIntegrationExecution: { findUnique: jest.fn().mockResolvedValue({ id: 'original-execution', baseUrl: 'https://original.invalid/v1' }) } };
    const connections: any = { resolve: jest.fn().mockResolvedValue({ credentialId: 'new-key', apiKey: 'new-secret' }) };
    const integration: any = { selectExecutionCredential: jest.fn().mockResolvedValue({ credentialId: 'original-key', apiKey: 'original-secret' }) };
    const protocol: any = { validateAddress: jest.fn() };
    const service = new ComputeMediaService(db, connections, integration, {} as any, {} as any, protocol);
    const pinned = { enterpriseId: 'ent1', credentialId: 'original-key', baseUrl: 'https://original.invalid/v1', quoteId: 'original-quote' };
    expect(await service.connection('ent1', 'image', pinned, 'receipt1')).toMatchObject({
      key: 'original-secret', base: pinned.baseUrl, compute: { executionId: 'original-execution', quoteId: 'original-quote' },
    });
    expect(integration.selectExecutionCredential).toHaveBeenCalledWith('ent1', 'original-execution');
    expect(connections.resolve).not.toHaveBeenCalled();
  });
  function setup() {
    const execution: any = { id: 'exec1', dispatchStatus: 'PREPARED', fundingContext: { modelId: 'model1' } };
    const db: any = { computeIntegrationExecution: {
      updateMany: jest.fn(async ({ where, data }) => {
        if (execution.dispatchStatus !== where.dispatchStatus) return { count: 0 };
        Object.assign(execution, data); return { count: 1 };
      }), findUnique: jest.fn(async () => ({ ...execution })), update: jest.fn(),
    } };
    const remote: any = { executionEvidence: jest.fn().mockResolvedValue({ fee: { status: 'PENDING' }, executionStatus: 'running' }) };
    const accounting: any = { recordFee: jest.fn().mockResolvedValue({ ...execution, feeStatus: 'PENDING', grossCny: null }) };
    const service = new ComputeMediaService(db, {} as any, {} as any, accounting, remote, {} as any);
    return { service, execution, remote, accounting };
  }
  it('prevents late generation after recovery has closed an unsubmitted reservation', async () => {
    const { service } = setup();
    expect(await service.closeUnsent('ent1', 'image', 'receipt1')).toBe(true);
    await expect(service.markDispatch('ent1', 'image', 'receipt1')).rejects.toThrow('不能再次生成');
  });
  it('never authorizes a refund by closing an already dispatched but unknown request', async () => {
    const { service } = setup();
    await service.markDispatch('ent1', 'video', 'receipt1');
    expect(await service.closeUnsent('ent1', 'video', 'receipt1')).toBe(false);
    await expect(service.markDispatch('ent1', 'video', 'receipt1')).rejects.toThrow();
  });
  it('queries the original execution and verifies the frozen model without interpreting a pending fee as zero', async () => {
    const { service, remote } = setup();
    await service.markDispatch('ent1', 'image', 'receipt1');
    const result = await service.fee('ent1', 'image', 'receipt1');
    expect(result).toMatchObject({ feeStatus: 'PENDING', grossCny: null });
    expect(remote.executionEvidence).toHaveBeenCalledWith('ent1', 'exec1', 'image', 'model1');
  });
});
