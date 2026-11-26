import { ExecutionContext, HttpException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import request from 'supertest';
import { Readable } from 'node:stream';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { requestContextMiddleware } from '../../common/middleware/request-context.middleware';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { MediaRealBillingService } from './media-real-billing.service';
import { MediaVideoRealController } from './media-video-real.controller';
import { MediaVideoRealGuard } from './media-video-real.guard';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { fingerprint, input, outputMetadata, scope, videoBytes, videoClaims, videoRealPrisma } from './media-video-real.test-support';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { videoGatewayError } from './media-video-gateway.store';
import { VideoReferenceUploadService } from './video-reference-upload.service';

const root = '/api/gateway/v1/media/video-real';
describe('real video controller and guard HTTP', () => {
  let app: INestApplication;
  const media = { assertRealEnabled: jest.fn(), profiles: jest.fn(), reference: jest.fn(), quote: jest.fn(),
    submit: jest.fn(), findByClientId: jest.fn(), receipt: jest.fn(), content: jest.fn(), cancel: jest.fn() };
  const get = (path: string) => request(app.getHttpServer()).get(root + path).set('Authorization', 'Bearer employment');
  const post = (path: string) => request(app.getHttpServer()).post(root + path).set('Authorization', 'Bearer employment');
  const disabled = () => { throw new HttpException({ error: { code: 'MEDIA_REAL_DISABLED' } }, 503); };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [MediaVideoRealController],
      providers: [MediaVideoRealGuard, { provide: MediaVideoRealService, useValue: media }, { provide: VideoReferenceUploadService, useValue: {} }],
    }).overrideGuard(ClientEmploymentGuard).useValue({ canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      if (req.headers.authorization !== 'Bearer employment') throw new UnauthorizedException();
      req.clientEmployment = videoClaims; return true;
    } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.use(requestContextMiddleware);
    app.useGlobalFilters(new HttpExceptionFilter()); await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    for (const fn of Object.values(media)) fn.mockReset();
    media.profiles.mockResolvedValue({ mock: false, profiles: [] });
    media.quote.mockResolvedValue({ mock: false, quoteId: 'quote-1' });
    media.reference.mockResolvedValue({ mock: false, referenceId: 'reference-1' });
    media.submit.mockResolvedValue({ mock: false, status: 'QUEUED', receiptId: 'receipt-1' });
    media.receipt.mockResolvedValue({ mock: false, status: 'RUNNING', receiptId: 'receipt-1' });
    media.findByClientId.mockResolvedValue({ mock: false, status: 'SUBMISSION_UNKNOWN', receiptId: 'receipt-1' });
    media.content.mockImplementation(async () => ({ output: outputMetadata, stream: Readable.from(videoBytes) }));
    media.cancel.mockImplementation(() => { throw new HttpException({ error: { code: 'CANCEL_UNSUPPORTED' } }, 409); });
  });
  afterAll(async () => { await app?.close(); });

  it('requires employment authentication before execution gate or service', async () => {
    await request(app.getHttpServer()).get(root + '/profiles').expect(401);
    expect(media.profiles).not.toHaveBeenCalled(); expect(media.assertRealEnabled).not.toHaveBeenCalled();
  });

  it('gates new profiles, quotes and reference buffering before DTO parsing', async () => {
    media.assertRealEnabled.mockImplementation(disabled);
    await get('/profiles').expect(503);
    await post('/quotes').send({ invalid: true }).expect(503);
    await post('/references').attach('file', MEDIA_MOCK_PNG, { filename: 'reference.png', contentType: 'image/png' }).expect(503);
    expect(media.quote).not.toHaveBeenCalled(); expect(media.reference).not.toHaveBeenCalled();
  });

  it('leaves queries, original downloads and replay accessible when new execution is disabled', async () => {
    media.assertRealEnabled.mockImplementation(disabled);
    await get('/requests/by-client-id/client-1').expect(200);
    await get('/requests/receipt-1').expect(200);
    await get('/requests/receipt-1/outputs/output-1/content').expect(200);
    await post('/requests').send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(202);
    expect(media.assertRealEnabled).not.toHaveBeenCalled();
    expect(media.submit).toHaveBeenCalledWith(videoClaims, expect.objectContaining({ clientRequestId: 'client-1' }));
  });

  it('parses strict quote and request DTOs and refuses extra fields', async () => {
    await post('/quotes').send({ ...input, creativeBrief: '  brief  ' }).expect(201);
    expect(media.quote).toHaveBeenCalledWith(videoClaims, { ...input, creativeBrief: 'brief' });
    media.quote.mockClear();
    await post('/quotes').send({ ...input, mock: false }).expect(400);
    await post('/requests').send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1', upstreamTaskId: 'evil' }).expect(400);
    expect(media.quote).not.toHaveBeenCalled(); expect(media.submit).not.toHaveBeenCalled();
  });

  it('returns 202 for pending and 200 for completed original requests', async () => {
    await post('/requests').send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(202);
    media.submit.mockResolvedValue({ mock: false, status: 'SUCCEEDED' });
    await post('/requests').send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(200);
  });

  it.each([
    [402, 'VIDEO_BUDGET_EXCEEDED', 'Video budget exceeded'],
    [403, 'MEDIA_FORBIDDEN', 'Video access revoked'],
    [409, 'QUOTE_EXPIRED', 'Video quote expired'],
  ] as const)('preserves platform error %s/%s through the real filter', async (status, code, message) => {
    media.submit.mockImplementation(() => videoGatewayError(status, code, message));
    const requestId = `video-http-${code}`;
    const response = await post('/requests').set('X-Request-ID', requestId)
      .send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(status);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toMatchObject({ statusCode: status, message, requestId,
      error: { code, message, source: 'platform', requestId, type: 'invalid_request_error', param: null } });
  });

  it.each([
    [402, 'INSUFFICIENT_FUNDS', 'Insufficient funds'],
    [409, 'INVALID_PARAMETER', 'Invalid media billing parameter'],
    [409, 'IDEMPOTENCY_CONFLICT', 'Media billing request conflicts with the original reservation'],
    [409, 'BILLING_PENDING', 'Media billing is pending; query the original request'],
  ] as const)('normalizes actual billing error %s/%s without private details', async (status, code, message) => {
    const privateDetail = 'private-reservation-metadata';
    const prior = code === 'IDEMPOTENCY_CONFLICT' ? { enterpriseId: privateDetail }
      : code === 'BILLING_PENDING' ? { ...videoClaims, enterpriseId: videoClaims.enterpriseId,
        userId: videoClaims.sub, subscriptionId: videoClaims.subscriptionId,
        reservedCny: { equals: () => true }, usdToCnyRate: { equals: () => true }, status: 'RELEASED' }
      : null;
    const tx = {
      $queryRaw: jest.fn(async () => [{ id: videoClaims.sub, status: 'ACTIVE' }]),
      mediaRealBillingReservation: { findUnique: jest.fn(async () => prior), create: jest.fn() },
      subscriptionCredit: { findUnique: jest.fn(async () => null) },
      memberComputeAllowance: { findUnique: jest.fn(async () => null) },
      memberAllowanceTopUp: { findMany: jest.fn(async () => []) },
      personalWallet: { findUnique: jest.fn(async () => null), updateMany: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (work: (value: typeof tx) => unknown) => work(tx)) };
    const billing = new MediaRealBillingService(prisma as never);
    media.submit.mockImplementation(() => billing.reserve(videoClaims, privateDetail, '1.000000',
      code === 'INVALID_PARAMETER' ? Number.NaN : 7));
    const requestId = `billing-http-${code}`;
    const response = await post('/requests').set('X-Request-ID', requestId)
      .send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(status);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toMatchObject({ statusCode: status, message, requestId,
      error: { code, message, source: 'platform', requestId, type: 'invalid_request_error', param: null } });
    expect(JSON.stringify(response.body)).not.toContain(privateDetail);
    expect(tx.mediaRealBillingReservation.create).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
  });

  it('assigns a request ID and does not relabel an upstream error as a platform rejection', async () => {
    media.submit.mockImplementation(() => { throw new HttpException({ error: {
      code: 'INSUFFICIENT_FUNDS', source: 'upstream', message: 'Upstream rejected the request', requestId: 'upstream-id',
    } }, 402); });
    const response = await post('/requests')
      .send({ ...input, quoteId: 'quote-1', clientRequestId: 'client-1' }).expect(402);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(response.body).toMatchObject({ requestId,
      error: { code: 'INSUFFICIENT_FUNDS', source: 'upstream', requestId: 'upstream-id' } });
    expect(requestId).not.toBe('upstream-id');
  });

  it.each([
    [402, 'INSUFFICIENT_FUNDS'],
    [409, 'QUOTE_EXPIRED'],
    [403, 'MEDIA_FORBIDDEN'],
  ] as const)('rejects actual submit %s/%s before dispatch with the audited persistence contract', async (status, code) => {
    const db = videoRealPrisma();
    const store = new MediaVideoRealStore(db as never);
    const tx = {
      $queryRaw: jest.fn(async () => [{ id: videoClaims.sub, status: 'ACTIVE' }]),
      mediaRealBillingReservation: { findUnique: jest.fn(async () => null), create: jest.fn() },
      subscriptionCredit: { findUnique: jest.fn(async () => null) },
      memberComputeAllowance: { findUnique: jest.fn(async () => null) },
      memberAllowanceTopUp: { findMany: jest.fn(async () => []) },
      personalWallet: { findUnique: jest.fn().mockResolvedValue({ id: 'test-wallet', balance: new Decimal(10) }), updateMany: jest.fn() },
    };
    const billing = new MediaRealBillingService({ $transaction: async work => work(tx) } as never);
    const reserve = jest.spyOn(billing, 'reserve');
    const adapter = {
      connection: jest.fn(async () => ({ fingerprint })),
      pricing: jest.fn(async () => ({ model: 'minimax-h3', operation: input.operation, resolution: '720p',
        duration_seconds: 4, pricing_status: 'quoted', amount_usd: '0.2', pricing_version: 'pricing-1',
        expires_at: new Date(Date.now() + 60_000).toISOString() })),
      submit: jest.fn(), query: jest.fn(), usage: jest.fn(),
    };
    const runtime = { getRuntimeVideo: async () => ({ executionAvailable: true, executionMode: 'real',
      profiles: [{ ...input, operations: ['text-to-video', 'image-to-video'] }] }) };
    const service = new MediaVideoRealService({ get: () => 'true' } as never, db as never,
      { getEffectiveValue: async () => '7' } as never, runtime as never, adapter as never, {} as never, billing, store);
    media.quote.mockImplementation(service.quote.bind(service));
    media.submit.mockImplementation(service.submit.bind(service));
    media.findByClientId.mockImplementation(service.findByClientId.bind(service));
    const quoteResponse = await post('/quotes').send(input).expect(201);
    const quoteId = quoteResponse.body.quoteId;
    expect(quoteResponse.body.funding.personalCny).toBe('1.400000');
    if (code === 'INSUFFICIENT_FUNDS') tx.personalWallet.findUnique.mockResolvedValue(null);
    if (code === 'MEDIA_FORBIDDEN') db.state.enterprise.mediaPolicy.video.enabledProfileIds = [];
    if (code === 'QUOTE_EXPIRED') {
      const quote = db.state.quotes.get(quoteId);
      quote.expiresAt = new Date(Date.now() - 1000);
      quote.metadata.value.expiresAt = quote.expiresAt.toISOString();
    }
    const requestId = `actual-submit-${code}`;
    const response = await post('/requests').set('X-Request-ID', requestId)
      .send({ ...input, quoteId, clientRequestId: 'rejected-request' }).expect(code === 'INSUFFICIENT_FUNDS' ? 200 : status);
    expect(response.headers['x-request-id']).toBe(requestId);
    if (code === 'INSUFFICIENT_FUNDS') {
      expect(response.body).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_RESERVED', billingError: { status: 402,
        body: { error: { code } } }, clientActions: { canStartNewRequest: true, shouldPoll: false } });
    } else {
      expect(response.body).toMatchObject({ statusCode: status, requestId,
        error: { code, source: 'platform', requestId, type: 'invalid_request_error', param: null } });
      expect(typeof response.body.message).toBe('string');
      expect(response.body.error.message).toBe(response.body.message);
    }
    expect(JSON.stringify(response.body)).not.toContain(input.creativeBrief);
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.usage).not.toHaveBeenCalled();
    expect(adapter.pricing).toHaveBeenCalledTimes(1);
    expect(tx.mediaRealBillingReservation.create).not.toHaveBeenCalled();
    expect(tx.personalWallet.updateMany).not.toHaveBeenCalled();
    const quote = await store.findQuote(scope, quoteId);
    if (code === 'INSUFFICIENT_FUNDS') {
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(quote?.consumedByClientRequestId).toBe('rejected-request');
      const receipt = await get('/requests/by-client-id/rejected-request').expect(200);
      expect(receipt.body).toMatchObject({ status: 'FAILED', errorCode: code, billingStatus: 'NOT_RESERVED', outputs: [] });
      expect(db.state.requests.size).toBe(1);
    } else {
      expect(reserve).not.toHaveBeenCalled();
      expect(quote?.consumedByClientRequestId).toBeNull();
      expect(await store.findByClientId(videoClaims.enterpriseId, 'rejected-request', scope)).toBeNull();
      expect(db.state.requests.size).toBe(0);
    }
  });

  it('applies the 10MiB upload cap and rejects additional multipart fields', async () => {
    await post('/references').attach('file', MEDIA_MOCK_PNG, { filename: 'reference.png', contentType: 'image/png' }).expect(201);
    expect(media.reference).toHaveBeenCalledWith(videoClaims, expect.objectContaining({ mimetype: 'image/png', buffer: MEDIA_MOCK_PNG }), expect.anything());
    media.reference.mockClear();
    await post('/references').attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), 'large.png').expect(413);
    await post('/references').field('supplier', 'not-accepted').attach('file', MEDIA_MOCK_PNG, 'ref.png').expect(400);
    expect(media.reference).not.toHaveBeenCalled();
  });

  it('returns actual content hash and non-mock no-store headers', async () => {
    const response = await get('/requests/receipt-1/outputs/output-1/content').expect(200);
    expect(response.headers).toMatchObject({ 'content-type': 'video/mp4', 'x-sha256': outputMetadata.sha256,
      'content-length': String(videoBytes.length), 'x-sep-media-mock': 'false', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  });

  it('rejects unsupported cancellation and invalid IDs before reaching the service', async () => {
    await post('/requests/receipt-1/cancel').send({}).expect(409);
    expect(media.cancel).toHaveBeenCalledWith(videoClaims, 'receipt-1');
    await get('/requests/not%20valid').expect(400);
    expect(media.receipt).not.toHaveBeenCalled();
  });
});
