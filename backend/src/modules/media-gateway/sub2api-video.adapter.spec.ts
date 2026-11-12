import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayQuoteRequestV3Schema } from '../../shared/media-video.dto';
import { SettingService } from '../setting/setting.service';
import { Sub2apiVideoAdapter, VideoDispatchError } from './sub2api-video.adapter';

const KEY = 'private-video-test-key';
const BASE = 'https://relay.example.test/v1';
const CONNECTION = { base: BASE, key: KEY, fingerprint: createHash('sha256').update(BASE + '\0' + KEY).digest('hex') };
const TASK_ID = 'task_original-1';
const BILLING_ID = 'client:server-request-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64');
function input(operation: 'text-to-video' | 'image-to-video' = 'text-to-video') {
  return MediaVideoGatewayQuoteRequestSchema.parse({
    profileId: 'video-real', configVersion: 'v2', operation, creativeBrief: 'A ceramic mug',
    referenceIds: operation === 'image-to-video' ? ['reference-1'] : [],
    parameters: { durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', frameRate: 24, audio: true, outputFormat: 'video/mp4' },
  });
}
function inputV3() {
  return MediaVideoGatewayQuoteRequestV3Schema.parse({
    protocolVersion: 3, profileId: 'video-real', configVersion: 'v3', operation: 'text-to-video',
    creativeBrief: 'A vertical ceramic mug advert', referenceIds: [], specRevision: 2,
    requestedSpec: { durationSeconds: 8, aspectRatio: '9:16', resolution: '1080p', frameRate: 30, audio: false, outputFormat: 'video/mp4' },
    parameterSources: { durationSeconds: 'model', aspectRatio: 'user', audio: 'user' },
  });
}
const task = (extra = {}) => ({ object: 'video', id: TASK_ID, task_id: TASK_ID, model: 'minimax-h3', status: 'queued', progress: 0, ...extra });
const response = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'X-Client-Request-ID': 'server-request-1', ...headers },
});
function price(extra = {}) {
  return { object: 'sub2api.video_pricing', schema_version: 1, currency: 'USD', model: 'minimax-h3', operation: 'text-to-video',
    resolution: '720p', duration_seconds: 4, billing_mode: 'video', pricing_status: 'quoted', pricing_source: 'customer_video_contract',
    pricing_authority: 'sub2api_customer_billing', amount_usd: '0.128000', pricing_version: 'price-1', effective_rate_multiplier: 1,
    observed_at: new Date(Date.now()).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), ...extra };
}
const usage = (extra = {}) => ({ object: 'sub2api.video_request_usage', schema_version: 1, currency: 'USD',
  request_id: BILLING_ID, status: 'settled', model: 'minimax-h3', actual_cost_usd: '0.128000', video_count: 1,
  duration_seconds: 4, resolution: '720p', ...extra });

