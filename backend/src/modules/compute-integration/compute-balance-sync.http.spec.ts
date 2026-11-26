import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { RedisService } from '../../redis/redis.service';
import { createJsonBodyMiddleware } from '../../common/middleware/json-body.middleware';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ComputeBalanceSignatureGuard } from './compute-balance-signature.guard';
import { ComputeBalanceWebhookController } from './compute-balance-sync.controller';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';

describe('Signed compute balance webhook HTTP', () => {
  const pair = generateKeyPairSync('ed25519'), path = '/api/compute-integration/balance-events';
  const payload = { contract_version: 1, event_id: 'event1', enterprise_id: 'ent1', compute_account_id: 52,
    sequence: '1', origin: 'compute', type: 'compute_credit', currency: 'CNY', delta_cny: '1.000000',
    amount_cny: '1.000000', free_cny: '0.000000', available_paid_cny: '1.000000', frozen_paid_cny: '0.000000',
    business_ref: 'admin:1', transfer_id: null, execution_id: null, settlement_id: null,
    exchange_rate: null, occurred_at: '2026-11-23T01:00:00Z' };
  let directory: string, app: INestApplication;
  const service = { receive: jest.fn() }, redis = { redis: { set: jest.fn() } };
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'sep-event-http-'));
    const file = join(directory, 'public.pem'); writeFileSync(file, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const module = await Test.createTestingModule({ controllers: [ComputeBalanceWebhookController], providers: [
      ComputeBalanceSignatureGuard, { provide: ComputeBalanceSyncService, useValue: service }, { provide: RedisService, useValue: redis },
      { provide: ConfigService, useValue: new ConfigService({ COMPUTE_BALANCE_SYNC_ENABLED: 'true', COMPUTE_EVENT_PUBLIC_KEY_FILES: JSON.stringify({ v1: file }) }) },
    ] }).compile();
    app = module.createNestApplication({ bodyParser: false }); app.setGlobalPrefix('api');
    app.use(createJsonBodyMiddleware()); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  });
  afterAll(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  beforeEach(() => { service.receive.mockReset().mockResolvedValue({ event_id: 'event1', status: 'applied' }); redis.redis.set.mockReset().mockResolvedValue('OK'); });
  function headers(body: string, target = path) {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const canonical = ['compute-balance-event-v1', 'v1', timestamp, nonce, 'POST', target, createHash('sha256').update(body).digest('hex')].join('\n');
    return { 'Content-Type': 'application/json', 'X-Compute-Key-ID': 'v1', 'X-Compute-Timestamp': timestamp,
      'X-Compute-Nonce': nonce, 'X-Compute-Signature': sign(null, Buffer.from(canonical), pair.privateKey).toString('base64url'), 'Idempotency-Key': 'event1' };
  }
  it('verifies the raw escaped/pretty JSON and query without requiring a user token', async () => {
    const body = JSON.stringify(payload, null, 2), target = path + '?channel=compute';
    const response = await request(app.getHttpServer()).post(target).set(headers(body, target)).send(body).expect(200);
    expect(response.body).toEqual({ event_id: 'event1', status: 'applied' }); expect(service.receive).toHaveBeenCalledWith(payload);
  });
  it('does not acknowledge receipt while local accounting fails', async () => {
    const { ConflictException } = await import('@nestjs/common');
    service.receive.mockRejectedValue(new ConflictException({ code: 'COMPUTE_PUBLIC_FUNDS_INSUFFICIENT', message: 'public funds insufficient' }));
    const body = JSON.stringify(payload);
    await request(app.getHttpServer()).post(path).set(headers(body)).send(body).expect(409);
  });
  it('rejects idempotency mismatches and malformed amounts before accounting', async () => {
    let body = JSON.stringify(payload);
    await request(app.getHttpServer()).post(path).set({ ...headers(body), 'Idempotency-Key': 'other' }).send(body).expect(400);
    body = JSON.stringify({ ...payload, delta_cny: '-1.000000' });
    await request(app.getHttpServer()).post(path).set(headers(body)).send(body).expect(400);
    expect(service.receive).not.toHaveBeenCalled();
  });
  it('rejects missing signatures and bounds raw event size', async () => {
    await request(app.getHttpServer()).post(path).send(payload).expect(401);
    const body = JSON.stringify({ ...payload, business_ref: 'a'.repeat(66000) });
    await request(app.getHttpServer()).post(path).set(headers(body)).send(body).expect(413);
    expect(service.receive).not.toHaveBeenCalled();
  });
});
