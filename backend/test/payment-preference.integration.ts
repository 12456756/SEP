import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ComputeCreditService } from '../src/modules/compute-credit/compute-credit.service';
import { MediaRealBillingService } from '../src/modules/media-gateway/media-real-billing.service';
import { sumEnterpriseUsed } from '../src/modules/compute-credit/member-allowance-window';
import type { ClientEmploymentClaims } from '../src/modules/client/client-employment.guard';

async function main() {
  const url = process.env.PAYMENT_TEST_DATABASE_URL;
  assert(url, 'PAYMENT_TEST_DATABASE_URL must point to an isolated test database');
  const parsed = new URL(url);
  assert(parsed.hostname === '127.0.0.1' && parsed.port === '55439' && parsed.pathname === '/sep_payment_test');
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const tag = randomUUID();
    const user = await db.user.create({ data: { email: `payment-${tag}@example.test` } });
    const colleague = await db.user.create({ data: { email: `colleague-${tag}@example.test` } });
    const company = await db.enterprise.create({ data: { name: `Payment test ${tag}` } });
    const membership = await db.enterpriseMember.create({ data: { userId: user.id, enterpriseId: company.id } });
    await db.enterpriseMember.create({ data: { userId: colleague.id, enterpriseId: company.id } });
    await db.personalWallet.create({ data: { userId: user.id, balance: 20 } });
    const preferences = new ComputeCreditService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const billing = new MediaRealBillingService(db as never);
    const claims = { sub: user.id, enterpriseId: company.id, memberId: membership.id, subscriptionId: `test-${tag}` } as ClientEmploymentClaims;
    assert.deepEqual(await preferences.getPaymentPreference(company.id, user.id), { paymentMode: 'AUTO' });
    const quote = await billing.quoteFunding(claims, '5.000000');
    assert.equal(quote.paymentMode, 'AUTO');
    await preferences.setPaymentPreference(company.id, user.id, 'PERSONAL_ONLY');
    assert.deepEqual(await preferences.getPaymentPreference(company.id, colleague.id), { paymentMode: 'AUTO' });
    await assert.rejects(billing.reserve(claims, `old-${tag}`, '5.000000', 7, 'AUTO'), (error: any) => error.getResponse().error.code === 'PAYMENT_MODE_CHANGED');
    const receipt = `receipt-${tag}`;
    await Promise.all([
      billing.reserve(claims, receipt, '5.000000', 7, 'PERSONAL_ONLY'),
      billing.reserve(claims, receipt, '5.000000', 7, 'PERSONAL_ONLY'),
    ]);
    assert.equal((await db.personalWallet.findUniqueOrThrow({ where: { userId: user.id } })).balance.toFixed(6), '15.000000');
    assert.equal(await db.personalWalletTransaction.count({ where: { relatedId: receipt } }), 1);
    await preferences.setPaymentPreference(company.id, user.id, 'ENTERPRISE_ONLY');
    await billing.reserve(claims, receipt, '5.000000', 7, 'PERSONAL_ONLY');
    await billing.release(receipt); await billing.release(receipt);
    assert.equal((await db.personalWallet.findUniqueOrThrow({ where: { userId: user.id } })).balance.toFixed(6), '20.000000');
    assert.equal(await db.personalWalletTransaction.count({ where: { relatedId: receipt } }), 2);
    await assert.rejects(billing.reserve(claims, `company-${tag}`, '5.000000', 7, 'ENTERPRISE_ONLY'), (error: any) => error.getStatus() === 402);
    const usage = { enterpriseId: company.id, userId: user.id, modelId: 'synthetic', inputTokens: 0, outputTokens: 0,
      inputPriceUsdPerMillion: 0, outputPriceUsdPerMillion: 0, usdToCnyRate: 7, costCNY: 3, unpaidCNY: 3 };
    await db.computeUsageRecord.create({ data: { ...usage, paymentMode: 'PERSONAL_ONLY', idempotencyKey: `personal-debt-${tag}` } });
    const range = { enterpriseId: company.id, userId: user.id, from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) };
    assert.equal((await sumEnterpriseUsed(db as never, range)).toFixed(6), '0.000000');
    await db.computeUsageRecord.create({ data: { ...usage, paymentMode: 'ENTERPRISE_ONLY', idempotencyKey: `company-debt-${tag}` } });
    assert.equal((await sumEnterpriseUsed(db as never, range)).toFixed(6), '3.000000');
    console.log('PASS: preference isolation, default AUTO, quote changes, concurrent reserve, frozen replay/refund, company-only rejection, personal debt quota isolation');
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