describe('Sub2apiVideoAdapter (mock fetch only)', () => {
  let adapter: Sub2apiVideoAdapter;
  let fetchMock: jest.Mock;
  let settings: { getMediaConnection: jest.Mock };
  let originalFetch: typeof global.fetch;
  let originalBase: string | undefined;
  let originalKey: string | undefined;
  beforeEach(() => {
    originalBase = process.env.MEDIA_VIDEO_BASE_URL; originalKey = process.env.MEDIA_VIDEO_API_KEY;
    delete process.env.MEDIA_VIDEO_BASE_URL; delete process.env.MEDIA_VIDEO_API_KEY;
    originalFetch = global.fetch;
    fetchMock = jest.fn().mockRejectedValue(new Error('Unexpected fetch in test'));
    global.fetch = fetchMock;
    settings = { getMediaConnection: jest.fn(async () => ({ baseUrl: BASE, apiKey: KEY, source: 'database' })) };
    adapter = new Sub2apiVideoAdapter(settings as unknown as SettingService);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.MEDIA_VIDEO_BASE_URL; else process.env.MEDIA_VIDEO_BASE_URL = originalBase;
    if (originalKey === undefined) delete process.env.MEDIA_VIDEO_API_KEY; else process.env.MEDIA_VIDEO_API_KEY = originalKey;
  });
  async function errorOf(promise: Promise<unknown>, code: string) {
    const error = await promise.then(() => { throw new Error('Expected rejection'); }, error => error);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getResponse()).toMatchObject({ error: { code } });
    expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain(KEY);
    return error;
  }

  it('accepts authoritative V3 pricing and usage beyond legacy duration limits', async () => {
    const input = inputV3();
    input.requestedSpec.durationSeconds = 901;
    const connection = await adapter.connection();
    fetchMock.mockResolvedValueOnce(response(price({ duration_seconds: 901, resolution: '1080p' })))
      .mockResolvedValueOnce(response(usage({ duration_seconds: 901, resolution: '1080p' })));
    await expect(adapter.pricing(connection, input, 'minimax-h3')).resolves.toMatchObject({ duration_seconds: 901 });
    await expect(adapter.usage(connection, BILLING_ID)).resolves.toMatchObject({ duration_seconds: 901 });
  });

  it.each(['https://relay.example.test', BASE, BASE + '/', 'https://relay.example.test/prefix/v1/'])(
    'normalizes HTTPS settings and fingerprints base and key (%s)', async base => {
      settings.getMediaConnection.mockResolvedValue({ baseUrl: base, apiKey: KEY, source: 'database' });
      const connection = await adapter.connection();
      expect(connection.base).toBe(base.includes('/prefix') ? 'https://relay.example.test/prefix/v1' : BASE);
      expect(connection.fingerprint).toBe(createHash('sha256').update(connection.base + '\0' + KEY).digest('hex'));
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('uses the effective saved video pair even when process environment contains older credentials', async () => {
    process.env.MEDIA_VIDEO_BASE_URL = 'https://video.example.test'; process.env.MEDIA_VIDEO_API_KEY = KEY;
    expect(await adapter.connection()).toMatchObject({ base: BASE, key: KEY });
    expect(settings.getMediaConnection).toHaveBeenCalledWith('video');
  });

  it('uses only the independent video settings when Compose supplies empty overrides', async () => {
    process.env.MEDIA_VIDEO_BASE_URL = '';
    process.env.MEDIA_VIDEO_API_KEY = '';
    expect(await adapter.connection()).toMatchObject({ base: BASE, key: KEY });
    expect(settings.getMediaConnection).toHaveBeenCalledTimes(1);
    expect(settings.getMediaConnection).toHaveBeenCalledWith('video');
  });

  it.each([['https://video.example.test', undefined], [undefined, KEY], ['', KEY], [BASE, '']])(
    'rejects incomplete effective video pairs instead of falling back to image credentials %#', async (base, key) => {
      settings.getMediaConnection.mockResolvedValue({ baseUrl: base ?? '', apiKey: key ?? '', source: 'unconfigured' });
      await errorOf(adapter.connection(), 'PRICE_UNAVAILABLE');
      expect(settings.getMediaConnection).toHaveBeenCalledTimes(1);
      expect(settings.getMediaConnection).toHaveBeenCalledWith('video');
    });

  it.each(['http://relay.example.test', 'https://user:password@relay.example.test', BASE + '?private=1', BASE + '#private'])(
    'rejects unsafe connection %s without exposing it', async base => {
      settings.getMediaConnection.mockResolvedValue({ baseUrl: base, apiKey: KEY, source: 'database' });
      const error = await errorOf(adapter.connection(), 'PRICE_UNAVAILABLE');
      expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain(base);
    });

  it('redacts setting failures and rejects modified frozen connections', async () => {
    settings.getMediaConnection.mockRejectedValue(new Error(KEY));
    await errorOf(adapter.connection(), 'PRICE_UNAVAILABLE');
    await errorOf(adapter.discover({ ...CONNECTION, key: 'changed' }), 'PRICE_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers deduplicated catalog entries without treating them as execution support', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [{ id: 'minimax-m3' }, { id: 'minimax-h3', display_name: 'Video H3' }, { id: 'minimax-h3' }] }));
    expect(await adapter.discover(CONNECTION)).toEqual([{ modelId: 'minimax-h3', displayName: 'Video H3' }, { modelId: 'minimax-m3', displayName: 'minimax-m3' }]);
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/models');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe(`Bearer ${KEY}`);
  });

  it('verifies customer pricing and sends the complete pricing echo', async () => {
    fetchMock.mockResolvedValueOnce(response(price()));
    await expect(adapter.pricing(CONNECTION, input(), 'minimax-h3')).resolves.toMatchObject({ amount_usd: '0.128000' });
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/sub2api/videos/pricing');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'minimax-h3', operation: 'text-to-video', resolution: '720p', duration_seconds: 4 });
  });

  it('prices and submits supported V3 fields while omitting unsupported fps', async () => {
    fetchMock.mockResolvedValueOnce(response(price({ resolution: '1080p', duration_seconds: 8 })))
      .mockResolvedValueOnce(response(task()));
    const value = inputV3();
    await expect(adapter.pricing(CONNECTION, value, 'minimax-h3')).resolves.toMatchObject({ resolution: '1080p', duration_seconds: 8 });
    await expect(adapter.submit(CONNECTION, value, 'minimax-h3', [], 'client-v3', 'price-1')).resolves.toMatchObject({ taskId: TASK_ID });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'minimax-h3', operation: 'text-to-video', resolution: '1080p', duration_seconds: 8 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ model: 'minimax-h3', prompt: value.creativeBrief,
      seconds: 8, resolution: '1080p', aspect_ratio: '9:16', generate_audio: false, output_format: 'video/mp4' });
    expect(value.requestedSpec.frameRate).toBe(30);
  });

  it('omits unsupported fps from V3 image-to-video multipart requests', async () => {
    const value = MediaVideoGatewayQuoteRequestV3Schema.parse({ ...inputV3(),
      operation: 'image-to-video', referenceIds: ['reference-1'] });
    fetchMock.mockResolvedValueOnce(response(task({ model: 'seedance-2.0' })));
    await adapter.submit(CONNECTION, value, 'seedance-2.0', [PNG], 'client-v3-image', 'price-1');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.has('fps')).toBe(false);
    expect(form.get('model')).toBe('seedance-2.0');
    expect(form.get('seconds')).toBe('8');
    expect(form.get('aspect_ratio')).toBe('9:16');
    expect(Buffer.from(await (form.get('input_reference') as Blob).arrayBuffer())).toEqual(PNG);
  });

  it('rejects missing V3 pricing dimensions before any upstream request', async () => {
    const value = MediaVideoGatewayQuoteRequestV3Schema.parse({ ...inputV3(), requestedSpec: { aspectRatio: '9:16' } });
    const error = await errorOf(adapter.pricing(CONNECTION, value, 'minimax-h3'), 'MISSING_SPEC');
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ error: { field: 'requestedSpec.durationSeconds', source: 'adapter',
      stage: 'quote', reason: expect.any(String), retryable: false, submissionState: 'not_submitted', billingState: 'not_reserved' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects V3 WebM at quote and submit before any upstream request', async () => {
    const value = { ...inputV3(), requestedSpec: { ...inputV3().requestedSpec, outputFormat: 'video/webm' } };
    for (const [stage, action] of [
      ['quote', () => adapter.pricing(CONNECTION, value, 'minimax-h3')],
      ['submit', () => adapter.submit(CONNECTION, value, 'minimax-h3', [], 'client-v3', 'price-1')],
    ] as const) {
      const error = await errorOf(action(), 'ADAPTER_FIELD_UNMAPPED');
      expect(error.getResponse()).toMatchObject({ error: { field: 'requestedSpec.outputFormat', source: 'adapter',
        stage, reason: expect.any(String), retryable: false, submissionState: 'not_submitted', billingState: 'not_reserved' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'other' }, { operation: 'image-to-video' }, { resolution: '2k' }, { duration_seconds: 8 },
    { billing_mode: 'token' }, { pricing_status: 'unavailable' }, { pricing_source: 'public_fallback' },
    { pricing_source: 'fallback' }, { pricing_authority: undefined }, { pricing_authority: 'public_catalog' },
    { amount_usd: null }, { amount_usd: '-0.1' }, { amount_usd: '0.1234567890123' },
    { effective_rate_multiplier: -1 }, { expires_at: '2020-01-01T00:00:00Z' },
    { expires_at: '2099-01-01T00:00:00Z' }, { observed_at: '2099-01-01T00:00:00Z' },
    { observed_at: '2020-01-01T00:00:00Z' },
  ])('rejects unverifiable price %#', async patch => {
    fetchMock.mockResolvedValueOnce(response(price(patch)));
    await errorOf(adapter.pricing(CONNECTION, input(), 'minimax-h3'), 'PRICE_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts per-request zero prices only with complete customer billing authority', async () => {
    fetchMock.mockResolvedValueOnce(response(price({ billing_mode: 'per_request', amount_usd: '0' })));
    await expect(adapter.pricing(CONNECTION, input(), 'minimax-h3')).resolves.toMatchObject({ amount_usd: '0' });
  });

  it('reads settled usage by billing ID, and pending usage has no amount', async () => {
    fetchMock.mockResolvedValueOnce(response(usage()));
    await expect(adapter.usage(CONNECTION, BILLING_ID)).resolves.toMatchObject({ status: 'settled', video_count: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/sub2api/videos/usage?request_id=client%3Aserver-request-1');
    fetchMock.mockResolvedValueOnce(response(usage({ status: 'pending', model: null, actual_cost_usd: null,
      video_count: null, duration_seconds: null, resolution: null })));
    await expect(adapter.usage(CONNECTION, BILLING_ID)).resolves.toMatchObject({ status: 'pending', actual_cost_usd: null });
  });

  it.each([
    { request_id: 'unrelated' }, { actual_cost_usd: null }, { model: null }, { video_count: null }, { video_count: 0 },
    { video_count: 1.5 }, { duration_seconds: null }, { duration_seconds: 0 }, { resolution: null },
    { model: undefined }, { actual_cost_usd: '-1' }, { status: 'pending', actual_cost_usd: '0' },
  ])('rejects incomplete, mismatched or inconsistent usage %#', async patch => {
    fetchMock.mockResolvedValueOnce(response(usage(patch)));
    await errorOf(adapter.usage(CONNECTION, BILLING_ID), 'BILLING_PENDING');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits JSON with the explicit tested model and separates task and billing IDs', async () => {
    fetchMock.mockResolvedValueOnce(response(task(), 200, { 'X-Request-ID': 'unrelated-supplier-id' }));
    expect(await adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-original-1', 'price-1')).toEqual({ taskId: TASK_ID, requestId: BILLING_ID, status: 'queued' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(BASE + '/videos');
    expect(options.method).toBe('POST');
    expect(options.headers.get('Idempotency-Key')).toBe('client-original-1');
    expect(options.headers.get('X-Client-Request-ID')).toBe('client-original-1');
    expect(options.headers.get('X-Video-Pricing-Version')).toBe('price-1');
    expect(options.headers.get('X-Video-Operation')).toBe('text-to-video');
    expect(JSON.parse(options.body)).toEqual({ model: 'minimax-h3', prompt: 'A ceramic mug', seconds: 4,
      size: '1280x720', resolution: '720p', generate_audio: true, metadata: { resolution: '768P', ratio: '16:9' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits validated PNG as multipart input_reference without JSON bytes or automatic fallback', async () => {
    fetchMock.mockResolvedValueOnce(response(task()));
    await adapter.submit(CONNECTION, input('image-to-video'), 'minimax-h3', [PNG], 'client-original-1', 'price-1');
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers.has('Content-Type')).toBe(false);
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('model')).toBe('minimax-h3');
    expect(options.body.get('generate_audio')).toBe('true');
    expect(options.body.get('seconds')).toBe('4');
    expect(JSON.parse(options.body.get('metadata'))).toEqual({ resolution: '768P', ratio: '16:9' });
    const file = options.body.get('input_reference') as Blob;
    expect(file.type).toBe('image/png'); expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ durationSeconds: 5 }, { aspectRatio: '9:16' }, { resolution: '1080p' }, { audio: false }, { frameRate: 30 }, { outputFormat: 'video/webm' }])(
    'rejects unverified specifications before either pricing or submit %#', async patch => {
      const value = { ...input(), parameters: { ...input().parameters, ...patch } } as ReturnType<typeof input>;
      await errorOf(adapter.submit(CONNECTION, value, 'minimax-h3', [], 'client-1', 'price-1'), 'UNSUPPORTED_VIDEO_SPEC');
      await errorOf(adapter.pricing(CONNECTION, value, 'minimax-h3'), 'UNSUPPORTED_VIDEO_SPEC');
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('rejects cross-model execution and invalid references locally', async () => {
    await errorOf(adapter.submit(CONNECTION, input(), 'minimax-m3', [], 'client-1', 'price-1'), 'UNSUPPORTED_VIDEO_SPEC');
    await errorOf(adapter.submit(CONNECTION, input('image-to-video'), 'minimax-h3', [], 'client-1', 'price-1'), 'INVALID_REFERENCE');
    await errorOf(adapter.submit(CONNECTION, input('image-to-video'), 'minimax-h3', [Buffer.from('broken')], 'client-1', 'price-1'), 'INVALID_REFERENCE');
    await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [PNG], 'client-1', 'price-1'), 'INVALID_REFERENCE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 413, 422, 429])('keeps HTTP %i non-success ambiguous and does not retry', async status => {
    fetchMock.mockResolvedValueOnce(response({ error: KEY }, status));
    const error = await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN');
    expect(error).toBeInstanceOf(VideoDispatchError);
    expect(error).toMatchObject({ requestId: BILLING_ID, definitelyRejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 422])('classifies an explicit V3 unsupported-spec HTTP %i without exposing supplier bodies', async status => {
    fetchMock.mockResolvedValueOnce(response({ error: { code: 'unsupported_parameter', message: KEY,
      url: 'https://private.invalid/?secret=private-value', body: inputV3().creativeBrief } }, status));
    const error = await errorOf(adapter.submit(CONNECTION, inputV3(), 'minimax-h3', [], 'client-v3', 'price-1'), 'UPSTREAM_SPEC_UNSUPPORTED');
    expect(error).toMatchObject({ definitelyRejected: false, specUnsupported: true, requestId: BILLING_ID });
    expect(error.getResponse()).toMatchObject({ error: { source: 'upstream', stage: 'submit', retryable: false,
      submissionState: 'unknown', billingState: 'reconciling' } });
    expect(JSON.stringify(error.getResponse())).not.toMatch(/private.invalid|private-value|ceramic/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 400, code: 'unknown_error' }, { status: 422, code: 'invalid_request' },
    { status: 429, code: 'unsupported_spec' },
  ])('does not infer V3 specification rejection from an unrecognized HTTP response: $status $code', async ({ status, code }) => {
    fetchMock.mockResolvedValueOnce(response({ error: { code } }, status));
    const error = await errorOf(adapter.submit(CONNECTION, inputV3(), 'minimax-h3', [], 'client-v3', 'price-1'), 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ definitelyRejected: false, specUnsupported: false });
  });

  it('releases only a relay-marked pre-dispatch price rejection, never an unmarked supplier conflict', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { code: 'video_pricing_changed' } }, 409,
      { 'X-Video-Dispatch': 'rejected' }));
    const error = await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'UPSTREAM_FAILED');
    expect(error).toMatchObject({ definitelyRejected: true, requestId: BILLING_ID });
    for (const headers of [{}, { 'X-Video-Dispatch': 'accepted' }]) {
      fetchMock.mockResolvedValueOnce(response({ error: { code: 'video_pricing_changed' } }, 409, headers));
      expect(await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN'))
        .toMatchObject({ definitelyRejected: false });
    }
    fetchMock.mockResolvedValueOnce(response({ error: { code: 'supplier_error' } }, 409, { 'X-Video-Dispatch': 'rejected' }));
    expect(await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN'))
      .toMatchObject({ definitelyRejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['', 'price\r\nsecret', 'x'.repeat(129)])('rejects a missing or unsafe frozen price version before dispatch', async version => {
    await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', version), 'PRICE_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([302, 408, 500, 502, 503])('treats HTTP %i as unknown without redispatch', async status => {
    fetchMock.mockResolvedValueOnce(response({ error: KEY }, status));
    const error = await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: BILLING_ID, definitelyRejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats network failure as unknown and never retries the POST', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket failed ' + KEY));
    const error = await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN');
    expect(error).toMatchObject({ requestId: null, definitelyRejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ model: 'minimax-m3' }, { task_id: 'different-task' }, { id: '../private' }, { status: 'unknown' }, {}])(
    'treats invalid submission response as unknown without retry %#', async patch => {
      fetchMock.mockResolvedValueOnce(response(Object.keys(patch).length ? task(patch) : {}));
      await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

  it.each([null, '', 'space id', 'duplicate, duplicate', 'x'.repeat(251)])('does not substitute supplier IDs for invalid billing correlation %#', async header => {
    const upstream = response(task(), 200, { 'X-Request-ID': 'supplier-id' });
    if (header === null) upstream.headers.delete('X-Client-Request-ID'); else upstream.headers.set('X-Client-Request-ID', header);
    fetchMock.mockResolvedValueOnce(upstream);
    const error = await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN');
    expect(error.requestId).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains billing correlation after malformed JSON or a broken response stream', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{broken', { headers: { 'Content-Type': 'application/json', 'X-Client-Request-ID': 'server-request-1' } }));
    expect(await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN')).toMatchObject({ requestId: BILLING_ID });
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ pull(c) { c.error(new Error(KEY)); } }), {
      headers: { 'Content-Type': 'application/json', 'X-Client-Request-ID': 'server-request-1' },
    }));
    expect(await errorOf(adapter.submit(CONNECTION, input(), 'minimax-h3', [], 'client-1', 'price-1'), 'SUBMISSION_UNKNOWN')).toMatchObject({ requestId: BILLING_ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['queued', 'in_progress', 'completed', 'failed', 'cancelled'])('queries original task status %s using GET only', async status => {
    fetchMock.mockResolvedValueOnce(response(task({ status })));
    expect(await adapter.query(CONNECTION, TASK_ID, 'minimax-h3')).toMatchObject({ id: TASK_ID, status });
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/videos/' + TASK_ID);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ id: 'another' }, { task_id: 'another' }, { model: 'minimax-m3' }])('rejects task identity mismatch %#', async patch => {
    fetchMock.mockResolvedValueOnce(response(task(patch)));
    await errorOf(adapter.query(CONNECTION, TASK_ID, 'minimax-h3'), 'UPSTREAM_FAILED');
  });

  it.each(['..', '.', '../task', 'task?url=private', 'task/private'])('rejects unsafe task IDs before GET %s', async taskId => {
    await errorOf(adapter.query(CONNECTION, taskId, 'minimax-h3'), 'UPSTREAM_FAILED');
    await errorOf(adapter.rawContent(CONNECTION, taskId), 'OUTPUT_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['video/mp4', 'application/octet-stream'])('streams allowed content %s and hides upstream headers', async mime => {
    fetchMock.mockResolvedValueOnce(new Response('video-bytes', { headers: { 'Content-Type': mime, 'Content-Length': '11', 'X-Private': KEY } }));
    const content = await adapter.rawContent(CONNECTION, TASK_ID);
    expect(content.headers.get('X-Private')).toBeNull();
    expect(await content.text()).toBe('video-bytes');
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/videos/' + TASK_ID + '/content');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  });

  it.each([
    { 'Content-Type': 'text/html' }, { 'Content-Type': 'application/json' },
    { 'Content-Length': String(256 * 1024 * 1024 + 1) }, { 'Content-Length': '-1' }, { 'Content-Length': '0' },
  ])('rejects wrong MIME or excessive length and cancels the body %#', async headers => {
    const upstream = new Response('private video bytes', { headers: { 'Content-Type': 'video/mp4', ...headers } });
    const cancel = jest.spyOn(upstream.body!, 'cancel');
    fetchMock.mockResolvedValueOnce(upstream);
    await errorOf(adapter.rawContent(CONNECTION, TASK_ID), 'OUTPUT_FAILED');
    expect(cancel).toHaveBeenCalled();
  });

  it('enforces streaming cap when Content-Length is absent without buffering the file', async () => {
    const chunk = new Uint8Array(1024 * 1024); let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls <= 257) c.enqueue(chunk); else c.close(); } });
    const cancel = jest.fn();
    // A real stream with a cancel hook verifies that exceeding the bound stops the source.
    const boundedSource = new ReadableStream<Uint8Array>({
      pull: async c => { const part = await source.read(); if (part.done) c.close(); else c.enqueue(part.value); },
      cancel,
    });
    const source = upstream.getReader();
    fetchMock.mockResolvedValueOnce(new Response(boundedSource, { headers: { 'Content-Type': 'video/mp4' } }));
    const result = await adapter.rawContent(CONNECTION, TASK_ID);
    const reader = result.body!.getReader();
    let total = 0;
    const consume = async () => { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; } };
    await errorOf(consume(), 'OUTPUT_FAILED');
    expect(total).toBe(256 * 1024 * 1024); expect(cancel).toHaveBeenCalled();
    await source.cancel(); source.releaseLock(); reader.releaseLock();
  });

  it('rejects truncated content and redacts failures that happen after headers', async () => {
    fetchMock.mockResolvedValueOnce(new Response('short', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '20' } }));
    const content = await adapter.rawContent(CONNECTION, TASK_ID);
    await errorOf(content.arrayBuffer(), 'OUTPUT_FAILED');
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ pull(c) { c.error(new Error(KEY)); } }), { headers: { 'Content-Type': 'video/mp4' } }));
    const broken = await adapter.rawContent(CONNECTION, TASK_ID);
    await errorOf(broken.arrayBuffer(), 'OUTPUT_FAILED');
  });

  it('propagates caller cancellation to the source', async () => {
    const cancel = jest.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'video/mp4' } }));
    const content = await adapter.rawContent(CONNECTION, TASK_ID);
    await content.body!.cancel(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('redacts cancellation failures and rejects unsolicited partial files', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { throw new Error(KEY); } }), {
      headers: { 'Content-Type': 'video/mp4' },
    }));
    const content = await adapter.rawContent(CONNECTION, TASK_ID);
    await errorOf(content.body!.cancel(), 'OUTPUT_FAILED');
    fetchMock.mockResolvedValueOnce(new Response('partial', { status: 206, headers: { 'Content-Type': 'video/mp4' } }));
    await errorOf(adapter.rawContent(CONNECTION, TASK_ID), 'OUTPUT_FAILED');
  });

  it('rejects redirects and oversized or non-JSON metadata without leaking response bodies', async () => {
    fetchMock.mockResolvedValueOnce(response({ private: KEY }, 302, { Location: 'https://private.example.test' }));
    await errorOf(adapter.rawContent(CONNECTION, TASK_ID), 'OUTPUT_FAILED');
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
    await errorOf(adapter.pricing(CONNECTION, input(), 'minimax-h3'), 'PRICE_UNAVAILABLE');
    fetchMock.mockResolvedValueOnce(response({ private: KEY }, 200, { 'Content-Type': 'text/html' }));
    await errorOf(adapter.usage(CONNECTION, BILLING_ID), 'BILLING_PENDING');
  });
});
