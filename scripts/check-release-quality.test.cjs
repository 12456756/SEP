const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkReleaseQuality } = require('./check-release-quality.cjs');

const sha = '9309ea6b09659538d06fdfae5f5edac3b047b4fb';
const env = { GITHUB_SHA: sha, GITHUB_REPOSITORY: '12456756/SEP', GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'mock-only' };
const run = { id: 123, head_sha: sha, head_branch: 'main', event: 'push', head_repository: { full_name: env.GITHUB_REPOSITORY }, status: 'completed', conclusion: 'success' };

function fixture(responses, overrides = {}) {
  const calls = [];
  let time = 0;
  return {
    calls,
    check: () => checkReleaseQuality({
      env, log: () => {}, now: () => time,
      sleep: async (ms) => { time += ms; },
      fetch: async (url, options) => {
        calls.push({ url, options });
        assert.ok(responses.length, 'unexpected API call');
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return { ok: !response.httpStatus, status: response.httpStatus || 200, json: async () => response };
      },
      ...overrides,
    }),
  };
}
const main = () => ({ object: { sha } });
const runs = (...items) => ({ workflow_runs: items });

test('accepts a successful main push for the identical commit and rechecks main', async () => {
  const f = fixture([main(), runs(run), main()]);
  assert.equal((await f.check()).sha, sha);
  assert.equal(f.calls.length, 3);
  const query = new URL(f.calls[1].url);
  assert.equal(query.pathname, '/repos/12456756/SEP/actions/workflows/quality.yml/runs');
  assert.equal(query.searchParams.get('head_sha'), sha);
  assert.equal(query.searchParams.get('event'), 'push');
});

test('waits for an in-progress run without rebuilding or dispatching another workflow', async () => {
  const f = fixture([main(), runs({ ...run, status: 'in_progress', conclusion: null }), runs(run), main()]);
  await f.check();
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(({ options }) => !options.method));
});

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
  test(`blocks ${conclusion} rather than accepting an older successful run`, async () => {
    await assert.rejects(fixture([main(), runs({ ...run, conclusion })]).check(), /fix or rerun/);
  });
}

for (const mismatch of [{ head_sha: 'a'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { head_repository: { full_name: 'other/SEP' } }]) {
  test(`rejects a mismatched run: ${JSON.stringify(mismatch)}`, async () => {
    await assert.rejects(fixture([main(), runs({ ...run, ...mismatch })]).check(), /does not match/);
  });
}

test('rejects non-production branches before any API call', async () => {
  const f = fixture([], { env: { ...env, GITHUB_REF: 'refs/heads/test' } });
  await assert.rejects(f.check(), /must use/);
  assert.equal(f.calls.length, 0);
});

test('rejects queued deployments when main has advanced before or during the quality check', async () => {
  for (const responses of [[{ object: { sha: 'a'.repeat(40) } }], [main(), runs(run), { object: { sha: 'a'.repeat(40) } }]]) {
    await assert.rejects(fixture(responses).check(), /main has advanced/);
  }
});

test('gives an actionable error when a quality run never appears', async () => {
  await assert.rejects(fixture([main(), ...Array.from({ length: 5 }, () => runs())]).check(), /No main push/);
});

test('bounds waiting for a running quality check', async () => {
  await assert.rejects(fixture([main(), runs({ ...run, status: 'queued' })], { timeoutMs: 100 }).check(), /did not pass/);
});

test('fails closed on API permission failures or malformed results', async () => {
  await assert.rejects(fixture([{ httpStatus: 403 }]).check(), /HTTP 403/);
  await assert.rejects(fixture([main(), {}]).check(), /Invalid Quality Gates/);
});

test('retries transient GitHub failures and blocks persistent network failure', async () => {
  await fixture([{ httpStatus: 503 }, main(), runs(run), main()]).check();
  await assert.rejects(fixture([new Error('network'), new Error('network'), new Error('network')]).check(), /after 3 attempts/);
});
