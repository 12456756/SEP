import { ConfigService } from '@nestjs/config';
import { constants, createCipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputeProtocolClient } from './compute-protocol.client';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeIntegrationIdSchema, ComputeIntegrationMoneySchema } from 'shared';

const signing = generateKeyPairSync('ed25519');
const encryption = generateKeyPairSync('rsa', { modulusLength: 3072 });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const passwordHash = '$2b$10$' + 'a'.repeat(53);
const account = { enterprise_id: 'ent1', compute_account_id: 123, company_name: 'Company', admin_email: 'admin@example.test',
  status: 'ready', billing_mode: 'sep_settlement_v1' };
function jwe(payload: unknown, patch = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: 'enc1', ...patch })).toString('base64url');
  const cek = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv); cipher.setAAD(Buffer.from(header));
  return [header, publicEncrypt({ key: encryption.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, cek).toString('base64url'),
    iv.toString('base64url'), Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
function registration(foreign = false) {
  return { ...account, credentials: ['chat', 'image', 'video'].map(type => ({ type, credential_id: `cred_${type}`, credential_version: 1,
    group_id: 1, encryption_key_id: 'enc1', masked_key: 'sk-***', delivery_status: 'available',
    encrypted_key: jwe({ enterprise_id: foreign ? 'other' : 'ent1', compute_account_id: 123, type, credential_id: `cred_${type}`, credential_version: 1, key: `sk-fixture-${type}` }),
  })) };
}

describe('SEP v1 signed transport and remote contracts', () => {
  let directory: string, config: ConfigService, client: ComputeProtocolClient, remote: ComputeRemoteAdapter, fetcher: jest.SpyInstance;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'sep-protocol-'));
    writeFileSync(join(directory, 'sign.pem'), signing.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(directory, 'enc.pem'), encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  beforeEach(() => {
    config = new ConfigService({ NODE_ENV: 'test', COMPUTE_INTEGRATION_ENABLED: 'true', COMPUTE_API_ORIGIN: 'https://compute.example.test',
      COMPUTE_SIGNING_KEY_ID: 'sign1', COMPUTE_SIGNING_PRIVATE_KEY_FILE: join(directory, 'sign.pem'), COMPUTE_ENCRYPTION_KEY_ID: 'enc1',
      COMPUTE_ENCRYPTION_PRIVATE_KEY_FILES: JSON.stringify({ enc1: join(directory, 'enc.pem') }) });
    client = new ComputeProtocolClient(config); remote = new ComputeRemoteAdapter(client);
    fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  });
  afterEach(() => fetcher.mockRestore());

  it('signs the exact raw bytes, ordered query and all 14 fields with fresh nonce on each retry', async () => {
    const options = { method: 'POST' as const, enterpriseId: 'ent1', executionId: 'exec1', apiKey: 'sk-fixture-chat',
      idempotencyKey: 'same1', quoteId: 'quote1', videoOperation: 'text-to-video', body: { text: '中文', n: 1 } };
    await client.request('/v1/videos?b=%2F&a=1', options); await client.request('/v1/videos?b=%2F&a=1', options);
    const [url, init] = fetcher.mock.calls[0], headers = new Headers(init.headers);
    expect(String(url)).toBe('https://compute.example.test/v1/videos?b=%2F&a=1');
    const canonical = ['sep-v1', 'sign1', headers.get('X-SEP-Timestamp'), headers.get('X-SEP-Nonce'), 'POST', '/v1/videos?b=%2F&a=1',
      hash(Buffer.from(init.body)), hash('Bearer sk-fixture-chat'), 'ent1', 'exec1', 'same1', 'application/json', 'quote1', 'text-to-video'].join('\n');
    expect(verify(null, Buffer.from(canonical), signing.publicKey, Buffer.from(headers.get('X-SEP-Signature')!, 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from(canonical.replace('quote1', 'other')), signing.publicKey, Buffer.from(headers.get('X-SEP-Signature')!, 'base64url'))).toBe(false);
    expect(headers.get('X-SEP-Nonce')).not.toBe(new Headers(fetcher.mock.calls[1][1].headers).get('X-SEP-Nonce'));
    expect(fetcher.mock.calls[1][1].body).toEqual(init.body); expect(init.redirect).toBe('error');
  });

  it('allows HTTP only for explicit nonproduction loopback and rejects redirected paths', async () => {
    expect(() => client.validateAddress('http://127.0.0.1:28080')).toThrow();
    config.set('COMPUTE_ALLOW_LOOPBACK_HTTP', 'true'); expect(client.validateAddress('http://127.0.0.1:28080').hostname).toBe('127.0.0.1');
    expect(() => client.validateAddress('http://10.0.0.1:28080')).toThrow(); config.set('NODE_ENV', 'production');
    expect(() => client.validateAddress('http://127.0.0.1:28080')).toThrow();
    await expect(client.request('//other.test/path')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains async media correlation and signs video-to-video creation and PUT cancellation', async () => {
    const identity = { enterpriseId: 'ent1', executionId: 'exec1', quoteId: 'quote1', apiKey: 'enterprise-video-key' };
    await client.fetchSigned('https://compute.example.test/v1/videos', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Request-ID': 'sep-video-1',
        'Idempotency-Key': 'sep-video-1', 'X-Video-Pricing-Version': 'quote1', 'X-Video-Operation': 'video-to-video' },
      body: JSON.stringify({ model: 'seedance', metadata: { content: [] } }),
    }, identity);
    const create = new Headers(fetcher.mock.calls[0][1].headers);
    expect(create.get('X-Client-Request-ID')).toBe('sep-video-1');
    expect(create.get('Idempotency-Key')).toBe('sep-video-1');
    expect(create.get('X-Video-Pricing-Version')).toBe('quote1');
    expect(create.get('X-Video-Operation')).toBe('video-to-video');
    await client.fetchSigned('https://compute.example.test/v1/videos/task1/cancel', { method: 'PUT' }, identity);
    const [, init] = fetcher.mock.calls[1], headers = new Headers(init.headers);
    const canonical = ['sep-v1', 'sign1', headers.get('X-SEP-Timestamp'), headers.get('X-SEP-Nonce'), 'PUT', '/v1/videos/task1/cancel',
      hash(Buffer.alloc(0)), hash('Bearer enterprise-video-key'), 'ent1', 'exec1', '', '', 'quote1', ''].join('\n');
    expect(init.method).toBe('PUT');
    expect(verify(null, Buffer.from(canonical), signing.publicKey, Buffer.from(headers.get('X-SEP-Signature')!, 'base64url'))).toBe(true);
  });

  it('signs the exact serialized multipart boundary and binary bytes without recreating the form', async () => {
    const form = new FormData();
    form.append('prompt', '中文 reference');
    form.append('input_reference', new Blob([new Uint8Array([0, 1, 254, 255])], { type: 'image/png' }), 'reference.png');
    await client.fetchSigned('https://compute.example.test/v1/videos', { method: 'POST', body: form,
      headers: { 'X-Video-Operation': 'image-to-video' } }, { enterpriseId: 'ent1', executionId: 'exec1', quoteId: 'quote1', apiKey: 'sk-fixture-video' });
    const [, init] = fetcher.mock.calls[0], headers = new Headers(init.headers), contentType = headers.get('Content-Type');
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const canonical = ['sep-v1', 'sign1', headers.get('X-SEP-Timestamp'), headers.get('X-SEP-Nonce'), 'POST', '/v1/videos',
      hash(Buffer.from(init.body)), hash('Bearer sk-fixture-video'), 'ent1', 'exec1', '', contentType, 'quote1', 'image-to-video'].join('\n');
    expect(verify(null, Buffer.from(canonical), signing.publicKey, Buffer.from(headers.get('X-SEP-Signature')!, 'base64url'))).toBe(true);
    const decoded = await new Response(init.body, { headers: { 'Content-Type': contentType } }).formData();
    expect(decoded.get('prompt')).toBe('中文 reference');
    expect(Buffer.from(await (decoded.get('input_reference') as Blob).arrayBuffer())).toEqual(Buffer.from([0, 1, 254, 255]));
  });

  it('decrypts standard JWE but rejects wrong versions, algorithms, tag tampering and foreign identity', async () => {
    expect(client.decryptCredential(jwe({ test: true }), 'enc1')).toEqual({ test: true });
    for (const value of [jwe({ test: true }, { alg: 'RSA1_5' }), jwe({ test: true }, { kid: 'other' }), jwe({ test: true }).slice(0, -3) + 'aaa']) {
      expect(() => client.decryptCredential(value, 'enc1')).toThrow('JWE');
    }
    fetcher.mockResolvedValue(new Response(JSON.stringify(registration(true))));
    await expect(remote.provision({ enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Company', adminEmail: 'admin@example.test', passwordHash })).rejects.toThrow('不匹配');
  });

  it('maps complete N01 credentials only after verifying every envelope and ownership', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(registration())));
    const result = await remote.provision({ enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Company', adminEmail: 'admin@example.test', passwordHash });
    expect(result.remoteAccountId).toBe('123'); expect(result.credentials).toHaveLength(3);
    expect(result.credentials[0]).toMatchObject({ kind: 'chat', apiKey: 'sk-fixture-chat' });
    expect(JSON.parse(Buffer.from(fetcher.mock.calls[0][1].body).toString())).toMatchObject({ encryption_key_id: 'enc1', registration_ref: 'reg1', password_hash: passwordHash });
  });

  it('replays identical N01 hash and body with a new signature nonce', async () => {
    fetcher.mockImplementation(async () => new Response(JSON.stringify(registration())));
    const input = { enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Company', adminEmail: 'admin@example.test', passwordHash };
    await remote.provision(input); await remote.provision(input);
    const first = fetcher.mock.calls[0][1], second = fetcher.mock.calls[1][1];
    expect(first.body).toEqual(second.body);
    expect(new Headers(first.headers).get('Idempotency-Key')).toBe('reg1');
    expect(new Headers(first.headers).get('X-SEP-Nonce')).not.toBe(new Headers(second.headers).get('X-SEP-Nonce'));
    expect(new Headers(first.headers).get('X-SEP-Signature')).not.toBe(new Headers(second.headers).get('X-SEP-Signature'));
  });

  it.each(['plain-password', '$2b$03$' + 'a'.repeat(53), '$2b$32$' + 'a'.repeat(53)])('rejects an invalid registration hash without sending it', async invalid => {
    await expect(remote.provision({ enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Company',
      adminEmail: 'admin@example.test', passwordHash: invalid })).rejects.toMatchObject({ response: { code: 'INVALID_PASSWORD_HASH' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts N01 hash echoed in an upstream error without losing its code or request ID', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INVALID_PASSWORD_HASH', password_hash: passwordHash,
      message: `Rejected ${passwordHash}` }, request_id: 'req-registration' }), { status: 400, headers: { 'X-Request-ID': 'req-registration' } }));
    try {
      await remote.provision({ enterpriseId: 'ent1', registrationRef: 'reg1', companyName: 'Company', adminEmail: 'admin@example.test', passwordHash });
      throw new Error('expected failure');
    } catch (error: any) {
      expect(error.getResponse()).toMatchObject({ error: { code: 'INVALID_PASSWORD_HASH', message: 'Rejected [REDACTED]', password_hash: '[REDACTED]' }, request_id: 'req-registration' });
      expect(JSON.stringify(error.getResponse())).not.toContain(passwordHash);
    }
  });

  it('preserves precise upstream diagnostics and redacts only key material', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'KEY_PURPOSE_MISMATCH', message: 'wrong purpose for sk-fixture-chat' } }), { status: 403 }));
    try { await client.request('/v1/models', { enterpriseId: 'ent1', apiKey: 'sk-fixture-chat' }); throw new Error('expected failure'); }
    catch (error: any) { expect(error.getStatus()).toBe(403); expect(JSON.stringify(error.getResponse())).toContain('KEY_PURPOSE_MISMATCH'); expect(JSON.stringify(error.getResponse())).not.toContain('sk-fixture-chat'); }
  });

  it('treats 200 rejected as a durable refusal rather than a committed transfer', async () => {
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/enterprises/ent1')
      ? { ...account, credentials: registration().credentials.map(({ encrypted_key: _key, ...metadata }) => metadata) }
      : { contract_version: 1, enterprise_id: 'ent1', transfer_id: 't1', direction: 'debit_compute', currency: 'CNY', amount_cny: '1.000000',
        funding_ref: 'fund1', status: 'rejected', reason: 'INSUFFICIENT_PAID_FUNDS', sequence: '0', committed_at: new Date().toISOString() })));
    await expect(remote.transfer({ enterpriseId: 'ent1', businessId: 't1', remoteAccountId: '123', direction: 'debit_compute', currency: 'CNY', amountCny: '1.000000', fundingRef: 'fund1' }))
      .rejects.toMatchObject({ response: { code: 'COMPUTE_TRANSFER_REJECTED' } });
  });

  it('refuses a foreign remote account before sending any money request', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...account, credentials: registration().credentials.map(({ encrypted_key: _key, ...metadata }) => metadata) })));
    await expect(remote.transfer({ enterpriseId: 'ent1', businessId: 't1', remoteAccountId: '999', direction: 'credit_compute', currency: 'CNY', amountCny: '1.000000', fundingRef: 'fund1' })).rejects.toThrow('账号');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aligns local business ids and decimal capacity with the wire contract', () => {
    expect(ComputeIntegrationIdSchema.safeParse('enterprise.v1:abc-123').success).toBe(true);
    expect(ComputeIntegrationMoneySchema.safeParse('999999999999999999.999999').success).toBe(true);
    for (const invalid of ['1e6', '01.000000', '-1.000000', '1000000000000000000.000000']) expect(ComputeIntegrationMoneySchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects lexicographic ledger ordering at two digits instead of silently skipping financial entries', async () => {
    const order = ['1', '10', '11', '2', '3', '4', '5', '6', '7', '8', '9'];
    fetcher.mockResolvedValue(new Response(JSON.stringify({ enterprise_id: 'ent1', currency: 'CNY', after_sequence: '9', snapshot_sequence: '11', has_more: true,
      total_paid_cny: '11.000000', available_paid_cny: '11.000000', frozen_paid_cny: '0.000000', items: order.map(sequence => ({
        enterprise_id: 'ent1', ledger_entry_id: `ledger${sequence}`, sequence, type: 'credit_compute', currency: 'CNY',
        amount_cny: '1.000000', free_cny: '0.000000', transfer_id: `transfer${sequence}`, execution_id: '', settlement_id: '', effective_at: new Date().toISOString(),
      })) })));
    await expect(remote.ledger('ent1')).rejects.toMatchObject({ response: { code: 'COMPUTE_LEDGER_ORDER_INVALID', previousSequence: '11', entrySequence: '2' } });
  });
});
