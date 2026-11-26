import { Decimal } from '@prisma/client/runtime/library';

const scale = new Decimal(1_000_000);
const units = (amount: Decimal) => BigInt(amount.mul(scale).toFixed(0));
const money = (amount: bigint) => new Decimal(amount.toString()).div(scale);

/** Capped equal shares, computed in micro-yuan with deterministic remainder order. */
export function equalFundsAllocation(amount: Decimal, balances: ReadonlyArray<{ userId: string; balance: Decimal }>) {
  if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 6) throw new RangeError('Invalid allocation amount');
  let remaining = units(amount);
  const rows = balances.map(row => {
    if (!row.balance.isFinite() || row.balance.isNegative() || row.balance.decimalPlaces() > 6) throw new RangeError('Invalid member balance');
    return { userId: row.userId, available: units(row.balance), paid: 0n };
  }).sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  if (new Set(rows.map(row => row.userId)).size !== rows.length) throw new RangeError('Duplicate member');
  let active = rows.filter(row => row.available > 0n);
  while (remaining > 0n && active.length) {
    const count = BigInt(active.length), share = remaining / count, extra = remaining % count;
    let paid = 0n;
    for (let index = 0; index < active.length; index++) {
      const row = active[index];
      const requested = share + (BigInt(index) < extra ? 1n : 0n);
      const take = requested < row.available ? requested : row.available;
      row.paid += take; row.available -= take; paid += take;
    }
    remaining -= paid;
    active = active.filter(row => row.available > 0n);
  }
  return { allocations: rows.filter(row => row.paid > 0n).map(row => ({ userId: row.userId, amount: money(row.paid) })),
    paid: amount.sub(money(remaining)), outstanding: money(remaining) };
}
