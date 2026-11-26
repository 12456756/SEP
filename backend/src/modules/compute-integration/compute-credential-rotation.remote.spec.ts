import { ComputeCredentialRotationRemote } from './compute-credential-rotation.remote';

describe('Credential rotation remote contract boundary', () => {
  const row = { enterpriseId: 'ent-test', operationId: 'operation-test', kind: 'chat', expectedVersion: 1,
    oldRemoteId: 'credential-old', remoteAccountId: '123', encryptionKeyId: 'enc-frozen', newRemoteId: 'credential-new' };
  const clear = { enterprise_id: row.enterpriseId, compute_account_id: 123, type: 'chat', credential_id: 'credential-new', credential_version: 2, key: 'secret-new-key' };
  const receipt = { contract_version: 1, enterprise_id: row.enterpriseId, operation_id: row.operationId, compute_account_id: 123,
    kind: 'chat', expected_version: 1, old_credential_id: row.oldRemoteId, status: 'prepared',
    credential: { type: 'chat', credential_id: 'credential-new', credential_version: 2, encryption_key_id: 'enc-frozen', encrypted_key: 'encrypted-envelope' } };
  let protocol: any, remote: ComputeCredentialRotationRemote;
  beforeEach(() => {
    protocol = { json: jest.fn().mockResolvedValue(receipt), decryptCredential: jest.fn().mockReturnValue(clear) };
    remote = new ComputeCredentialRotationRemote(protocol);
  });
  it('keeps the original operation and frozen encryption version across retries', async () => {
    await remote.prepare(row); await remote.prepare(row);
    for (const [path, options] of protocol.json.mock.calls) {
      expect(path).toBe('/api/v1/sep/enterprises/ent-test/credential-rotations');
      expect(options).toMatchObject({ idempotencyKey: row.operationId, enterpriseId: row.enterpriseId,
        body: { operation_id: row.operationId, encryption_key_id: row.encryptionKeyId, expected_credential_id: row.oldRemoteId, expected_version: 1 } });
    }
    expect(protocol.decryptCredential).toHaveBeenCalledWith('encrypted-envelope', 'enc-frozen');
  });
  it.each(['enterprise_id', 'operation_id', 'compute_account_id', 'kind', 'old_credential_id', 'expected_version'])('rejects a mismatched %s before decrypting', async field => {
    protocol.json.mockResolvedValue({ ...receipt, [field]: field === 'compute_account_id' ? 124 : field === 'expected_version' ? 2 : 'other' });
    await expect(remote.prepare(row)).rejects.toThrow(); expect(protocol.decryptCredential).not.toHaveBeenCalled();
  });
  it('rejects a foreign encrypted identity', async () => {
    protocol.decryptCredential.mockReturnValue({ ...clear, enterprise_id: 'another-enterprise' });
    await expect(remote.prepare(row)).rejects.toThrow('密文归属不一致');
  });
  it('requires acknowledgement and retirement states and the exact locally saved new key', async () => {
    await expect(remote.advance(row, 'ack')).rejects.toThrow('状态尚未确认');
    protocol.json.mockResolvedValue({ ...receipt, status: 'acknowledged' });
    await expect(remote.advance(row, 'ack')).resolves.toMatchObject({ status: 'acknowledged' });
    await expect(remote.advance(row, 'retire')).rejects.toThrow('状态尚未确认');
    protocol.json.mockResolvedValue({ ...receipt, status: 'completed', credential: { ...receipt.credential, credential_id: 'another-new-key' } });
    await expect(remote.advance(row, 'retire')).rejects.toThrow('原操作不一致');
    protocol.json.mockResolvedValue({ ...receipt, status: 'completed' });
    await expect(remote.advance(row, 'retire')).resolves.toMatchObject({ status: 'completed' });
  });
});
