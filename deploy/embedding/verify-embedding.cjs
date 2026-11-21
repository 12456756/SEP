const assert = require('node:assert/strict');

const MODEL = 'bge-m3:sep-790764642607';
const DIGEST = '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab';
const TOKENIZER = 'BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181';
const FILES = {
  'tokenizer.json': '21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08',
  'tokenizer_config.json': 'a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4',
};

function validateEmbeddings(body, count) {
  assert.equal(body.model, MODEL, 'Embedding model mismatch');
  assert.equal(body.embeddings?.length, count, 'Embedding count mismatch');
  for (const vector of body.embeddings) {
    assert.ok(Array.isArray(vector) && vector.length === 1024, 'Embedding dimension mismatch');
    assert.ok(vector.every(n => typeof n === 'number' && Number.isFinite(n)), 'Invalid vector value');
    assert.ok(vector.some(n => n !== 0), 'All-zero vector');
  }
}

function validateEnvironment(env) {
  const expected = {
    EMBEDDING_PROVIDER: 'ollama', EMBEDDING_BASE_URL: 'http://sep-ollama:11434',
    EMBEDDING_MODEL: MODEL, EMBEDDING_MODEL_DIGEST: `sha256:${DIGEST}`,
    EMBEDDING_DIMENSION: '1024', EMBEDDING_DISTANCE: 'cosine', EMBEDDING_TOKENIZER: TOKENIZER,
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, `${key} mismatch`);
  assert.equal(env.EMBEDDING_TOKENIZER_PATH, `/app/tokenizers/bge-m3/${TOKENIZER.split('@')[1]}`);
}

function checkBackend(env = process.env) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  validateEnvironment(env);
  for (const [name, expected] of Object.entries(FILES)) {
    const bytes = fs.readFileSync(path.join(env.EMBEDDING_TOKENIZER_PATH, name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, `${name} checksum mismatch`);
  }
  console.log(JSON.stringify({ check: 'backend-configuration-and-tokenizer', status: 'passed' }));
}

async function verify({ mode = 'full', fetch = globalThis.fetch, log = console.log } = {}) {
  assert.ok(['full', 'quick', 'source'].includes(mode), 'Unknown verification mode');
  const base = 'http://sep-ollama:11434';
  const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) });
  assert.ok(tags.ok, `Tags returned HTTP ${tags.status}`);
  const models = (await tags.json()).models;
  const name = mode === 'source' ? 'bge-m3:567m-fp16' : MODEL;
  assert.equal(models?.find(m => m.name === name)?.digest, DIGEST, 'Model manifest mismatch');
  log(JSON.stringify({ check: 'model-manifest', model: name, digest: DIGEST, status: 'passed' }));
  if (mode === 'source') return;
  async function request(input, keepAlive = '5m') {
    const started = Date.now();
    const response = await fetch(`${base}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: MODEL, input, truncate: false, keep_alive: keepAlive }),
    });
    return { response, elapsedMs: Date.now() - started };
  }
  async function check(input) {
    const { response, elapsedMs } = await request(input);
    assert.ok(response.ok, `Embedding returned HTTP ${response.status}`);
    const count = Array.isArray(input) ? input.length : 1;
    validateEmbeddings(await response.json(), count);
    log(JSON.stringify({ check: 'embedding', count, dimension: 1024, elapsedMs, status: 'passed' }));
  }
  await check('知识库服务部署验证。');
  if (mode === 'quick') return;
  await check(['员工可以查询企业知识库。', '出差申请需要主管审批。']);
  await check(Array.from({ length: 8 }, (_, i) => `第${i + 1}段。${'这是一份用于检验批量向量化的合成资料。'.repeat(20)}`));
  const oversized = await request('test '.repeat(20000));
  assert.equal(oversized.response.status, 400, 'Oversized input must return an input error, not a timeout or server error');
  assert.match(await oversized.response.text(), /context|length|token|input.*long/i);
  log(JSON.stringify({ check: 'oversized-input-rejected', status: 'passed' }));
  const unloaded = await request([], 0);
  assert.ok(unloaded.response.ok, 'Model unload request failed');
  await unloaded.response.arrayBuffer();
  await check('冷加载后仍然可以进行知识库向量化。');
}

module.exports = { validateEmbeddings, validateEnvironment, verify, MODEL, DIGEST };
if (require.main === module || module.id === '[stdin]') {
  Promise.resolve().then(() => process.argv[2] === 'backend-config'
    ? checkBackend() : verify({ mode: process.argv[2] || 'full' }))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
