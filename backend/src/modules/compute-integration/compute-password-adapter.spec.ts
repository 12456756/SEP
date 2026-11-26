import { ComputeRemoteAdapter } from './compute-remote.adapter';

const input = { enterpriseId: 'ent1', remoteAccountId: '12', operationId: 'pwd_sync1_2', version: 2, passwordHash: '$2b$12$' + 'a'.repeat(53) };
const receipt = { contract_version: 1, enterprise_id: 'ent1', compute_account_id: 12, operation_id: input.operationId,
  password_version: 2, applied_version: 2, status: 'applied' };

describe('Signed enterprise password adapter', () => {
  it('uses the enterprise service signature and original idempotency key without an account login or public Key', async () => {
    const client = { json: jest.fn().mockResolvedValue(receipt) };
    const adapter = new ComputeRemoteAdapter(client as any);
    await expect(adapter.syncPassword(input)).resolves.toEqual(receipt);
    expect(client.json).toHaveBeenCalledWith('/api/v1/sep/enterprises/ent1/password', {
      method: 'POST', enterpriseId: 'ent1', idempotencyKey: input.operationId,
      body: { contract_version: 1, enterprise_id: 'ent1', compute_account_id: 12, operation_id: input.operationId,
        password_version: 2, password_hash: input.passwordHash },
    });
  });
  it.each([{ enterprise_id: 'other' }, { compute_account_id: 13 }, { operation_id: 'other' }, { password_version: 1 }, { applied_version: 3 }])(
    'rejects an unrelated receipt %j', async patch => {
      const adapter = new ComputeRemoteAdapter({ json: jest.fn().mockResolvedValue({ ...receipt, ...patch }) } as any);
      await expect(adapter.syncPassword(input)).rejects.toMatchObject({ response: { code: 'COMPUTE_IDENTITY_MISMATCH' } });
    },
  );
  it('recognizes a stale request without accepting it as the current password update', async () => {
    const response = { ...receipt, applied_version: 3, status: 'superseded' };
    const adapter = new ComputeRemoteAdapter({ json: jest.fn().mockResolvedValue(response) } as any);
    await expect(adapter.syncPassword(input)).resolves.toEqual(response);
  });
});
