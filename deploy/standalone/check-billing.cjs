// Match SettingService resolution without printing credentials or upstream data.
const { PrismaClient } = require('@prisma/client');
const { createDecipheriv, createHash } = require('node:crypto');
const db = new PrismaClient();

function decrypt(stored) {
  if (!stored.startsWith('enc:v1:')) return stored;
  const [iv, tag, data] = stored.slice(7).split(':');
  const key = createHash('sha256').update(process.env.JWT_SECRET).digest();
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8');
}

async function check() {
  const rows = await db.systemSetting.findMany({ where: { key: { in: ['SUB2API_BASE_URL', 'SUB2API_API_KEY'] } } });
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  const base = values.SUB2API_BASE_URL || process.env.SUB2API_BASE_URL;
  let apiKey = process.env.SUB2API_API_KEY;
  if (values.SUB2API_API_KEY) {
    try { apiKey = decrypt(values.SUB2API_API_KEY); } catch { /* SettingService falls back to env. */ }
  }
  if (!base || !apiKey) throw new Error('Missing effective upstream configuration');
  const response = await fetch(`${base.replace(/\/$/, '')}/sub2api/billing`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000),
  });
  const result = await response.json().catch(() => null);
  const valid = response.ok && result?.object === 'sub2api.key_billing'
    && result?.schema_version === 1 && result?.billing_scope === 'token'
    && Number.isFinite(result?.effective_rate_multiplier) && result.effective_rate_multiplier >= 0;
  console.log(JSON.stringify({ check: 'effective-upstream-billing', status: response.status, contractValid: valid }));
  if (!valid) throw new Error('Upstream billing contract unavailable');
}

check().catch(() => {
  console.error('Effective upstream billing preflight failed');
  process.exitCode = 1;
}).finally(() => db.$disconnect());
