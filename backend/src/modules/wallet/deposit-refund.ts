import { Decimal } from '@prisma/client/runtime/library';

export function depositRefundableAmount(
  sourceRemaining: Decimal.Value,
  wallet: { balance: Decimal.Value; computeReservedCNY: Decimal.Value; frozenAmount: Decimal.Value },
): Decimal {
  const spendable = new Decimal(wallet.balance)
    .sub(wallet.computeReservedCNY)
    .sub(wallet.frozenAmount);
  return Decimal.max(Decimal.min(sourceRemaining, spendable), 0)
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);
}
