const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEmbeddings, validateEnvironment, verify, MODEL, DIGEST } = require('./verify-embedding.cjs');
const good = count => ({ model: MODEL, embeddings: Array.from({ length: count }, () => Array(1024).fill(0.1)) });

test('validates every vector, model and result count', () => {
  validateEmbeddings(good(8), 8);
  for (const body of [good(1), { ...good(2), model: 'other' }, { model: MODEL, embeddings: [[1], [1]] },
    { model: MODEL, embeddings: [Array(1024).fill(0), Array(1024).fill(1)] },
    { model: MODEL, embeddings: [Array(1024).fill(NaN), Array(1024).fill(1)] }]) {
    assert.throws(() => validateEmbeddings(body, 2));
  }
});

test('requires the existing backend model profile', () => {
  const env = { EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://sep-ollama:11434',
    EMBEDDING_MODEL: MODEL, EMBEDDING_MODEL_DIGEST: `sha256:${DIGEST}`, EMBEDDING_DIMENSION: '1024',
    EMBEDDING_DISTANCE: 'cosine', EMBEDDING_TOKENIZER: 'BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181',
    EMBEDDING_TOKENIZER_PATH: '/app/tokenizers/bge-m3/5617a9f61b028005a4858fdac845db406aefb181' };
  validateEnvironment(env);
  for (const key of Object.keys(env)) assert.throws(() => validateEnvironment({ ...env, [key]: 'wrong' }));
});

function fixture({ digest = DIGEST, oversizedStatus = 400, invalidVector = false } = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: MODEL, digest }] }) };
    const body = JSON.parse(options.body);
    assert.equal(body.truncate, false);
    if (typeof body.input === 'string' && body.input.length > 50000) return { status: oversizedStatus, text: async () => 'input exceeds maximum context length' };
    if (body.keep_alive === 0) return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, json: async () => invalidVector ? good(0) : good(Array.isArray(body.input) ? body.input.length : 1) };
  } };
}
test('exercises single, batch, long input rejection and cold reload without logging texts or vectors', async () => {
  const f = fixture(); const logs = [];
  await verify({ fetch: f.fetch, log: line => logs.push(line) });
  assert.equal(f.calls.length, 7);
  assert.ok(f.calls.some(c => c.options?.body && JSON.parse(c.options.body).keep_alive === 0));
  assert.ok(logs.every(line => !line.includes('embeddings') && !line.includes('知识库')));
});
test('rejects manifest drift before inference', async () => {
  const f = fixture({ digest: 'changed' });
  await assert.rejects(verify({ fetch: f.fetch, log() {} }), /manifest mismatch/);
  assert.equal(f.calls.length, 1);
});
test('does not treat server failures or malformed vectors as valid rejection', async () => {
  for (const oversizedStatus of [200, 500, 503]) await assert.rejects(verify({ fetch: fixture({ oversizedStatus }).fetch, log() {} }));
  await assert.rejects(verify({ fetch: fixture({ invalidVector: true }).fetch, log() {} }));
});

test('actually executes the probe when piped to node in the deployment container', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./verify-embedding.cjs'), 'utf8');
  const preload = `globalThis.fetch=async()=>({ok:true,json:async()=>({models:[{name:'bge-m3:567m-fp16',digest:'${DIGEST}'}]})});\n`;
  const child = spawnSync(process.execPath, ['-', 'source'], { input: preload + source, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /"check":"model-manifest"/);
  assert.match(child.stdout, /"status":"passed"/);
});
