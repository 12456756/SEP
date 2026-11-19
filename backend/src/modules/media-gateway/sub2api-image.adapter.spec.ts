import { deflateSync } from 'node:zlib';
import { HttpException } from '@nestjs/common';
import { SettingService } from '../setting/setting.service';
import { MediaRealQuoteRequestSchema, MediaRealQuoteRequestV3Schema } from '../../shared/media-real.dto';
import { ImageDispatchError, Sub2apiImageAdapter } from './sub2api-image.adapter';

const BASE_URL = 'https://media.example.test/v1/';
const API_KEY = 'private-test-api-key';
const REQUEST_ID = 'sub2api.req:123';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function validPngBase64(width: number, height: number): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const REQUEST_PNG_BASE64 = validPngBase64(1024, 1024);

function input(operation: 'generate' | 'edit' = 'generate') {
  return MediaRealQuoteRequestSchema.parse({
    profileId: 'real-image', configVersion: 'real-v1', operation,
    referenceIds: operation === 'edit' ? ['reference-1'] : [],
    creativeBrief: 'A product photograph',
    parameters: { size: '1024x1024', count: 1, quality: 'medium' },
  });
}

function price(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    object: 'sub2api.image_pricing', schema_version: 1, currency: 'USD', model: 'gpt-image-2',
    operation: 'generate', size: '1024x1024', n: 1, quality: 'medium', billing_mode: 'image',
    pricing_status: 'quoted', pricing_source: 'live-contract', amount_usd: '0.040000',
    pricing_version: 'price-v1', effective_rate_multiplier: 1,
    observed_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

function response(value: unknown, options: { status?: number; requestId?: string; contentType?: string } = {}) {
  const headers = new Headers();
  headers.set('content-type', options.contentType ?? 'application/json');
  if (options.requestId) headers.set('x-request-id', options.requestId);
  return new Response(JSON.stringify(value), { status: options.status ?? 200, headers });
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    object: 'sub2api.request_usage', schema_version: 1, currency: 'USD',
    request_id: REQUEST_ID, status: 'settled', model: 'gpt-image-2',
    actual_cost_usd: '0.040000', image_count: 1, ...overrides,
  };
}

