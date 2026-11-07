import { depositRefundableAmount } from './deposit-refund';

describe('depositRefundableAmount', () => {
  it.each([
    ['100', '0.001', '0', '0', '0'],
    ['100', '10.299999', '0', '0', '10.29'],
    ['10.29', '100', '0', '0', '10.29'],
    ['100', '150.299999', '100', '10', '40.29'],
    ['100', '10', '10', '0', '0'],
    ['-1', '100', '0', '0', '0'],
  ])('limits source %s against balance %s, reserve %s, frozen %s', (source, balance, computeReservedCNY, frozenAmount, expected) => {
    expect(depositRefundableAmount(source, { balance, computeReservedCNY, frozenAmount }).toString()).toBe(expected);
  });
});
