const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireSuccessfulQuality } = require('./quality-guard.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_SHA: sha, GITHUB_REPOSITORY: '12456756/SEP', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'test' };
const main = () => ({ object: { sha } });
const run = (overrides = {}) => ({ id: 1, head_sha: sha, head_branch: 'main', event: 'push', head_repository: { full_name: '12456756/SEP' }, status: 'completed', conclusion: 'success', ...overrides });
function fixture(responses, envOverrides = {}) {
  let now = 0; const calls = [];
  return { calls, run: () => requireSuccessfulQuality({
    env: { ...env, ...envOverrides }, now: () => now, sleep: async ms => { now += ms; }, log() {},
    fetch: async url => { calls.push(url); const value = responses.shift(); assert.notEqual(value, undefined, 'Unexpected API request'); return { ok: !value.httpStatus, status: value.httpStatus, json: async () => value }; },
  }) };
}
test('requires a successful Quality Gates run for the exact pushed main commit', async () => {
  const f = fixture([main(), { workflow_runs: [run()] }, main()]);
  assert.equal((await f.run()).sha, sha);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[1].includes(`head_sha=${sha}`));
});
test('waits for the run and does not dispatch another workflow', async () => {
  const f = fixture([main(), { workflow_runs: [run({ status: 'in_progress', conclusion: null })] }, { workflow_runs: [run()] }, main()]);
  await f.run(); assert.equal(f.calls.length, 4);
});
for (const conclusion of ['failure', 'cancelled', 'timed_out']) test(`blocks ${conclusion}`, async () => {
  await assert.rejects(fixture([main(), { workflow_runs: [run({ conclusion })] }]).run(), /blocked/);
});
test('blocks stale refs, wrong runs, API permission failures and other branches', async () => {
  await assert.rejects(fixture([{ object: { sha: 'b'.repeat(40) } }]).run(), /main changed/);
  await assert.rejects(fixture([main(), { workflow_runs: [run({ head_sha: 'b'.repeat(40) })] }]).run(), /does not match/);
  await assert.rejects(fixture([{ httpStatus: 403 }]).run(), /HTTP 403/);
  const f = fixture([], { GITHUB_REF: 'refs/heads/other' });
  await assert.rejects(f.run(), /must use/); assert.equal(f.calls.length, 0);
});
