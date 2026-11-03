// Parse checked-in YAML only; never resolve Compose interpolation or load .env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
// Reuse the workspace's installed tooling dependency without adding a package.
const packages = path.join(root, 'node_modules/.pnpm');
const parser = fs.readdirSync(packages).find(name =>
  name.startsWith('js-yaml@4.') && fs.existsSync(path.join(packages, name, 'node_modules/js-yaml')),
);
assert.ok(parser, 'existing js-yaml tooling dependency must be installed');
const yaml = require(path.join(packages, parser, 'node_modules/js-yaml'));
const defaults = {
  MEMBER_CONCURRENCY: 4,
  ENTERPRISE_CONCURRENCY: 32,
  MEMBER_RPM: 120,
  ENTERPRISE_RPM: 600,
  ENTERPRISE_TOKEN_BUDGET: 0,
  DEFAULT_MAX_TOKENS: 0,
  HTTP_JSON_LIMIT: '4mb',
  MAX_REQUEST_BYTES: 4194304,
  JSON_MAX_BYTES: 8388608,
  ERROR_MAX_BYTES: 65536,
  AUTH_TOKEN_MAX_BYTES: 4096,
  AUTH_FAILURE_TOKEN_LIMIT: 120,
  AUTH_FAILURE_SOURCE_LIMIT: 1200,
  AUTH_FAILURE_WINDOW_MS: 60000,
  MODEL_RATE_LIMIT: 60,
  MODEL_RATE_WINDOW_MS: 60000,
};

for (const [file, services] of [
  ['docker-compose.yml', ['sep-backend']],
  ['docker-compose.blue-green.yml', ['blue-backend', 'green-backend']],
  ['docker-compose.dev.yml', ['dev-backend']],
]) {
  const compose = yaml.load(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  for (const name of services) {
    const backend = compose.services[name];
    const environment = Array.isArray(backend.environment)
      ? Object.fromEntries(backend.environment.map(entry => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }))
      : backend.environment;
    for (const [suffix, value] of Object.entries(defaults)) {
      const key = `GATEWAY_${suffix}`;
      assert.equal(environment[key], '${' + key + ':-' + value + '}', `${file}/${name}/${key}`);
    }
    for (const [suffix, value] of Object.entries({ ENABLED: 'false', INSTANCE_ID: '', MIN_CLIENT_VERSION: '1.0.0', UPLOAD_CONCURRENCY: '1' })) {
      const key = `SKILL_IMPORT_${suffix}`;
      assert.equal(environment[key], '${' + key + ':-' + value + '}', `${file}/${name}/${key}`);
    }
    for (const key of ['WEB_DEFAULT_MAX_OUTPUT_TOKENS', 'PLANNER_MAX_OUTPUT_TOKENS', 'MODEL_MAX_OUTPUT_TOKENS']) {
      assert.equal(environment[key], '${' + key + ':-0}', `${file}/${name}/${key}`);
    }
    if (file !== 'docker-compose.dev.yml') {
      assert.equal(environment.SEP_GATEWAY_DRAIN_TIMEOUT_MS, '${SEP_GATEWAY_DRAIN_TIMEOUT_MS:-}');
      assert.equal(backend.stop_grace_period, '${SEP_STOP_GRACE_SECONDS:-30}s');
      assert.equal(environment.MEDIA_GATEWAY_REAL_ENABLED, '${MEDIA_GATEWAY_REAL_ENABLED:-false}');
      assert.ok(backend.healthcheck.test.join(' ').includes('3001/health'));
    }
    assert.equal(environment.EMBEDDING_PROVIDER, '${EMBEDDING_PROVIDER:-ollama}');
    assert.equal(environment.EMBEDDING_BASE_URL, '${EMBEDDING_BASE_URL:-http://sep-ollama:11434}');
    assert.equal(environment.EMBEDDING_MODEL, '${EMBEDDING_MODEL:-bge-m3:sep-790764642607}');
    assert.equal(environment.EMBEDDING_MODEL_DIGEST, '${EMBEDDING_MODEL_DIGEST:-sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab}');
    assert.equal(environment.EMBEDDING_TOKENIZER, '${EMBEDDING_TOKENIZER:-BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181}');
    assert.equal(environment.EMBEDDING_TOKENIZER_PATH, '${EMBEDDING_TOKENIZER_PATH:-/app/tokenizers/bge-m3/5617a9f61b028005a4858fdac845db406aefb181}');
    assert.ok(backend.volumes.includes('${KNOWLEDGE_TOKENIZERS_HOST_PATH:-../../.cache/tokenizers}:/app/tokenizers:ro'));
    assert.equal(environment.KNOWLEDGE_PRIVATE_PATH, '/app/private/knowledge');
    const privateRoot = file === 'docker-compose.dev.yml' ? '/opt/sep/knowledge-dev' : '/opt/sep/knowledge';
    assert.ok(backend.volumes.includes('${KNOWLEDGE_PRIVATE_HOST_PATH:-' + privateRoot + '}:/app/private/knowledge'));
  }
}
console.log('sep-compose tests passed (gateway policy and pinned private Ollama/tokenizer configuration, production/dev/all colors)');
