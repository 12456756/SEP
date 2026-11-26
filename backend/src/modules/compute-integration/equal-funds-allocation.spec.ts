import { Decimal } from '@prisma/client/runtime/library';
import { equalFundsAllocation } from './equal-funds-allocation';

const allocate = (amount: string, values: string[]) => equalFundsAllocation(new Decimal(amount),
  values.map((value, i) => ({ userId: `user${i}`, balance: new Decimal(value) })));

describe('Capped equal funds allocation', () => {
  it('redistributes a short member share to the remaining members', () => {
    const result = allocate('15', ['2', '10', '20']);
    expect(result.allocations.map(row => row.amount.toString())).toEqual(['2', '6.5', '6.5']);
    expect(result.outstanding.toString()).toBe('0');
  });
  it('exhausts multiple small balances before redistributing the remainder', () => {
    expect(allocate('21', ['1', '2', '30', '0']).allocations.map(row => row.amount.toString())).toEqual(['1', '2', '18']);
  });
  it('keeps an explicit shortfall rather than making a balance negative', () => {
    const result = allocate('10', ['1', '2']);
    expect(result.paid.toString()).toBe('3'); expect(result.outstanding.toString()).toBe('7');
  });
  it('distributes a micro-yuan remainder in stable member order without rounding up the total', () => {
    const result = allocate('0.000005', ['1', '1', '1']);
    expect(result.allocations.map(row => row.amount.toFixed(6))).toEqual(['0.000002', '0.000002', '0.000001']);
    expect(allocate('0.000001', ['1', '1', '1']).allocations).toHaveLength(1);
  });
  it('conserves the amount across varied numbers of members and capped balances', () => {
    for (let size = 0; size < 30; size++) for (let value = 0; value < 40; value++) {
      const balances = Array.from({ length: size }, (_, i) => ({ userId: String(i), balance: new Decimal((i * 7) % 13).div(1_000_000) }));
      const amount = new Decimal(value).div(1_000_000), result = equalFundsAllocation(amount, balances);
      expect(result.allocations.reduce((sum, row) => sum.add(row.amount), result.outstanding).eq(amount)).toBe(true);
      for (const row of result.allocations) expect(row.amount.lte(balances.find(member => member.userId === row.userId)!.balance)).toBe(true);
    }
  });
});
