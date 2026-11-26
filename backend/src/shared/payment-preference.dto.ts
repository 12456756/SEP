import { z } from 'zod';

export const PaymentModeSchema = z.enum(['AUTO', 'ENTERPRISE_ONLY', 'PERSONAL_ONLY']);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;
export const PaymentPreferenceSchema = z.object({ paymentMode: PaymentModeSchema }).strict();
export type PaymentPreference = z.infer<typeof PaymentPreferenceSchema>;
