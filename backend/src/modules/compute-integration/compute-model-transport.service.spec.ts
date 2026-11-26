import { ComputeModelTransportService } from './compute-model-transport.service';
import { ConflictException } from '@nestjs/common';

describe('Enterprise model execution transport', () => {
  function setup() {
    let id = 0;
    const db: any = { enterpriseMember: { findFirst: jest.fn().mockResolvedValue({ id: 'member1', userId: 'user1' }) },
      computeIntegrationExecution: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      computeIntegrationJob: { upsert: jest.fn() } };
    db.$transaction = (fn: any) => fn(db);
    const accounting: any = { createExecution: jest.fn(async () => ({ id: `exec${++id}` })) };
    const protocol: any = { request: jest.fn(async () => new Response('{}')) };
    const integrations: any = { selectEnterpriseCredential: jest.fn().mockResolvedValue({ credentialId: 'credential2', apiKey: 'rotated-key' }) };
    const service = new ComputeModelTransportService(db, accounting, protocol, integrations);
    const connection = { baseURL: 'https://compute.example/v1', apiKey: 'enterprise-only-key', credentialId: 'credential1' };
    return { db, accounting, protocol, service, connection, integrations };
  }

  it('persists separate execution and recovery jobs for each physical tool step and signs the unmodified body', async () => {
    const { service, connection, accounting, db, protocol } = setup();
    const provider = await service.provider('ent1', connection, { userId: 'user1', memberId: 'member1', subscriptionId: 'sub1' });
    const bodies = ['{"model":"model1","messages":[],"tools":[{"function":{"name":"test"}}]}', '{"model":"model1","messages":[{"role":"tool","content":"result"}]}'];
    for (const body of bodies) await provider.fetch(provider.baseURL + '/chat/completions', { method: 'POST', body });
    expect(accounting.createExecution).toHaveBeenCalledTimes(2);
    expect(accounting.createExecution.mock.calls[0][0].sourceRef).not.toBe(accounting.createExecution.mock.calls[1][0].sourceRef);
    expect(db.computeIntegrationJob.upsert.mock.calls.map(([args]) => args.create.businessId)).toEqual(['fee_exec1', 'fee_exec2']);
    for (let i = 0; i < 2; i++) expect(protocol.request.mock.calls[i][1]).toMatchObject({
      enterpriseId: 'ent1', executionId: `exec${i + 1}`, apiKey: connection.apiKey, rawBody: Buffer.from(bodies[i]),
    });
  });

  it('rejects a foreign origin before allocating an execution or leaking its key', async () => {
    const { service, connection, accounting, protocol } = setup();
    const provider = await service.provider('ent1', connection, { memberId: 'member1' });
    await expect(provider.fetch('https://foreign.example/v1/chat/completions', { method: 'POST', body: '{"model":"m"}' })).rejects.toThrow('路由');
    expect(accounting.createExecution).not.toHaveBeenCalled(); expect(protocol.request).not.toHaveBeenCalled();
  });

  it('never re-sends an already dispatched gateway execution', async () => {
    const { service, connection, db, protocol } = setup();
    db.computeIntegrationExecution.updateMany.mockResolvedValue({ count: 0 });
    const provider = await service.provider('ent1', connection, { memberId: 'member1', gatewayId: 'gateway1' });
    await expect(provider.fetch(provider.baseURL + '/chat/completions', { method: 'POST', body: '{"model":"m"}' })).rejects.toThrow('只能查询原执行');
    expect(protocol.request).not.toHaveBeenCalled();
  });

  it('keeps network failures as one queryable execution without retrying generation', async () => {
    const { service, connection, db, protocol } = setup();
    protocol.request.mockRejectedValue(new Error('connection lost'));
    const provider = await service.provider('ent1', connection, { memberId: 'member1' });
    await expect(provider.fetch(provider.baseURL + '/chat/completions', { method: 'POST', body: '{"model":"m"}' })).rejects.toThrow('connection lost');
    expect(protocol.request).toHaveBeenCalledTimes(1);
    expect(db.computeIntegrationJob.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ kind: 'FEE', status: 'PENDING' }) }));
  });

  it('refreshes a stale provider only after execution creation rejected before network dispatch', async () => {
    const { service, connection, accounting, protocol, integrations } = setup();
    accounting.createExecution.mockRejectedValueOnce(new ConflictException({ code: 'CREDENTIAL_VERSION_CONFLICT' }));
    const provider = await service.provider('ent1', connection, { memberId: 'member1' });
    await provider.fetch(provider.baseURL + '/chat/completions', { method: 'POST', body: '{"model":"m"}' });
    expect(integrations.selectEnterpriseCredential).toHaveBeenCalledWith('ent1', 'chat');
    expect(accounting.createExecution.mock.calls[0][0].sourceRef).toBe(accounting.createExecution.mock.calls[1][0].sourceRef);
    expect(accounting.createExecution.mock.calls[1][0].credentialId).toBe('credential2');
    expect(protocol.request).toHaveBeenCalledTimes(1);
    expect(protocol.request.mock.calls[0][1].apiKey).toBe('rotated-key');
  });

  it('does not retry a generation when the remote server rejects its credential', async () => {
    const { service, connection, protocol, integrations, accounting } = setup();
    protocol.request.mockRejectedValue(new ConflictException({ code: 'CREDENTIAL_VERSION_CONFLICT' }));
    const provider = await service.provider('ent1', connection, { memberId: 'member1' });
    await expect(provider.fetch(provider.baseURL + '/chat/completions', { method: 'POST', body: '{"model":"m"}' })).rejects.toThrow();
    expect(protocol.request).toHaveBeenCalledTimes(1);
    expect(accounting.createExecution).toHaveBeenCalledTimes(1);
    expect(integrations.selectEnterpriseCredential).not.toHaveBeenCalled();
  });
});
