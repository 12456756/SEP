import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.argv[2] ?? 'outputs/compute-integration/keys');
const relative = path.relative(root, directory);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Key output must stay inside this workspace ignored outputs directory');
execFileSync('git', ['check-ignore', '--quiet', path.join(directory, 'signing-private.pem')], { cwd: root });
await mkdir(directory, { recursive: true });
const id = randomUUID();
const signing = generateKeyPairSync('ed25519');
const encryption = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicConfiguration = { signing_key_id: `sep-sign-${id}`, signing_public_key: signing.publicKey.export({ type: 'spki', format: 'pem' }),
  encryption_key_id: `sep-enc-${id}`, encryption_public_key: encryption.publicKey.export({ type: 'spki', format: 'pem' }) };
const files = {
  'signing-private.pem': signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  'encryption-private.pem': encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  'signing-public.pem': publicConfiguration.signing_public_key,
  'encryption-public.pem': publicConfiguration.encryption_public_key,
  'public-configuration.json': JSON.stringify(publicConfiguration, null, 2) + '\n',
};
for (const [name, value] of Object.entries(files)) await writeFile(path.join(directory, name), value, { flag: 'wx', mode: 0o600 });
console.log(`Created SEP keys in ${directory}`);
console.log('Give only public-configuration.json to the compute platform. Keep both *-private.pem files on SEP. Existing files are never overwritten.');
