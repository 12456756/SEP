import { z } from 'zod';

/**
 * 人民币金额（元）：非负、最多两位小数。
 * 在边界处拦住 0.001 元这类值，避免它一路流到 Decimal 列被静默截断。
 */
export const CnyAmountSchema = z
  .number()
  .min(0, '金额不能为负数')
  .refine((n) => Number.isFinite(n), { message: '金额必须是有效数字' })
  .refine((n) => Math.round(n * 100) === Number((n * 100).toFixed(4)), {
    message: '金额最多保留两位小数',
  });
