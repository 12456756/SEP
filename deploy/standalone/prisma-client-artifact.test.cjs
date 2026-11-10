const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const script = path.join(__dirname, 'prisma-client-artifact.cjs');
const temporaryRoots = [];
const current = {
  models: [
    { name: 'Enterprise', fields: [{ name: 'id', type: 'String' }] },
    { name: 'EnterpriseDeletionJob', fields: [{ name: 'id', type: 'String' }] },
  ],
  enums: [],
};
const stale = { models: [current.models[0]], enums: [] };

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporaryDirectory = path.resolve(__dirname, '../../tmp');
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'sep-prisma-artifact-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'source');
  const bundle = path.join(root, 'bundle');
  writeClient(source, current);
  writeClient(bundle, stale);
  return { source, bundle };
}

function generatedDirectory(root) {
  return path.join(root, 'node_modules/@prisma/node_modules/.prisma/client');
}

function writeClient(root, datamodel, delegates = datamodel.models.map(({ name }) => name)) {
  const entry = path.join(root, 'node_modules/@prisma/client');
  const generated = generatedDirectory(root);
  fs.mkdirSync(entry, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(path.join(root, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), 'source schema');
  fs.writeFileSync(path.join(entry, 'index.js'), "module.exports = require('.prisma/client/default');");
  fs.writeFileSync(path.join(generated, 'schema.prisma'), JSON.stringify(datamodel));
  fs.writeFileSync(path.join(generated, 'default.js'), `
    exports.Prisma = { dmmf: { datamodel: ${JSON.stringify(datamodel)} } };
    exports.PrismaClient = class {
      constructor() {
        for (const name of ${JSON.stringify(delegates)}) {
          this[name[0].toLowerCase() + name.slice(1)] = { findUnique() {} };
        }
      }
      async $disconnect() {}
    };
  `);
}

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('replaces the client actually resolved by Node and verifies the production bundle', () => {
  const { source, bundle } = fixture();
  // A top-level .prisma directory must not override the package-local resolution.
  const decoy = path.join(bundle, 'node_modules/.prisma/client');
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, 'default.js'), "throw new Error('wrong generated client');");
  const obsolete = path.join(generatedDirectory(bundle), 'obsolete.js');
  fs.writeFileSync(obsolete, 'old generated file');

  const copied = run('sync', source, bundle);
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(fs.existsSync(obsolete), false);
  const checked = run('check', bundle);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /verified: 2 models/);
});

test('rejects stale generated files even when the source schema is current', () => {
  const { source, bundle } = fixture();
  assert.equal(run('sync', source, bundle).status, 0);
  writeClient(bundle, stale);

  const checked = run('check', bundle);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /runtime generated Prisma Client is stale/);
});

test('rejects field drift even when all model names and the generated schema are present', () => {
  const { source, bundle } = fixture();
  assert.equal(run('sync', source, bundle).status, 0);
  const changed = structuredClone(current);
  changed.models[1].fields.push({ name: 'leaseToken', type: 'String' });
  writeClient(bundle, changed);
  fs.copyFileSync(path.join(generatedDirectory(source), 'schema.prisma'),
    path.join(generatedDirectory(bundle), 'schema.prisma'));

  const checked = run('check', bundle);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /runtime Prisma datamodel does not match/);
});

test('rejects a runtime client with a missing model delegate', () => {
  const { source, bundle } = fixture();
  assert.equal(run('sync', source, bundle).status, 0);
  writeClient(bundle, current, ['Enterprise']);

  const checked = run('check', bundle);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /Missing Prisma model delegate: EnterpriseDeletionJob/);
});

test('rejects a packaged schema changed after generation', () => {
  const { source, bundle } = fixture();
  assert.equal(run('sync', source, bundle).status, 0);
  fs.writeFileSync(path.join(bundle, 'prisma/schema.prisma'), 'a different schema');

  const checked = run('check', bundle);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /packaged Prisma schema does not match/);
});
