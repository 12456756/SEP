import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { ComputeWireId as Id, ComputeWireMoney as Money, ComputeWireSequence as Sequence } from './compute-protocol.client';

export const AccountId = z.number().int().positive().safe();
const Kind = z.enum(['chat', 'image', 'video']);
export const RegistrationPasswordHash = z.string().regex(/^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/);
export const PasswordSyncResponse = z.object({ contract_version: z.literal(1), enterprise_id: Id, compute_account_id: AccountId,
  operation_id: Id, password_version: z.number().int().positive().safe(), applied_version: z.number().int().positive().safe(),
  status: z.enum(['applied', 'superseded']) });
export const RegistrationSnapshot = z.object({ enterpriseId: Id, registrationRef: Id,
  companyName: z.string().min(1).refine(value => Buffer.byteLength(value) <= 200),
  adminEmail: z.string().email().max(254), encryptionKeyId: Id, passwordHash: RegistrationPasswordHash }).strict();
export const StoredRegistrationSnapshot = RegistrationSnapshot.omit({ passwordHash: true, encryptionKeyId: true }).extend({
  encryptionKeyId: Id.optional(), encryptedPasswordHash: z.string().startsWith('enc:v1:').optional(), adminUserId: Id.optional(),
}).strict();
export const EnterpriseResponse = z.object({ enterprise_id: Id, compute_account_id: AccountId,
  company_name: z.string(), admin_email: z.string(), status: z.enum(['ready', 'disabled']), billing_mode: z.literal('sep_settlement_v1'),
  credentials: z.array(z.object({ type: Kind, credential_id: Id, credential_version: z.number().int().positive().safe(),
    group_id: z.number().int().positive().safe(), encryption_key_id: Id, masked_key: z.string(), delivery_status: z.literal('available'),
    encrypted_key: z.string().optional() })).length(3).refine(values => new Set(values.map(value => value.type)).size === 3),
});
export const CredentialDelivery = z.object({ enterprise_id: Id, compute_account_id: AccountId, type: Kind, credential_id: Id,
  credential_version: z.number().int().positive().safe(), key: z.string().min(5).max(8192).regex(/^[\x21-\x7e]+$/) }).strict();
export const SettlementResponse = z.object({ contract_version: z.literal(1), enterprise_id: Id, execution_id: Id, settlement_id: Id, bill_id: Id,
  status: z.literal('committed'), currency: z.literal('CNY'), charged_paid_cny: Money, recorded_free_cny: Money,
  ledger_entry_id: Id, sequence: Sequence, committed_at: z.string().datetime({ offset: true }), free_ledger_entry_id: Id.optional() });
const TransferBase = z.object({ contract_version: z.literal(1), enterprise_id: Id, transfer_id: Id,
  direction: z.enum(['credit_compute', 'debit_compute']), currency: z.literal('CNY'), amount_cny: Money, funding_ref: Id,
  sequence: Sequence, committed_at: z.string().datetime({ offset: true }) });
export const TransferResponse = z.discriminatedUnion('status', [
  TransferBase.extend({ status: z.literal('committed'), ledger_entry_id: Id }),
  TransferBase.extend({ status: z.literal('rejected'), reason: z.enum(['INSUFFICIENT_PAID_FUNDS', 'ENTERPRISE_DISABLED']) }),
]);
export const BillingResponse = z.object({ contract_version: z.literal(1), enterprise_id: Id, execution_id: Id, kind: Kind,
  model_id: z.string().min(1), compute_request_id: Id, provider_request_id: z.string(), task_id: z.string(),
  execution_status: z.enum(['received', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  fee_status: z.enum(['pending', 'final', 'reconciling']), resource_version: Sequence,
  bill_id: z.string(), bill_version: z.number().int().nonnegative(), price_version: z.string(), currency: z.literal('CNY'),
  gross_cny: Money.nullable(), exchange_rate: z.string().regex(/^\d+(?:\.\d+)?$/), usage: z.record(z.unknown()).nullable(),
  settlement_status: z.enum(['unsettled', 'committed']), settlement_receipt: SettlementResponse.nullable(),
  finalized_at: z.string().datetime({ offset: true }).nullable(),
}).superRefine((value, ctx) => {
  if (value.fee_status === 'final' ? !Id.safeParse(value.bill_id).success || value.bill_version !== 1 || value.gross_cny === null || !value.finalized_at
    : value.gross_cny !== null || value.bill_id !== '' || value.bill_version !== 0) ctx.addIssue({ code: 'custom', message: 'Fee state mismatch' });
  if ((value.settlement_status === 'committed') !== Boolean(value.settlement_receipt)) ctx.addIssue({ code: 'custom', message: 'Receipt state mismatch' });
});
export const BalanceResponse = z.object({ enterprise_id: Id, currency: z.literal('CNY'), total_paid_cny: Money,
  available_paid_cny: Money, frozen_paid_cny: Money, sequence: Sequence, observed_at: z.string().datetime({ offset: true }) });
export const LedgerResponse = BalanceResponse.omit({ sequence: true, observed_at: true }).extend({
  after_sequence: Sequence, snapshot_sequence: Sequence, has_more: z.boolean(), items: z.array(z.object({ enterprise_id: Id,
    ledger_entry_id: Id, sequence: Sequence, type: z.enum(['credit_compute', 'debit_compute', 'paid_consumption', 'free_record', 'compute_credit', 'compute_debit', 'compute_refund']),
    currency: z.literal('CNY'), amount_cny: Money, free_cny: Money, transfer_id: z.string(), execution_id: z.string(),
    settlement_id: z.string(), effective_at: z.string().datetime({ offset: true }) })).max(200),
});

export function wireParse<S extends z.ZodTypeAny>(schema: S, value: unknown): Required<z.output<S>> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceUnavailableException({ code: 'COMPUTE_CONTRACT_INVALID', message: '算力接口响应不符合 v1 契约，请核对接口版本和字段' });
  return parsed.data as Required<z.output<S>>;
}
