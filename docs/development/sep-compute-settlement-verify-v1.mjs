import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('./sep-compute-settlement-examples-v1.json', import.meta.url), 'utf8'));
const contract = readFileSync(new URL('./sep-compute-settlement-contract-v1-2026-11-20.md', import.meta.url), 'utf8');

function units(value, decimals) {
  assert.equal(typeof value, 'string');
  assert.match(value, new RegExp(`^(0|[1-9][0-9]*)\\.[0-9]{${decimals}}$`));
  return BigInt(value.replace('.', ''));
}

const cny = value => units(value, 6);
const min = (left, right) => left < right ? left : right;

function classify(sample) {
  const gross = cny(sample.gross_cny);
  const freeCap = cny(sample.max_free_cny);
  const paidCap = cny(sample.max_paid_cny);
  if (gross > freeCap + paidCap) return 'BUDGET_BREACH';
  const free = min(gross, freeCap);
  const paid = gross - free;
  if (cny(sample.free_cny) !== free || cny(sample.paid_cny) !== paid) return 'SETTLEMENT_MISMATCH';
  return 'VALID';
}

const ids = new Set();
assert.equal(fixtures.currency, 'CNY');
assert.equal(fixtures.settlement_scope, 'media_reserved');
assert(!/"(?:[^"]*_usd|usd_to_cny|fx_version)"/.test(JSON.stringify(fixtures)), 'Fixtures must not require SEP to convert USD');
for (const sample of fixtures.chat_postpaid_settlements) {
  assert(!ids.has(sample.id), `Duplicate case: ${sample.id}`);
  ids.add(sample.id);
  assert(!('max_free_cny' in sample) && !('max_paid_cny' in sample), sample.id);
  const gross = cny(sample.gross_cny);
  const free = min(gross, cny(sample.available_free_cny));
  const paidDue = gross - free;
  const collected = min(paidDue, cny(sample.available_paid_cny));
  const unpaid = paidDue - collected;
  assert.equal(cny(sample.free_cny), free, sample.id);
  assert.equal(cny(sample.paid_due_cny), paidDue, sample.id);
  assert.equal(cny(sample.collected_paid_cny), collected, sample.id);
  assert.equal(cny(sample.unpaid_cny), unpaid, sample.id);
  assert.equal(gross, free + collected + unpaid, sample.id);
  assert.equal(sample.settlement_ready, unpaid === 0n, sample.id);
}

for (const sample of fixtures.settlements) {
  assert(!ids.has(sample.id), `Duplicate case: ${sample.id}`);
  ids.add(sample.id);
  assert.equal(classify(sample), 'VALID', sample.id);
  const free = cny(sample.free_cny);
  const paid = cny(sample.paid_cny);
  const freeCap = cny(sample.max_free_cny);
  const paidCap = cny(sample.max_paid_cny);
  assert.equal(freeCap + paidCap, cny(sample.max_gross_cny), sample.id);
  assert(freeCap <= cny(sample.initial_free_cny), sample.id);
  assert(paidCap <= cny(sample.initial_paid_cny), sample.id);
  assert.equal(cny(sample.released_free_cny), freeCap - free, sample.id);
  assert.equal(cny(sample.released_paid_cny), paidCap - paid, sample.id);
  assert.equal(cny(sample.final_free_cny), cny(sample.initial_free_cny) - free, sample.id);
  assert.equal(cny(sample.final_paid_cny), cny(sample.initial_paid_cny) - paid, sample.id);
  assert.equal(cny(sample.gross_cny), cny(sample.free_cny) + cny(sample.paid_cny), sample.id);
}

for (const sample of fixtures.must_reject) {
  assert(!ids.has(sample.id), `Duplicate case: ${sample.id}`);
  ids.add(sample.id);
  assert.equal(classify(sample), sample.expected_code, sample.id);
}

let jsonBlocks = 0;
for (const block of contract.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)) {
  const example = JSON.parse(block[1]);
  assert.equal(example.contract_version, 1);
  if (!example.error) assert.equal(example.currency, 'CNY');
  assert(!Object.keys(example).some(key => key.endsWith('_usd') || key === 'usd_to_cny'), 'Contract examples must use CNY');
  jsonBlocks++;
}
assert.equal(jsonBlocks, 5, 'Unexpected number of contract JSON examples');

console.log(`PASS: ${fixtures.chat_postpaid_settlements.length} chat postpaid cases, ${fixtures.settlements.length} valid media settlements, ${fixtures.must_reject.length} rejected media settlements, ${jsonBlocks} documentation JSON examples.`);
console.log('Arithmetic and document checks only; no model requests, database changes, or integration calls were made.');
