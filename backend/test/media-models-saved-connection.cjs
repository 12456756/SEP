/* Run inside the deployed backend: node < media-models-saved-connection.cjs. */
const { PrismaClient } = require('@prisma/client');
const { createDecipheriv, createHash } = require('node:crypto');

function decrypt(stored) {
  if (!stored.startsWith('enc:v1:')) return stored;
  const [iv, tag, body] = stored.slice(7).split(':');
  const key = createHash('sha256').update(process.env.JWT_SECRET).digest();
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  cipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8');
}

async function main() {
  const prisma = new PrismaClient({ log: [] });
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ['MEDIA_BASE_URL', 'MEDIA_API_KEY'] } }, select: { key: true, value: true },
    });
    const settings = new Map(rows.map(row => [row.key, row.value]));
    const base = new URL(settings.get('MEDIA_BASE_URL') || process.env.MEDIA_BASE_URL);
    if (base.origin !== 'https://ai.longdaoec.com' || base.search || base.hash || base.username || base.password || !['/', '/v1', '/v1/'].includes(base.pathname)) throw new Error('UNEXPECTED_MEDIA_ORIGIN');
    const stored = settings.get('MEDIA_API_KEY');
    const key = stored ? decrypt(stored) : process.env.MEDIA_API_KEY;
    if (!key || /[\r\n]/.test(key)) throw new Error('MEDIA_CONNECTION_UNAVAILABLE');
    async function call(path, body) {
      const response = await fetch(base.origin + '/v1' + path, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
      let value;
      try { value = JSON.parse(text); } catch { value = null; }
      return { status: response.status, value };
    }
    const catalog = await call('/models');
    const ids = catalog.status === 200 && Array.isArray(catalog.value?.data)
      ? [...new Set(catalog.value.data.map(model => model.id).filter(id => typeof id === 'string'))].sort() : [];
    const models = [];
    for (const model of ids.filter(id => /image|imagen|flux|dall|banana|seedream/i.test(id))) {
      const quotes = [];
      for (const operation of ['generate', 'edit']) {
        const result = await call('/sub2api/images/pricing', { model, operation, size: '1024x1024', n: 1, quality: 'medium' });
        const value = result.value;
        quotes.push({ operation, httpStatus: result.status, model: value?.model ?? null,
          pricingStatus: value?.pricing_status ?? null, billingMode: value?.billing_mode ?? null,
          amountUsd: value?.amount_usd ?? null, pricingAuthority: value?.pricing_authority ?? null,
          pricingSource: value?.pricing_source ?? null, pricingVersion: value?.pricing_version ?? null,
          errorCode: value?.error?.code ?? value?.code ?? null });
      }
      models.push({ modelId: model, quotes });
    }
    const profiles = await prisma.mediaModelProfile.findMany({ select: {
      profileId: true, modelId: true, configVersion: true, enabled: true, verified: true, operations: true, capabilities: true,
    } });
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'read-only',
      baseUrl: base.origin + '/v1', credentialSource: stored ? 'saved-web-connection' : 'environment',
      catalogStatus: catalog.status, catalogModelIds: ids, imageModels: models, profiles,
      executionPosts: 0, configurationWrites: 0 }, null, 2));
  } finally { await prisma.$disconnect(); }
}

main().catch(() => { console.error('SAVED_MEDIA_PREFLIGHT_FAILED'); process.exitCode = 1; });
