import { z } from 'zod';
import { CnyAmountSchema } from './cny-amount';

export const RefundDepositDtoSchema = z.object({
  amount: CnyAmountSchema
    .refine((value) => value > 0, '退款金额必须大于0')
    .refine((value) => value === Number(value.toFixed(2)), '退款金额最多保留两位小数'),
  reason: z.string().max(200, '退款原因不能超过200字符').optional(),
});

export type RefundDepositDto = z.infer<typeof RefundDepositDtoSchema>;
