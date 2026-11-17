import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { MediaByteCacheService } from './media-byte-cache.service';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { MediaRealController } from './media-real.controller';
import { MediaRealGuard } from './media-real.guard';
import { MediaRealService } from './media-real.service';
import { MediaRealStore } from './media-real.store';
import { videoClaims } from './media-video-real.test-support';
import { Sub2apiImageAdapter } from './sub2api-image.adapter';

const prefix = '/api/gateway/v1/media/real';
const profileId = 'image.future';
const modelId = 'future-image-native';
const configVersion = 'cfg:future-image';
const input = { protocolVersion: 3, specRevision: 1, profileId, configVersion, operation: 'generate',
  referenceIds: [], creativeBrief: 'Synthetic test image', requestedSpec: { width: 1, height: 1, count: 2, quality: 'studio' },
  parameterSources: { width: 'model', height: 'model', quality: 'user', count: 'user' } };

describe('V3 image HTTP with production adapter, store and cache and fake upstream', () => {
  let app: INestApplication;
  let fetchSpy: jest.SpyInstance;
  let pricingVersion = 'price-initial';
  const dispatches: Record<string, unknown>[] = [];
  const usageCounts = new Map<string, number>();
  const reservations = new Map<string, string>();
  const editedReferences: string[][] = [];
  const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value),
    { headers: { 'Content-Type': 'application/json', ...headers } });

  beforeAll(async () => {
    const quotes = new Map<string, any>();
    const requests = new Map<string, any>();
    const references = new Map<string, any>();
    const bytes = new Map<string, Buffer>();
    let sequence = 0;
    const copy = <T>(value: T): T => structuredClone(value);
    const prisma = {
      enterpriseMember: { findFirst: async () => ({ departmentId: null }) },
      subscription: { findFirst: async () => ({ id: videoClaims.subscriptionId }) },
      mediaModelProfile: { findUnique: async () => ({ profileId, configVersion, modelId, kind: 'image', enabled: true, verified: true,
        capabilities: { supportsReferenceImage: true, maxReferenceCount: 8, maxOutputs: 4, sizes: ['1x1'], qualities: ['medium'] } }) },
      mediaRealReference: {
        create: async ({ data }) => {
          const row = { ...copy(data), id: 'reference-' + ++sequence }; references.set(row.id, row); return copy(row);
        },
        findUnique: async ({ where }) => copy(references.get(where.id) ?? null),
      },
      mediaRealQuote: {
        create: async ({ data }) => {
          const row = { ...copy(data), id: 'quote-' + ++sequence }; quotes.set(row.id, row); return copy(row);
        },
        findUnique: async ({ where }) => copy(quotes.get(where.id) ?? null),
      },
      mediaRealRequest: {
        create: async ({ data }) => {
          const row = { ...copy(data), id: 'receipt-' + ++sequence, revision: 0 }; requests.set(row.id, row); return copy(row);
        },
        findUnique: async ({ where }) => copy(where.id ? requests.get(where.id) ?? null
          : [...requests.values()].find(row => row.enterpriseId === where.enterpriseId_clientRequestId.enterpriseId
            && row.clientRequestId === where.enterpriseId_clientRequestId.clientRequestId) ?? null),
        updateMany: async ({ where, data }) => {
          const row = requests.get(where.id);
          if (!row || row.revision !== where.revision) return { count: 0 };
          requests.set(row.id, { ...row, ...copy(data), revision: row.revision + data.revision.increment }); return { count: 1 };
        },
      },
    };
    const settings = { getMediaConnection: async () => ({ baseUrl: 'https://image-upstream.invalid/v1', apiKey: 'synthetic-key' }),
      getEffectiveValue: async () => '7' };
    const runtimeProfile = { profileId, configVersion, kind: 'image', executionMode: 'sync-response', operations: ['generate', 'edit'],
      authorized: true, adapter: { available: true, operations: ['generate', 'edit'] }, parameters: {}, constraints: [], referenceRules: [] };
    const mediaConfig = { getConnection: async () => ({ configured: true }),
      getRuntimeMediaV3: async () => ({ protocolVersion: 3, executionAvailable: true, executionMode: 'real', profiles: [runtimeProfile] }) };
    const cache = new MediaByteCacheService({ redis: {
      set: async (key: string, value: Buffer) => { if (!bytes.has(key)) bytes.set(key, Buffer.from(value)); },
      getBuffer: async (key: string) => bytes.get(key) ?? null,
    } } as never);
    const billing = { quoteFunding: async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' }),
      reserve: async (_claims: unknown, id: string) => { reservations.set(id, 'RESERVED'); },
      status: async (id: string) => reservations.get(id) ?? 'RESERVED',
      release: async (id: string) => { reservations.set(id, 'RELEASED'); },
      settleNegotiated: async (id: string, cny: string, usd: string, actualModel: string, frozenModel: string) => {
        expect(cny).toBe('0.700000'); expect(usd).toBe('0.100000');
        expect(actualModel).toBe(modelId); expect(frozenModel).toBe(modelId);
        reservations.set(id, 'SETTLED'); return 'SETTLED';
      } };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (target, options) => {
      const url = new URL(String(target));
      if (url.origin !== 'https://image-upstream.invalid') throw new Error('Unexpected upstream destination');
      if (url.pathname === '/v1/sub2api/images/pricing') return json({ object: 'sub2api.image_pricing', schema_version: 1,
        currency: 'USD', ...JSON.parse(String(options?.body)), billing_mode: 'image', pricing_status: 'quoted',
        pricing_source: 'group', pricing_authority: 'sub2api_customer_billing', amount_usd: '0.2', pricing_version: pricingVersion,
        effective_rate_multiplier: 1, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
      if (url.pathname === '/v1/images/generations') {
        const fields = JSON.parse(String(options?.body)); dispatches.push(fields);
        const requestId = 'image-' + dispatches.length; usageCounts.set('client:' + requestId, fields.n);
        return json({ model: modelId, data: Array.from({ length: fields.n }, () => ({ b64_json: MEDIA_MOCK_PNG.toString('base64') })) },
          { 'x-client-request-id': requestId });
      }
      if (url.pathname === '/v1/images/edits') {
        const form = options!.body as FormData;
        const files = form.getAll('image[]') as File[];
        editedReferences.push(files.map(file => file.name));
        for (const file of files) expect(Buffer.from(await file.arrayBuffer())).toEqual(MEDIA_MOCK_PNG);
        usageCounts.set('client:image-multi-edit', Number(form.get('n')));
        return json({ model: modelId, data: [{ b64_json: MEDIA_MOCK_PNG.toString('base64') }] },
          { 'x-client-request-id': 'image-multi-edit' });
      }
      if (url.pathname === '/v1/sub2api/usage') return json({ object: 'sub2api.request_usage', schema_version: 1, currency: 'USD',
        request_id: url.searchParams.get('request_id'), status: 'settled', model: modelId, actual_cost_usd: '0.1',
        image_count: usageCounts.get(url.searchParams.get('request_id')!) });
      throw new Error('Unexpected fake upstream path: ' + url.pathname);
    });
    const adapter = new Sub2apiImageAdapter(settings as never);
    const service = new MediaRealService({ get: () => 'true' } as never, prisma as never, settings as never,
      mediaConfig as never, adapter, cache, billing as never, new MediaRealStore(prisma as never));
    const module = await Test.createTestingModule({ controllers: [MediaRealController], providers: [MediaRealGuard,
      { provide: MediaRealService, useValue: service }] }).overrideGuard(ClientEmploymentGuard).useValue({
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        if (req.headers['x-test-auth'] !== 'yes') throw new UnauthorizedException();
        req.clientEmployment = videoClaims; return true;
      },
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  });
  afterAll(async () => { fetchSpy?.mockRestore(); await app?.close(); });
  const post = (path: string, value: object) => request(app.getHttpServer()).post(prefix + path).set('x-test-auth', 'yes').send(value);
  const get = (path: string) => request(app.getHttpServer()).get(prefix + path).set('x-test-auth', 'yes');

  it('returns the original upstream pricing status and body through the HTTP filter', async () => {
    const original = { error: { code: 'permission_error', message: 'Image group is disabled', detail: { model: modelId } } };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(original), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    const failed = await post('/quotes', input).expect(403);
    expect(failed.body).toEqual(original);
    expect(failed.headers['x-sep-error-source']).toBe('upstream');
  });

  it('uploads eight references and preserves their order through quote, store and one upstream edit', async () => {
    const referenceIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const uploaded = await request(app.getHttpServer()).post(prefix + '/references').set('x-test-auth', 'yes')
        .attach('file', MEDIA_MOCK_PNG, { filename: `view-${i}.png`, contentType: 'image/png' }).expect(201);
      referenceIds.push(uploaded.body.referenceId);
    }
    const edit = { ...input, operation: 'edit', referenceIds, requestedSpec: { ...input.requestedSpec, count: 1 } };
    const quote = await post('/quotes', edit).expect(201);
    const submission = { ...edit, quoteId: quote.body.quoteId, clientRequestId: 'multi-reference-http' };
    await post('/requests', submission).expect(200).expect(result => {
      expect(result.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED' });
    });
    await post('/requests', submission).expect(200);
    expect(editedReferences).toEqual([Array.from({ length: 8 }, (_, i) => `reference-${i}.png`)]);
  });

  it('preserves a new model, dot profile ID, custom quality and count through settlement and download', async () => {
    const quote = await post('/quotes', input).expect(response => expect(response.body.error).toBeUndefined()).expect(201);
    expect(quote.body.effectiveSpec).toMatchObject({ size: '1x1', count: 2, quality: 'studio' });
    const submitted = await post('/requests', { ...input, quoteId: quote.body.quoteId, clientRequestId: 'image-v3' })
      .expect(response => expect(response.body.error).toBeUndefined()).expect(200);
    expect(submitted.body).toMatchObject({ protocolVersion: 3, profileId, configVersion, status: 'SUCCEEDED', billingStatus: 'SETTLED',
      actualSpec: { size: '1x1', count: 2 }, acceptance: { status: 'unknown', unknownFields: ['quality'] } });
    expect(dispatches.at(-1)).toMatchObject({ model: modelId, size: '1x1', n: 2, quality: 'studio' });
    const download = await get('/requests/' + submitted.body.receiptId + '/outputs/' + submitted.body.outputs[0].outputId + '/content').expect(200);
    expect(download.body).toEqual(MEDIA_MOCK_PNG);
    const count = dispatches.length;
    await post('/requests', { ...input, quoteId: quote.body.quoteId, clientRequestId: 'image-v3' }).expect(200);
    expect(dispatches).toHaveLength(count);
    await post('/requests', { ...input, specRevision: 2, quoteId: quote.body.quoteId, clientRequestId: 'image-v3' }).expect(409);
  });

  it('retains mismatched safe originals and settles independently of requested dimensions', async () => {
    const value = { ...input, requestedSpec: { ...input.requestedSpec, width: 2, height: 2 } };
    const quote = await post('/quotes', value).expect(201);
    const result = await post('/requests', { ...value, quoteId: quote.body.quoteId, clientRequestId: 'image-mismatch' }).expect(200);
    expect(result.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', actualSpec: { size: '1x1' },
      acceptance: { status: 'mismatched', mismatchedFields: ['size'] }, recovery: { canDownload: true } });
    await get('/requests/' + result.body.receiptId + '/outputs/' + result.body.outputs[0].outputId + '/content').expect(200);
  });

  it('rejects a changed price and invalid specifications before generation or reservation', async () => {
    const quote = await post('/quotes', input).expect(201);
    const count = dispatches.length; const frozen = reservations.size;
    pricingVersion = 'price-changed';
    await post('/requests', { ...input, quoteId: quote.body.quoteId, clientRequestId: 'changed-price' }).expect(409);
    const missing = await post('/quotes', { ...input, requestedSpec: { count: 2 } });
    expect(missing.body.error).toMatchObject({ code: 'MISSING_SPEC', source: 'request', submissionState: 'not_submitted' });
    const conflict = await post('/quotes', { ...input, requestedSpec: { ...input.requestedSpec, aspectRatio: '16:9' } }).expect(400);
    expect(conflict.body.error).toMatchObject({ code: 'SPEC_CONFLICT', source: 'request', submissionState: 'not_submitted' });
    expect(dispatches).toHaveLength(count); expect(reservations.size).toBe(frozen);
  });
});
