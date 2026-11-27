/**
 * 人民币口径的计价与金额解析。
 *
 * 这些是账本的入口函数：任何一个把非法值放过去的分支，最终都会在
 * Decimal 列上变成一个没人能解释的金额。
 */
import {
  CnyAmountSchema,
  parseCnyAmount,
} from './index';

describe('parseCnyAmount', () => {
  it('正常金额四舍五入到两位小数', () => {
    expect(parseCnyAmount('1000')).toBe(1000);
    expect(parseCnyAmount('12.345')).toBe(12.35);
    expect(parseCnyAmount('0')).toBe(0);
  });

  it('空值与缺省回退到 fallback，而不是 0/NaN', () => {
    // 空字符串是「没配」，不是「配成 0」—— 混淆两者会让系统默认值失效
    expect(parseCnyAmount(undefined, 500)).toBe(500);
    expect(parseCnyAmount('', 500)).toBe(500);
    expect(parseCnyAmount('   ', 500)).toBe(500);
  });

  it('❗非法与负数一律回退，绝不把 NaN 或负数写进账本', () => {
    expect(parseCnyAmount('abc', 10)).toBe(10);
    expect(parseCnyAmount('-5', 10)).toBe(10);
    expect(parseCnyAmount('Infinity', 10)).toBe(10);
  });
});
describe('CnyAmountSchema', () => {
  it('接受非负、最多两位小数的金额', () => {
    expect(CnyAmountSchema.safeParse(0).success).toBe(true);
    expect(CnyAmountSchema.safeParse(1000).success).toBe(true);
    expect(CnyAmountSchema.safeParse(12.34).success).toBe(true);
    expect(CnyAmountSchema.safeParse(0.07).success).toBe(true);
  });

  it('❗拒绝负数与三位以上小数 —— 否则会在 Decimal 列被静默截断', () => {
    expect(CnyAmountSchema.safeParse(-1).success).toBe(false);
    expect(CnyAmountSchema.safeParse(0.001).success).toBe(false);
    expect(CnyAmountSchema.safeParse(1.2345).success).toBe(false);
    expect(CnyAmountSchema.safeParse(Number.NaN).success).toBe(false);
  });
});