async function expectCode(action: Promise<unknown>, status: number, code: string) {
  const error = await action.then(() => { throw new Error('Expected adapter failure'); }, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
  expect((error as HttpException).getResponse()).toMatchObject({ error: { code } });
  return error as HttpException;
}

async function expectOriginal(action: Promise<unknown>, status: number, body: unknown) {
  const error = await action.catch((reason: unknown) => reason) as HttpException;
  expect(error).toBeInstanceOf(HttpException);
  expect(error.getStatus()).toBe(status);
  if (body !== null && typeof body === 'object') expect(error.getResponse()).toMatchObject(body as object);
  else expect(error.getResponse()).toEqual(body);
  expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain(API_KEY);
  return error;
}

describe('Sub2apiImageAdapter', () => {
  let fetchMock: jest.SpyInstance;
  let settings: jest.Mocked<Pick<SettingService, 'getMediaConnection'>>;
  let adapter: Sub2apiImageAdapter;

  beforeEach(() => {
    settings = {
      getMediaConnection: jest.fn(async (..._args: Parameters<SettingService['getMediaConnection']>): ReturnType<SettingService['getMediaConnection']> => (
        { baseUrl: BASE_URL, apiKey: API_KEY, source: 'database' }
      )),
    };
    adapter = new Sub2apiImageAdapter(settings as unknown as SettingService);
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('submits more than four ordered image references in one edit POST', async () => {
    const referenceIds = Array.from({ length: 8 }, (_, index) => `reference-${index}`);
    const value = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
      profileId: 'real-image', configVersion: 'cfg_multi', operation: 'edit', referenceIds,
      creativeBrief: 'Combine the eight product views', requestedSpec: { size: '1x1', count: 1, quality: 'medium' } });
    fetchMock.mockResolvedValueOnce(response({ data: [{ b64_json: PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    await adapter.execute(value, referenceIds.map(() => Buffer.from(PNG_BASE64, 'base64')));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://media.example.test/v1/images/edits');
    const files = (fetchMock.mock.calls[0][1].body as FormData).getAll('image[]') as File[];
    expect(files.map(file => file.name)).toEqual(referenceIds.map(id => `${id}.png`));
    for (const file of files) expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(PNG_BASE64, 'base64'));
  });

  it.each([[400, 'unsupported_spec', 'UPSTREAM_SPEC_UNSUPPORTED'], [422, 'unsupported_parameter', 'UPSTREAM_SPEC_UNSUPPORTED'],
    [400, 'invalid_request', 'SUBMISSION_UNKNOWN'], [429, 'unsupported_spec', 'SUBMISSION_UNKNOWN']] as const)(
    'preserves HTTP %i while classifying V3 rejection and protecting the connection credential', async (status, code, expected) => {
      const negotiated = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
        profileId: 'future.image', configVersion: 'future-config', operation: 'generate', referenceIds: [],
        creativeBrief: 'A future image', requestedSpec: { size: '1x1', count: 1, quality: 'studio' } });
      fetchMock.mockResolvedValueOnce(response({ error: { code, message: 'private-api-key https://secret.internal/account', token: API_KEY } }, { status, requestId: REQUEST_ID }));
      const failure = await expectOriginal(adapter.execute(negotiated, [], undefined, 'future-image-native'), status,
        { error: { code, message: 'private-api-key [REDACTED]', token: '[REDACTED]' } });
      expect(failure).toMatchObject({ definitelyRejected: false, requestId: REQUEST_ID });
      expect((failure as ImageDispatchError).safeCode).toBe(expected === 'UPSTREAM_SPEC_UNSUPPORTED' ? expected : 'UPSTREAM_FAILED');
    },
  );

  it('does not classify oversized V3 error bodies as supported specification evidence', async () => {
    const negotiated = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
      profileId: 'future.image', configVersion: 'future-config', operation: 'generate', referenceIds: [],
      creativeBrief: 'A future image', requestedSpec: { size: '1x1', count: 1, quality: 'studio' } });
    fetchMock.mockResolvedValueOnce(response({ error: { code: 'unsupported_spec', message: 'x'.repeat(257 * 1024) } }, { status: 422 }));
    const failure = await expectOriginal(adapter.execute(negotiated, [], undefined, 'future-image-native'), 422,
      { body: expect.any(String), truncated: true });
    expect(failure).toMatchObject({ definitelyRejected: false, safeCode: 'UPSTREAM_FAILED' });
  });

  it.each([400, 401, 403, 404, 413, 422, 429])('keeps V3 HTTP %i failures uncertain without trusted dispatch evidence', async status => {
    const negotiated = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
      profileId: 'future.image', configVersion: 'future-config', operation: 'generate', referenceIds: [],
      creativeBrief: 'A future image', requestedSpec: { size: '1x1', count: 1, quality: 'studio' } });
    fetchMock.mockResolvedValueOnce(response({ error: { code: 'provider_error' } }, { status, requestId: REQUEST_ID }));
    const failure = await expectOriginal(adapter.execute(negotiated, [], undefined, 'future-image-native'), status,
      { error: { code: 'provider_error' } });
    expect(failure).toMatchObject({ definitelyRejected: false, requestId: REQUEST_ID });
  });

  it('quotes pixel dimensions using the same equivalent size mapping as generation', async () => {
    const negotiated = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
      profileId: 'future.image', configVersion: 'future-config', operation: 'generate', referenceIds: [],
      creativeBrief: 'A future image', requestedSpec: { width: 1, height: 1, count: 1, quality: 'studio' } });
    fetchMock.mockResolvedValueOnce(response(price({ size: '1x1', quality: 'studio' })));
    await adapter.pricing(negotiated);
    fetchMock.mockResolvedValueOnce(response({ data: [{ b64_json: PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    await adapter.execute(negotiated, []);
    for (const call of fetchMock.mock.calls) expect(JSON.parse(call[1].body)).toMatchObject({ size: '1x1', n: 1, quality: 'studio' });
  });

  it.each([{ size: 'auto', width: 1, height: 1 }, { size: 'auto', aspectRatio: '1:1' }])(
    'rejects unexpressible explicit dimensions before pricing or dispatch: %j', async dimensions => {
      const negotiated = MediaRealQuoteRequestV3Schema.parse({ protocolVersion: 3, specRevision: 1,
        profileId: 'future.image', configVersion: 'future-config', operation: 'generate', referenceIds: [],
        creativeBrief: 'A future image', requestedSpec: { ...dimensions, count: 1, quality: 'studio' } });
      await expectCode(adapter.pricing(negotiated), 422, 'ADAPTER_FIELD_UNMAPPED');
      await expectCode(adapter.execute(negotiated, []), 422, 'ADAPTER_FIELD_UNMAPPED');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('retains safe extra V3 outputs for delivery mismatch verification', async () => {
    const negotiated = MediaRealQuoteRequestV3Schema.parse({
      protocolVersion: 3, specRevision: 1, profileId: 'future.image', configVersion: 'future-config',
      operation: 'generate', referenceIds: [], creativeBrief: 'A future image', requestedSpec: { size: '1x1', count: 1, quality: 'studio' },
    });
    fetchMock.mockResolvedValueOnce(response({ model: 'future-image-native', data: [
      { b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 },
    ] }, { requestId: REQUEST_ID }));
    await expect(adapter.execute(negotiated, [], undefined, 'future-image-native')).resolves.toMatchObject({ images: [expect.any(Buffer), expect.any(Buffer)] });
  });

  it.each(['generate', 'edit'] as const)('forwards negotiated V3 model and spec in %s wire format', async operation => {
    const negotiated = MediaRealQuoteRequestV3Schema.parse({
      protocolVersion: 3, specRevision: 1, profileId: 'future.image', configVersion: 'config:2026.10',
      operation, referenceIds: operation === 'edit' ? ['reference-1'] : [], creativeBrief: 'A future image',
      requestedSpec: { size: '2048x1152', count: 1, quality: 'ultra-native' },
    });
    fetchMock.mockResolvedValueOnce(response(price({ model: 'future-image-native', operation,
      size: '2048x1152', quality: 'ultra-native' })));
    await expect(adapter.pricing(negotiated, 'future-image-native')).resolves.toMatchObject({ model: 'future-image-native' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'future-image-native', size: '2048x1152', quality: 'ultra-native', n: 1 });
    fetchMock.mockResolvedValueOnce(response({ model: 'future-image-native', data: [{ b64_json: PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    const result = await adapter.execute(negotiated, operation === 'edit' ? [Buffer.from(PNG_BASE64, 'base64')] : [], undefined, 'future-image-native');
    expect(result.images).toHaveLength(1);
    const wire = fetchMock.mock.calls[1][1];
    if (operation === 'generate') expect(JSON.parse(wire.body)).toMatchObject({ model: 'future-image-native', size: '2048x1152', quality: 'ultra-native', n: 1 });
    else {
      expect(wire.body).toBeInstanceOf(FormData);
      expect(Object.fromEntries((wire.body as FormData).entries())).toMatchObject({ model: 'future-image-native', size: '2048x1152', quality: 'ultra-native', n: '1' });
      expect((wire.body as FormData).getAll('image[]')).toHaveLength(1);
    }
  });

  it('uses the complete independent image pair and pins catalog requests to the supplied snapshot', async () => {
    fetchMock.mockImplementation(async () => response({ data: [{ id: 'gpt-image-2' }] }));
    await adapter.discoverModels();
    expect(settings.getMediaConnection).toHaveBeenCalledWith('image');
    settings.getMediaConnection.mockClear();
    settings.getMediaConnection.mockRejectedValue(new Error('Settings changed'));
    await adapter.discoverModels({ base: 'https://frozen-image.example', key: API_KEY });
    expect(fetchMock.mock.calls[1][0]).toBe('https://frozen-image.example/v1/models');
    expect(settings.getMediaConnection).not.toHaveBeenCalled();
  });

  it('persists and queries the sub2api client billing ID instead of the upstream request ID', async () => {
    const upstream = response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: 'upstream-request-id' });
    upstream.headers.set('x-client-request-id', 'gateway-client-id');
    fetchMock.mockResolvedValueOnce(upstream);
    const onRequestId = jest.fn(async () => {});
    await expect(adapter.execute(input(), [], onRequestId)).resolves.toMatchObject({ requestId: 'client:gateway-client-id' });
    expect(onRequestId).toHaveBeenCalledWith('client:gateway-client-id');
    fetchMock.mockResolvedValueOnce(response(usage({ request_id: 'client:gateway-client-id' })));
    await expect(adapter.usage('client:gateway-client-id')).resolves.toMatchObject({ status: 'settled' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://media.example.test/v1/sub2api/usage?request_id=client%3Agateway-client-id');
  });

  it.each(['', 'invalid client id', 'first, second', 'x'.repeat(250)])('never falls back to an unrelated request ID for an invalid client billing header %#', async clientId => {
    const upstream = response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID });
    upstream.headers.set('x-client-request-id', clientId);
    fetchMock.mockResolvedValueOnce(upstream);
    const onRequestId = jest.fn(async () => {});
    const failure = await expectCode(adapter.execute(input(), [], onRequestId), 502, 'SUBMISSION_UNKNOWN');
    expect(failure).toMatchObject({ requestId: null, definitelyRejected: false });
    expect(onRequestId).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a current quoted non-token price matching the request', async () => {
    fetchMock.mockResolvedValueOnce(response(price()));
    const result = await adapter.pricing(input());
    expect(result.amount_usd).toBe('0.040000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://media.example.test/v1/sub2api/images/pricing');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('quotes and dispatches the explicitly selected compatible model, accepting OpenAI responses without a model field', async () => {
    const selectedModel = 'gpt-image-1.5';
    fetchMock.mockResolvedValueOnce(response(price({ model: selectedModel })));
    await expect(adapter.pricing(input(), selectedModel)).resolves.toMatchObject({ model: selectedModel });
    fetchMock.mockResolvedValueOnce(response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    await expect(adapter.execute(input(), [], undefined, selectedModel)).resolves.toMatchObject({ requestId: REQUEST_ID });
    const pricingBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const executionBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(pricingBody.model).toBe(selectedModel);
    expect(executionBody.model).toBe(selectedModel);
  });

  it('keeps an explicit mismatching response model unresolved after dispatch', async () => {
    fetchMock.mockResolvedValueOnce(response({ model: 'gpt-image-2', data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    const error = await expectCode(adapter.execute(input(), [], undefined, 'gpt-image-1.5'), 502, 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: false });
  });

  it('accepts an effective fallback charge explicitly attested by sub2api customer billing', async () => {
    fetchMock.mockResolvedValueOnce(response(price({ pricing_source: 'fallback', pricing_authority: 'sub2api_customer_billing' })));
    await expect(adapter.pricing(input())).resolves.toMatchObject({
      pricing_source: 'fallback', pricing_authority: 'sub2api_customer_billing', amount_usd: '0.040000',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown', { pricing_status: 'unavailable', amount_usd: null }],
    ['fallback source', { pricing_source: 'unknown-default-fallback' }],
    ['unattested fallback', { pricing_source: 'fallback' }],
    ['unknown authority', { pricing_source: 'fallback', pricing_authority: 'supplier_estimate' }],
    ['unknown source despite authority', { pricing_source: 'unknown-default-fallback', pricing_authority: 'sub2api_customer_billing' }],
    ['token billing despite authority', { billing_mode: 'token', pricing_source: 'fallback', pricing_authority: 'sub2api_customer_billing' }],
    ['token billing', { billing_mode: 'token' }],
    ['missing amount', { amount_usd: null }],
    ['wrong model', { model: 'other-image-model' }],
    ['wrong operation', { operation: 'edit' }],
    ['wrong size', { size: '1536x1024' }],
    ['wrong count', { n: 2 }],
    ['wrong quality', { quality: 'high' }],
    ['expired quote', { expires_at: new Date(Date.now() - 1).toISOString() }],
    ['quote lifetime too long', { expires_at: new Date(Date.now() + 180_000).toISOString() }],
  ])('rejects %s pricing without reserving or dispatching', async (_label, overrides) => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T00:00:00Z'));
    fetchMock.mockResolvedValueOnce(response(price(overrides)));
    await expectCode(adapter.pricing(input()), 503, 'PRICE_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sub2api/images/pricing');
  });

  it('reports malformed and oversized pricing responses with a specific diagnostic', async () => {
    fetchMock.mockResolvedValueOnce(response({ secret: API_KEY }, { contentType: 'text/html' }));
    const error = await expectOriginal(adapter.pricing(input()), 502,
      { error: { name: 'Error', message: 'Upstream response must contain a JSON body' } });
    expect(JSON.stringify(error.getResponse())).not.toContain(API_KEY);
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }));
    await expectOriginal(adapter.pricing(input()), 502,
      { error: { name: 'Error', message: 'Upstream response exceeds 65536 bytes' } });
  });

  it('redacts credentials and private URL details for invalid media settings', async () => {
    const secrets = [
      ['http://private-user:private-password@internal.example.test/private/path?token=private-query', API_KEY],
      ['https://media.example.test/private?token=private-query', API_KEY],
      [BASE_URL, `bad\n${API_KEY}`],
      [BASE_URL, '   '],
    ];
    for (const [url, key] of secrets) {
      settings.getMediaConnection.mockResolvedValue({ baseUrl: url, apiKey: key, source: 'database' });
      const error = await expectCode(adapter.pricing(input()), 503, 'PRICE_UNAVAILABLE');
      const serialized = JSON.stringify(error.getResponse()) + error.stack;
      expect(serialized).not.toContain('private-user');
      expect(serialized).not.toContain('private-password');
      expect(serialized).not.toContain('private-query');
      expect(serialized).not.toContain('private/path');
      expect(serialized).not.toContain('internal.example.test');
      expect(serialized).not.toContain(API_KEY);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the network failure message while protecting the connection credential', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`failed at ${BASE_URL} Authorization: Bearer ${API_KEY}`));
    const error = await expectOriginal(adapter.pricing(input()), 502,
      { error: { name: 'Error', message: `failed at ${BASE_URL} Authorization: [REDACTED]` } });
    expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain(API_KEY);
  });

  it('classifies dispatch connection loss as unknown and never retries', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`socket reset ${BASE_URL} ${API_KEY}`));
    const error = await expectOriginal(adapter.execute(input(), []), 502,
      { error: { name: 'Error', message: `socket reset ${BASE_URL} [REDACTED]` } });
    expect(error).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain(API_KEY);
  });

  it('preserves a validated request ID when dispatch succeeds', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID }));
    const result = await adapter.execute(input(), []);
    expect(result.requestId).toBe(REQUEST_ID);
    expect(result.images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://media.example.test/v1/images/generations');
  });

  it('awaits request ID persistence before acquiring or reading the body', async () => {
    const upstream = response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID });
    const getReader = jest.spyOn(upstream.body!, 'getReader');
    let entered!: () => void;
    let persist!: () => void;
    const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
    const persisted = new Promise<void>(resolve => { persist = resolve; });
    const onRequestId = jest.fn(async () => { entered(); await persisted; });
    fetchMock.mockResolvedValueOnce(upstream);
    const execution = adapter.execute(input(), [], onRequestId);
    try {
      await callbackEntered;
      expect(onRequestId).toHaveBeenCalledTimes(1);
      expect(onRequestId).toHaveBeenCalledWith(REQUEST_ID);
      expect(getReader).not.toHaveBeenCalled();
      expect(upstream.bodyUsed).toBe(false);
    } finally { persist(); }
    await expect(execution).resolves.toMatchObject({ requestId: REQUEST_ID });
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['storage error', () => Promise.reject(new Error('private persistence failure'))],
    ['HTTP error', () => Promise.reject(new HttpException('private storage response', 400))],
    ['definite dispatch error', () => Promise.reject(new ImageDispatchError(REQUEST_ID, true))],
    ['synchronous exception', () => { throw new Error('private synchronous failure'); }],
  ])('treats a callback %s as unknown, not a definite rejection, without reading or retrying', async (_label, callback) => {
    const upstream = response({ error: 'rejected' }, { status: 429, requestId: REQUEST_ID });
    const getReader = jest.spyOn(upstream.body!, 'getReader');
    const cancel = jest.spyOn(upstream.body!, 'cancel');
    const onRequestId = jest.fn(callback);
    fetchMock.mockResolvedValueOnce(upstream);
    const error = await expectCode(adapter.execute(input(), [], onRequestId), 502, 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: false });
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.getResponse()).toHaveProperty('error.cause');
  });

  it('cancels a successful response without reading when request ID persistence fails', async () => {
    const upstream = response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID });
    const getReader = jest.spyOn(upstream.body!, 'getReader');
    const cancel = jest.spyOn(upstream.body!, 'cancel');
    fetchMock.mockResolvedValueOnce(upstream);
    const onRequestId = jest.fn(async () => { throw new HttpException('storage unavailable', 503); });
    const error = await expectCode(adapter.execute(input(), [], onRequestId), 502, 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: false });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'request id', 'a'.repeat(257), 'request/id', '\u00e9'])('does not notify an absent or invalid header ID %#', async requestId => {
    fetchMock.mockResolvedValueOnce(response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId }));
    const onRequestId = jest.fn(async () => {});
    const error = await expectCode(adapter.execute(input(), [], onRequestId), 502, 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: null, definitelyRejected: false });
    expect(onRequestId).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([REQUEST_ID, 'different-id'])('does not notify repeated response headers, even when their values agree (%s)', async secondId => {
    const upstream = response({ data: [{ b64_json: REQUEST_PNG_BASE64 }] }, { requestId: REQUEST_ID });
    upstream.headers.append('x-request-id', secondId);
    fetchMock.mockResolvedValueOnce(upstream);
    const onRequestId = jest.fn(async () => {});
    const error = await expectCode(adapter.execute(input(), [], onRequestId), 502, 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: null, definitelyRejected: false });
    expect(onRequestId).not.toHaveBeenCalled();
  });

  it('does not notify on connection failure before response headers', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket reset'));
    const onRequestId = jest.fn(async () => {});
    await expectOriginal(adapter.execute(input(), [], onRequestId), 502, { error: { name: 'Error', message: 'socket reset' } });
    expect(onRequestId).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('notifies once before JSON parsing failure and keeps the request ID for recovery', async () => {
    const upstream = new Response('{broken JSON', { headers: {
      'content-type': 'application/json', 'x-request-id': REQUEST_ID,
    } });
    fetchMock.mockResolvedValueOnce(upstream);
    const onRequestId = jest.fn(async () => {});
    const error = await expectOriginal(adapter.execute(input(), [], onRequestId), 502,
      { error: { name: 'SyntaxError', message: expect.any(String) } });
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: false });
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not notify again or retry when the response stream fails after headers', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('body disconnected')); },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: {
      'content-type': 'application/json', 'x-request-id': REQUEST_ID,
    } }));
    const onRequestId = jest.fn(async () => {});
    const error = await expectOriginal(adapter.execute(input(), [], onRequestId), 502,
      { error: { name: 'Error', message: 'body disconnected' } });
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: false });
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing 429 decision after a successful request ID callback', async () => {
    fetchMock.mockResolvedValueOnce(response({}, { status: 429, requestId: REQUEST_ID }));
    const onRequestId = jest.fn(async () => {});
    const error = await expectOriginal(adapter.execute(input(), [], onRequestId), 429, {});
    expect(error).toMatchObject({ requestId: REQUEST_ID, definitelyRejected: true });
    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3, 4])('accepts settled usage with image_count %i', async imageCount => {
    fetchMock.mockResolvedValueOnce(response(usage({ image_count: imageCount })));
    await expect(adapter.usage(REQUEST_ID)).resolves.toMatchObject({ status: 'settled', image_count: imageCount });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 0, -1, 1.5, 5, '1'])('rejects settled usage with missing or invalid image_count %#', async imageCount => {
    fetchMock.mockResolvedValueOnce(response(usage({ image_count: imageCount })));
    await expectCode(adapter.usage(REQUEST_ID), 503, 'BILLING_PENDING');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 0])('allows pending usage with empty or zero image_count %#', async imageCount => {
    fetchMock.mockResolvedValueOnce(response(usage({ status: 'pending', model: null, actual_cost_usd: null, image_count: imageCount })));
    await expect(adapter.usage(REQUEST_ID)).resolves.toMatchObject({ status: 'pending', actual_cost_usd: null });
  });

  it.each([
    ['invalid JSON payload', { data: [{ b64_json: 'not base64' }] }],
    ['corrupt PNG', { data: [{ b64_json: Buffer.from('broken png').toString('base64') }] }],
    ['wrong dimensions', { data: [{ b64_json: PNG_BASE64 }] }],
  ])('treats %s after upstream dispatch as unknown with request ID', async (_label, payload) => {
    fetchMock.mockResolvedValueOnce(response(payload, { requestId: REQUEST_ID }));
    const error = await expectCode(adapter.execute(input(), []), 502, _label === 'corrupt PNG' ? 'OUTPUT_FAILED' : 'SUBMISSION_UNKNOWN');
    expect(error).toBeInstanceOf(HttpException);
    expect((error as unknown as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((error as unknown as { definitelyRejected: boolean }).definitelyRejected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps malformed or absent upstream request IDs null', async () => {
    fetchMock.mockResolvedValueOnce(response({ not: 'json image payload' }, { requestId: 'request id with spaces' }));
    const error = await expectCode(adapter.execute(input(), []), 502, 'SUBMISSION_UNKNOWN');
    expect((error as unknown as { requestId: string | null }).requestId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 413, 422, 429])('classifies explicit HTTP %i dispatch rejection as definite', async (status) => {
    fetchMock.mockResolvedValueOnce(response({ error: 'private upstream body' }, { status, requestId: REQUEST_ID }));
    const error = await expectOriginal(adapter.execute(input(), []), status, { error: 'private upstream body' });
    expect((error as unknown as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((error as unknown as { definitelyRejected: boolean }).definitelyRejected).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a gateway 5xx response and retains unknown dispatch state', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('gateway failed')); controller.close(); } });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 502, headers: { 'x-request-id': REQUEST_ID } }));
    const error = await expectOriginal(adapter.execute(input(), []), 502, 'gateway failed');
    expect((error as unknown as { requestId: string }).requestId).toBe(REQUEST_ID);
    expect((error as unknown as { definitelyRejected: boolean }).definitelyRejected).toBe(false);
    expect(body.locked).toBe(false);
  });

  it('rejects edit references before dispatch and validates uploaded PNGs', async () => {
    await expectCode(adapter.execute(input('edit'), []), 503, 'INVALID_REFERENCE');
    await expectCode(adapter.execute(input('edit'), [Buffer.from('not png')]), 502, 'OUTPUT_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
