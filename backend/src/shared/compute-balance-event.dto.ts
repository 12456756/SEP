import { z } from 'zod';
import { ComputeIntegrationIdSchema as Id, ComputeIntegrationMoneySchema as Money } from './compute-integration.dto';

export const ComputeBalanceSequenceSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/)
  .refine(value => BigInt(value) <= 9223372036854775807n);
export const ComputeBalanceEventSchema = z.object({
  contract_version: z.literal(1), event_id: Id, enterprise_id: Id,
  compute_account_id: z.number().int().positive().safe(),
  sequence: ComputeBalanceSequenceSchema.refine(value => value !== '0'),
  origin: z.enum(['compute', 'sep']),
  type: z.enum(['credit_compute', 'debit_compute', 'paid_consumption', 'free_record', 'compute_credit', 'compute_debit', 'compute_refund']),
  currency: z.literal('CNY'), delta_cny: z.string().regex(/^-?(0|[1-9]\d{0,17})\.\d{6}$/),
  amount_cny: Money, free_cny: Money, available_paid_cny: Money, frozen_paid_cny: Money,
  business_ref: z.string().min(1).max(200).nullable(), transfer_id: Id.nullable(),
  execution_id: Id.nullable(), settlement_id: Id.nullable(),
  exchange_rate: z.string().regex(/^\d{1,18}\.\d{12}$/).nullable(),
  occurred_at: z.string().datetime({ offset: true }),
}).strict().superRefine((event, ctx) => {
  const units = (value: string) => BigInt(value.replace('.', ''));
  const positive = ['credit_compute', 'compute_credit'].includes(event.type);
  const delta = event.type === 'free_record' ? 0n : units(event.amount_cny) * (positive ? 1n : -1n);
  if (units(event.delta_cny) !== delta || event.type === 'free_record' && units(event.amount_cny) !== 0n) {
    ctx.addIssue({ code: 'custom', path: ['delta_cny'], message: '事件方向与金额不一致' });
  }
  const computeType = ['compute_credit', 'compute_debit', 'compute_refund', 'paid_consumption'].includes(event.type);
  if (event.origin === 'compute' ? !computeType || !event.business_ref || units(event.free_cny) !== 0n
    : !['credit_compute', 'debit_compute', 'paid_consumption', 'free_record'].includes(event.type)) {
    ctx.addIssue({ code: 'custom', path: ['origin'], message: '事件来源与账务类型不一致' });
  }
});
export type ComputeBalanceEventPayload = z.infer<typeof ComputeBalanceEventSchema>;
export const ComputeBalanceBaselineSchema = z.object({ afterSequence: ComputeBalanceSequenceSchema }).strict();
export type ComputeBalanceBaseline = z.infer<typeof ComputeBalanceBaselineSchema>;
