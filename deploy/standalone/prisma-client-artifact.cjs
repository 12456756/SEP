const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function resolveClient(root) {
  const projectRequire = createRequire(path.resolve(root, 'package.json'));
  const entry = projectRequire.resolve('@prisma/client');
  // pnpm resolves .prisma relative to the real package, inside its virtual store.
  const generated = path.dirname(createRequire(entry).resolve('.prisma/client/default'));
  return { projectRequire, generated };
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifestPath(root) {
  return path.resolve(root, 'prisma/client-manifest.json');
}

function sync(sourceRoot, targetRoot) {
  const source = resolveClient(sourceRoot);
  const target = resolveClient(targetRoot);
  const relative = path.relative(fs.realpathSync(targetRoot), fs.realpathSync(target.generated));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'The production generated client must be inside the production bundle');
  assert.notEqual(fs.realpathSync(source.generated), fs.realpathSync(target.generated),
    'The source and production clients must be separate artifacts');

  // Replace the generated artifact as a unit so old generated files cannot survive.
  fs.rmSync(target.generated, { recursive: true, force: true });
  fs.cpSync(source.generated, target.generated, { recursive: true, dereference: true });
  fs.writeFileSync(manifestPath(targetRoot), JSON.stringify({
    schemaHash: digest(path.resolve(sourceRoot, 'prisma/schema.prisma')),
    generatedSchemaHash: digest(path.join(source.generated, 'schema.prisma')),
    datamodel: source.projectRequire('@prisma/client').Prisma.dmmf.datamodel,
  }));
}

async function check(root) {
  const expected = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
  const actual = resolveClient(root);
  assert.equal(digest(path.resolve(root, 'prisma/schema.prisma')), expected.schemaHash,
    'The packaged Prisma schema does not match the build');
  assert.equal(digest(path.join(actual.generated, 'schema.prisma')), expected.generatedSchemaHash,
    'The runtime generated Prisma Client is stale');
  const { Prisma, PrismaClient } = actual.projectRequire('@prisma/client');
  assert.deepEqual(Prisma.dmmf.datamodel, expected.datamodel,
    'The runtime Prisma datamodel does not match the build');
  const client = new PrismaClient();
  try {
    for (const { name } of expected.datamodel.models) {
      const delegate = client[name[0].toLowerCase() + name.slice(1)];
      assert.equal(typeof delegate?.findUnique, 'function', `Missing Prisma model delegate: ${name}`);
    }
    console.log(`Prisma Client artifact verified: ${expected.datamodel.models.length} models`);
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  const [mode, source, target] = process.argv.slice(2);
  if (mode === 'sync' && source && target) return sync(source, target);
  if (mode === 'check' && source && !target) return check(source);
  throw new Error('Usage: prisma-client-artifact.cjs sync <source-root> <bundle-root> | check <runtime-root>');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
