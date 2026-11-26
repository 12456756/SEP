import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ComputeProtocolClient, ComputeWireId } from './compute-protocol.client';
import { AccountId, CredentialDelivery, wireParse } from './compute-wire-contract';

export const RotationReceipt = z.object({ contract_version: z.literal(1), operation_id: ComputeWireId, enterprise_id: ComputeWireId,
  compute_account_id: AccountId, kind: z.enum(['chat', 'image', 'video']), old_credential_id: ComputeWireId,
  expected_version: z.number().int().positive(), status: z.enum(['prepared', 'acknowledged', 'completed']),
  credential: z.object({ type: z.enum(['chat', 'image', 'video']), credential_id: ComputeWireId,
    credential_version: z.number().int().positive(), encryption_key_id: ComputeWireId, encrypted_key: z.string().min(1) }) });
export interface RotationIdentity { operationId: string; enterpriseId: string; kind: string; oldRemoteId: string;
  expectedVersion: number; remoteAccountId: string; encryptionKeyId: string; newRemoteId?: string }

@Injectable()
export class ComputeCredentialRotationRemote {
  constructor(private readonly protocol: ComputeProtocolClient) {}
  encryptionKeyId() { return this.protocol.encryptionKeyId(); }
  connected() { return this.protocol.isConfigured(); }
  private path(row: RotationIdentity) {
    return `/api/v1/sep/enterprises/${wireParse(ComputeWireId, row.enterpriseId)}/credential-rotations`;
  }
  private verify(row: RotationIdentity, payload: unknown) {
    const receipt = wireParse(RotationReceipt, payload);
    if (receipt.operation_id !== row.operationId || receipt.enterprise_id !== row.enterpriseId
      || String(receipt.compute_account_id) !== row.remoteAccountId || receipt.kind !== row.kind
      || receipt.old_credential_id !== row.oldRemoteId || receipt.expected_version !== row.expectedVersion
      || receipt.credential.type !== row.kind || receipt.credential.credential_version !== row.expectedVersion + 1
      || receipt.credential.credential_id === row.oldRemoteId || row.newRemoteId && receipt.credential.credential_id !== row.newRemoteId
      || receipt.credential.encryption_key_id !== row.encryptionKeyId) {
      throw new ConflictException({ code: 'CREDENTIAL_ROTATION_RECEIPT_MISMATCH', message: '凭证更换回执与原操作不一致' });
    }
    return receipt;
  }
  async prepare(row: RotationIdentity) {
    const receipt = this.verify(row, await this.protocol.json(this.path(row), { method: 'POST', enterpriseId: row.enterpriseId,
      idempotencyKey: row.operationId, body: { contract_version: 1, operation_id: row.operationId, kind: row.kind,
        expected_credential_id: row.oldRemoteId, expected_version: row.expectedVersion, encryption_key_id: row.encryptionKeyId } }));
    const clear = wireParse(CredentialDelivery, this.protocol.decryptCredential(receipt.credential.encrypted_key, row.encryptionKeyId));
    if (clear.enterprise_id !== row.enterpriseId || String(clear.compute_account_id) !== row.remoteAccountId || clear.type !== row.kind
      || clear.credential_id !== receipt.credential.credential_id || clear.credential_version !== row.expectedVersion + 1) {
      throw new ConflictException({ code: 'CREDENTIAL_ROTATION_RECEIPT_MISMATCH', message: '凭证更换密文归属不一致' });
    }
    return clear;
  }
  async advance(row: RotationIdentity, action: 'ack' | 'retire') {
    const receipt = this.verify(row, await this.protocol.json(`${this.path(row)}/${wireParse(ComputeWireId, row.operationId)}/${action}`,
      { method: 'POST', enterpriseId: row.enterpriseId, idempotencyKey: row.operationId }));
    if (action === 'ack' ? receipt.status === 'prepared' : receipt.status !== 'completed') {
      throw new ConflictException({ code: 'CREDENTIAL_ROTATION_RECEIPT_MISMATCH', message: '凭证更换状态尚未确认' });
    }
    return receipt;
  }
}
