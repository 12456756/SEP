import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { configSchema } = require('next/dist/server/config-schema');
let configImportId = 0;

async function loadConfig(env = {}) {
  const values = {
    SEP_API_PROXY_TIMEOUT_MS: undefined,
    API_ORIGIN: undefined,
    NODE_ENV: 'production',
    ...env,
  };
  const previousValues = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const url = new URL('./next.config.mjs', import.meta.url);
    url.searchParams.set('test', String(configImportId++));
    return (await import(url.href)).default;
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('defaults the external API proxy timeout to 330000ms', async () => {
  const config = await loadConfig();
  assert.equal(config.experimental.proxyTimeout, 330000);
});

test('accepts positive integer timeout overrides', async (t) => {
  for (const value of ['1', '120000', '600000', '0180000', '2147483647']) {
    await t.test(value, async () => {
      const config = await loadConfig({ SEP_API_PROXY_TIMEOUT_MS: value });
      assert.equal(config.experimental.proxyTimeout, Number(value));
    });
  }
});

test('falls back to 330000ms for invalid timeout overrides', async (t) => {
  for (const value of [
    '', ' ', '0', '000', '-1', '1.5', '180000ms', '1e5', '0x10',
    'Infinity', 'NaN', ' 180000 ', '+180000', '9007199254740992',
    '2147483648', '9007199254740991',
    '9'.repeat(400),
  ]) {
    await t.test(JSON.stringify(value), async () => {
      const config = await loadConfig({ SEP_API_PROXY_TIMEOUT_MS: value });
      assert.equal(config.experimental.proxyTimeout, 330000);
    });
  }
});

test('installed Next schema accepts and retains the experimental timeout', async () => {
  const config = await loadConfig();
  const parsed = configSchema.parse(config);
  assert.equal(parsed.experimental.proxyTimeout, 330000);
  assert.equal(parsed.experimental.proxyClientMaxBodySize, '110mb');
});

test('preserves the default API rewrite', async () => {
  const config = await loadConfig();
  assert.deepEqual(await config.rewrites(), [
    { source: '/api/:path*', destination: 'http://localhost:3001/api/:path*' },
  ]);
});

test('preserves API_ORIGIN overrides and empty-origin fallback', async (t) => {
  for (const origin of ['https://backend.example.test', '']) {
    await t.test(JSON.stringify(origin), async () => {
      const config = await loadConfig({ API_ORIGIN: origin });
      assert.deepEqual(await config.rewrites(), [
        {
          source: '/api/:path*',
          destination: `${origin || 'http://localhost:3001'}/api/:path*`,
        },
      ]);
    });
  }
});

test('preserves all other config and development output isolation', async (t) => {
  for (const nodeEnv of ['development', 'production', 'test', undefined]) {
    await t.test(String(nodeEnv), async () => {
      const config = await loadConfig({ NODE_ENV: nodeEnv });
      const { experimental, rewrites, redirects, ...unchanged } = config;
      assert.deepEqual(experimental, { proxyTimeout: 330000, proxyClientMaxBodySize: '110mb' });
      assert.equal(typeof rewrites, 'function');
      assert.deepEqual(unchanged, {
        reactStrictMode: true,
        distDir: nodeEnv === 'development' ? '.next-dev' : '.next',
        images: {
          remotePatterns: [
            { protocol: 'https', hostname: 'api.dicebear.com', pathname: '/**' },
          ],
        },
      });
      assert.deepEqual(await redirects(), [
        { source: '/permissions', destination: '/dashboard', permanent: false },
      ]);
    });
  }
});
