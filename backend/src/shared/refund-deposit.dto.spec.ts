import { RefundDepositDtoSchema } from './refund-deposit.dto';

describe('RefundDepositDtoSchema', () => {
  it.each([0.29, 1.1, 12.34])('accepts valid cent amount %s', (amount) => {
    expect(RefundDepositDtoSchema.safeParse({ amount }).success).toBe(true);
  });
  it.each([0, -1, 0.001, 0.0100001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid refund amount %s', (amount) => {
      expect(RefundDepositDtoSchema.safeParse({ amount }).success).toBe(false);
    },
  );
  it('keeps the reason optional and bounded', () => {
    expect(RefundDepositDtoSchema.safeParse({ amount: 1 }).success).toBe(true);
    expect(RefundDepositDtoSchema.safeParse({ amount: 1, reason: 'a'.repeat(201) }).success).toBe(false);
  });
});
