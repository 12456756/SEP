import { ConfigService } from '@nestjs/config';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComputeBalanceSignatureGuard } from './compute-balance-signature.guard';

describe('Compute balance webhook signatures', () => {
  const pair = generateKeyPairSync('ed25519');
  let directory: string, config: ConfigService, redis: any, guard: ComputeBalanceSignatureGuard;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'sep-event-public-'));
    writeFileSync(join(directory, 'public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  beforeEach(() => {
    config = new ConfigService({ COMPUTE_BALANCE_SYNC_ENABLED: 'true', COMPUTE_EVENT_PUBLIC_KEY_FILES: JSON.stringify({ v1: join(directory, 'public.pem') }) });
    redis = { redis: { set: jest.fn().mockResolvedValue('OK') } }; guard = new ComputeBalanceSignatureGuard(config, redis);
  });
  function request(patch: any = {}) {
    const req = { method: 'POST', originalUrl: '/api/compute-integration/balance-events?test=1', rawBody: Buffer.from('{ "a": 1 }'), ...patch };
    const headers = { 'X-Compute-Key-ID': 'v1', 'X-Compute-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Compute-Nonce': randomUUID(), ...patch.headers };
    const canonical = ['compute-balance-event-v1', headers['X-Compute-Key-ID'], headers['X-Compute-Timestamp'], headers['X-Compute-Nonce'], 'POST', req.originalUrl,
      createHash('sha256').update(req.rawBody ?? '').digest('hex')].join('\n');
    headers['X-Compute-Signature'] = sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url');
    req.get = (name: string) => headers[name];
    return { req, headers, context: { switchToHttp: () => ({ getRequest: () => req }) } as any };
  }
  it('verifies exact bytes/path and claims a nonce only after verification', async () => {
    const { context, headers } = request(); await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.redis.set).toHaveBeenCalledWith(`compute:balance-event:nonce:v1:${headers['X-Compute-Nonce']}`, '1', 'EX', 610, 'NX');
  });
  it.each(['body', 'path', 'signature'])('rejects tampered %s before claiming the nonce', async type => {
    const { context, req, headers } = request();
    if (type === 'body') req.rawBody = Buffer.from('{"a":1}');
    if (type === 'path') req.originalUrl += '&changed=1';
    if (type === 'signature') headers['X-Compute-Signature'] = 'A'.repeat(86);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 }); expect(redis.redis.set).not.toHaveBeenCalled();
  });
  it('rejects expired signatures and untrusted key versions', async () => {
    await expect(guard.canActivate(request({ headers: { 'X-Compute-Timestamp': String(Math.floor(Date.now() / 1000) - 301) } }).context)).rejects.toMatchObject({ status: 401 });
    await expect(guard.canActivate(request({ headers: { 'X-Compute-Key-ID': 'other' } }).context)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a reused nonce but lets a new signature retry the same business event', async () => {
    redis.redis.set.mockResolvedValueOnce(null);
    await expect(guard.canActivate(request().context)).rejects.toMatchObject({ response: { code: 'COMPUTE_EVENT_REPLAYED' } });
    await expect(guard.canActivate(request().context)).resolves.toBe(true);
  });
  it('fails closed if Redis is unavailable', async () => {
    redis.redis.set.mockRejectedValue(new Error('offline'));
    await expect(guard.canActivate(request().context)).rejects.toMatchObject({ status: 503 });
  });
});
