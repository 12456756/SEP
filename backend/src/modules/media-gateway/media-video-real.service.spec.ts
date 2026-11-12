import { HttpException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { createHash } from 'node:crypto';
import { Sub2apiVideoAdapter, VideoDispatchError } from './sub2api-video.adapter';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { capabilities, fingerprint, input, outputMetadata, scope, videoBytes, videoClaims, videoRealPrisma } from './media-video-real.test-support';
import { MediaVideoGatewayQuoteRequestV3Schema } from '../../shared/media-video.dto';

const code = (value: string) => ({ response: { error: { code: value } } });
describe('MediaVideoRealService', () => {
  let db: ReturnType<typeof videoRealPrisma>;
  let store: MediaVideoRealStore;
  let service: MediaVideoRealService;
  let enabled: boolean;
  let adapter: { connection: jest.Mock; pricing: jest.Mock; submit: jest.Mock; query: jest.Mock; rawContent: jest.Mock; usage: jest.Mock };
  let cache: { saveReference: jest.Mock; readReference: jest.Mock; saveOutput: jest.Mock; readOutput: jest.Mock; streamOutput: jest.Mock };
  let billing: { quoteFunding: jest.Mock; reserve: jest.Mock; release: jest.Mock; status: jest.Mock; settleVideo: jest.Mock };
  let runtime: { getRuntimeVideo: jest.Mock };
  let usdRate: string;
  beforeEach(() => {
    db = videoRealPrisma(); store = new MediaVideoRealStore(db as never); enabled = true;
    usdRate = '7';
    const connection = { base: 'https://relay.invalid/v1', key: 'secret-never-persist', fingerprint };
    adapter = {
      connection: jest.fn(async () => connection),
      pricing: jest.fn(async () => ({ object: 'sub2api.video_pricing', model: 'minimax-h3', operation: 'text-to-video',
        resolution: '720p', duration_seconds: 4, pricing_status: 'quoted', amount_usd: '0.2', pricing_version: 'pricing-1',
        expires_at: new Date(Date.now() + 60_000).toISOString() })),
      submit: jest.fn(async () => ({ taskId: 'task-original', requestId: 'client:original', status: 'queued' })),
      query: jest.fn(async () => ({ id: 'task-original', model: 'minimax-h3', status: 'completed' })),
      rawContent: jest.fn(async () => new Response(videoBytes, { headers: { 'Content-Type': 'video/mp4' } })),
      usage: jest.fn(async () => ({ object: 'sub2api.video_request_usage', request_id: 'client:original', status: 'settled',
        model: 'minimax-h3', actual_cost_usd: '0.1', video_count: 1, duration_seconds: 4, resolution: '720p' })),
    };
    cache = { saveReference: jest.fn(), readReference: jest.fn(async () => Buffer.from(MEDIA_MOCK_PNG)),
      saveOutput: jest.fn(async () => ({ ...outputMetadata, durationSeconds: 4.458333, width: 1344, height: 768, hasAudio: true })),
      readOutput: jest.fn(async () => Buffer.from(videoBytes)),
      streamOutput: jest.fn(async () => ({ metadata: { ...outputMetadata, durationSeconds: 4.458333, width: 1344, height: 768, hasAudio: true }, stream: Readable.from(videoBytes) })) };
    billing = {
      quoteFunding: jest.fn(async () => ({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' })),
      reserve: jest.fn(async (_claims, receiptId) => { db.state.reservations.set(receiptId, { receiptId, status: 'RESERVED', updatedAt: new Date() }); }),
      release: jest.fn(async receiptId => { db.state.reservations.get(receiptId).status = 'RELEASED'; }),
      status: jest.fn(async receiptId => db.state.reservations.get(receiptId)?.status ?? 'RESERVED'),
      settleVideo: jest.fn(async (receiptId, settledCny) => { Object.assign(db.state.reservations.get(receiptId), { status: 'SETTLED', settledCny }); return 'SETTLED'; }),
    };
    runtime = { getRuntimeVideo: jest.fn(async () => ({ protocolVersion: 1, executionAvailable: true, executionMode: 'real',
      profiles: [{ profileId: input.profileId, configVersion: input.configVersion, displayName: 'H3', kind: 'video',
        operations: ['text-to-video', 'image-to-video'], executionMode: 'async-query', capabilities }] })) };
    service = new MediaVideoRealService({ get: () => enabled ? 'true' : 'false' } as never, db as never,
      { getEffectiveValue: async () => usdRate } as never, runtime as never, adapter as never, cache as never, billing as never, store);
  });

  async function quotedSubmit(clientRequestId = 'client-1') {
    const quote = await service.quote(videoClaims, input);
    const request = { ...input, clientRequestId, quoteId: quote.quoteId };
    return { request, receipt: await service.submit(videoClaims, request) };
  }

  it.each([
    { label: 'equivalent ratio and one-frame container rounding', spec: { aspectRatio: '2:2' },
      measured: { durationSeconds: 8 + 1 / 30 }, deliveryStatus: 'matched' },
    { label: 'named resolution without a measured mapping', spec: { resolution: 'cinema' },
      measured: {}, deliveryStatus: 'unknown' },
    { label: 'unmeasured audio', spec: {}, measured: { hasAudio: null }, deliveryStatus: 'unknown' },
    { label: 'missing requested audio', spec: { audio: true }, measured: { hasAudio: false }, deliveryStatus: 'mismatched' },
    { label: 'duration beyond one frame', spec: {}, measured: { durationSeconds: 8.05 }, deliveryStatus: 'mismatched' },
    { label: 'upstream-selected 24 fps despite requested 30 fps', spec: {}, measured: { frameRate: 24 }, deliveryStatus: 'matched' },
    { label: 'upstream-selected 25 fps despite requested 30 fps', spec: {}, measured: { frameRate: 25 }, deliveryStatus: 'matched' },
    { label: 'upstream-selected 29.97 fps despite requested 30 fps', spec: {}, measured: { frameRate: 30000 / 1001 }, deliveryStatus: 'matched' },
    { label: 'one-frame duration rounding uses measured fps', spec: {},
      measured: { frameRate: 24, durationSeconds: 8 + 1 / 24 }, deliveryStatus: 'matched' },
    { label: 'measured rational frame rate', spec: { frameRate: 30000 / 1001 },
      measured: { frameRate: 29.97002997 }, deliveryStatus: 'matched' },
    { label: 'mismatch takes precedence over unspecified audio', spec: { audio: undefined },
      measured: { durationSeconds: 15 }, deliveryStatus: 'mismatched' },
  ])('evaluates measured V3 delivery: $label', async ({ spec, measured, deliveryStatus }) => {
    const value = MediaVideoGatewayQuoteRequestV3Schema.parse({ protocolVersion: 3,
      profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
      referenceIds: [], creativeBrief: 'V3 square product scene', specRevision: 1,
      requestedSpec: { durationSeconds: 8, resolution: '720p', aspectRatio: '1:1', frameRate: 30,
        audio: false, outputFormat: 'video/mp4', ...spec } });
    Object.assign(runtime, { getRuntimeVideoV3: jest.fn(async () => ({ protocolVersion: 3,
      executionAvailable: true, executionMode: 'real', profiles: [{ profileId: input.profileId,
        configVersion: input.configVersion, operations: ['text-to-video'], authorized: true,
        adapter: { available: true, operations: ['text-to-video'] } }] })) });
    adapter.pricing.mockImplementation(async () => ({ model: 'minimax-h3', operation: input.operation,
      resolution: value.requestedSpec.resolution, duration_seconds: 8, pricing_status: 'quoted', amount_usd: '0.2',
      pricing_version: 'v3-pricing', expires_at: new Date(Date.now() + 60_000).toISOString() }));
    adapter.usage.mockImplementation(async () => ({ request_id: 'client:original', status: 'settled',
      model: 'minimax-h3', actual_cost_usd: '0.1', video_count: 1, duration_seconds: 8,
      resolution: value.requestedSpec.resolution }));
    Object.assign(billing, { settleNegotiated: billing.settleVideo });
    const actual = { ...outputMetadata, durationSeconds: 8, width: 720, height: 720,
      frameRate: 30, hasAudio: false, ...measured };
    cache.saveOutput.mockResolvedValue(actual);
    const quote = await service.quote(videoClaims, value);
    const pending = await service.submit(videoClaims, { ...value, clientRequestId: 'v3-delivery', quoteId: quote.quoteId });
    expect(pending).toMatchObject({ protocolVersion: 3, status: 'QUEUED', deliveryStatus: 'unknown' });
    expect(pending).not.toHaveProperty('actualSpec');
    const done = await service.receipt(videoClaims, pending.receiptId);
    expect(done).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', deliveryStatus,
      actualSpec: { durationSeconds: actual.durationSeconds, width: 720, height: 720, frameRate: actual.frameRate, hasAudio: actual.hasAudio },
      outputs: [{ frameRate: actual.frameRate }] });
    expect(done.errorCode).toBe(deliveryStatus === 'mismatched' ? 'OUTPUT_SPEC_MISMATCH' : null);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(billing.settleVideo).toHaveBeenCalledWith(pending.receiptId, '0.700000', '0.100000', 'minimax-h3', 'minimax-h3');
    cache.streamOutput.mockResolvedValueOnce({ metadata: actual, stream: Readable.from(videoBytes) });
    await expect(service.content(videoClaims, done.receiptId, done.outputs[0].outputId)).resolves.toMatchObject({ output: done.outputs[0] });
    const tampered = Readable.from(videoBytes);
    cache.streamOutput.mockResolvedValueOnce({ metadata: { ...actual, hasAudio: actual.hasAudio !== true }, stream: tampered });
    await expect(service.content(videoClaims, done.receiptId, done.outputs[0].outputId)).rejects.toMatchObject({ status: 502 });
    expect(tampered.destroyed).toBe(true);
    const tamperedFrameRate = Readable.from(videoBytes);
    cache.streamOutput.mockResolvedValueOnce({ metadata: { ...actual, frameRate: actual.frameRate + 1 }, stream: tamperedFrameRate });
    await expect(service.content(videoClaims, done.receiptId, done.outputs[0].outputId)).rejects.toMatchObject({ status: 502 });
    expect(tamperedFrameRate.destroyed).toBe(true);
  });

  it('persists an explicit V3 upstream spec rejection without releasing funds or repeating dispatch', async () => {
    const value = MediaVideoGatewayQuoteRequestV3Schema.parse({ protocolVersion: 3,
      profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
      referenceIds: [], creativeBrief: 'Private V3 scene', specRevision: 1,
      requestedSpec: { durationSeconds: 4, resolution: '720p', audio: false } });
    Object.assign(runtime, { getRuntimeVideoV3: jest.fn(async () => ({ protocolVersion: 3,
      executionAvailable: true, executionMode: 'real', profiles: [{ profileId: input.profileId,
        configVersion: input.configVersion, operations: ['text-to-video'], authorized: true,
        adapter: { available: true, operations: ['text-to-video'] } }] })) });
    adapter.submit.mockRejectedValue(new VideoDispatchError('client:original', false, true));
    const quote = await service.quote(videoClaims, value);
    const request = { ...value, clientRequestId: 'v3-rejected-spec', quoteId: quote.quoteId };
    const receipt = await service.submit(videoClaims, request);
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', errorCode: 'UPSTREAM_SPEC_UNSUPPORTED',
      billingStatus: 'RECONCILING' });
    expect(db.state.requests.get(receipt.receiptId).receipt.errorCode).toBe('UPSTREAM_SPEC_UNSUPPORTED');
    adapter.usage.mockResolvedValue({ request_id: 'client:original', status: 'pending' });
    await expect(service.submit(videoClaims, request)).resolves.toMatchObject({
      errorCode: 'UPSTREAM_SPEC_UNSUPPORTED', billingStatus: 'RECONCILING' });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('freezes customer price/rate/funding and never persists prompts, keys or supplier URLs', async () => {
    const quote = await service.quote(videoClaims, input);
    expect(quote).toMatchObject({ mock: false, amountCny: '1.400000', amountUsd: '0.2', usdToCnyRate: 7, billingStatus: 'NOT_RESERVED' });
    const raw = JSON.stringify([...db.state.quotes.values()]);
    expect(raw).not.toContain(input.creativeBrief);
    expect(raw).not.toContain('secret-never-persist');
    expect(raw).not.toContain('https://');
    expect(billing.reserve).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it('converts the Sub2 customer quote once using the frozen SEP exchange rate', async () => {
    usdRate = '7.2';
    adapter.pricing.mockResolvedValue({ model: 'minimax-h3', operation: input.operation,
      resolution: '720p', duration_seconds: 4, pricing_status: 'quoted', amount_usd: '4.0000000000',
      pricing_version: 'pricing-1', expires_at: new Date(Date.now() + 60_000).toISOString() });
    const quote = await service.quote(videoClaims, input);
    expect(quote).toMatchObject({ amountUsd: '4.0000000000', amountCny: '28.800000', usdToCnyRate: 7.2 });
    expect(db.state.quotes.get(quote.quoteId).metadata.configuration).toMatchObject({ amountUsd: '4.0000000000', amountCny: '28.800000', usdToCnyRate: 7.2 });
  });

  it('lists only real runtime profiles and never enables the mock branch', async () => {
    await expect(service.profiles(videoClaims)).resolves.toMatchObject({ mock: false, profiles: [{ profileId: input.profileId }] });
    runtime.getRuntimeVideo.mockResolvedValue({ executionAvailable: true, executionMode: 'mock', profiles: [] });
    await expect(service.profiles(videoClaims)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
  });

  it('returns V3 adapter unavailability separately from missing authorization', async () => {
    const profile = { profileId: input.profileId, authorized: true,
      adapter: { available: false, reason: 'CONNECTION_UNAVAILABLE' }, unavailableReason: 'CONNECTION_UNAVAILABLE' };
    const getRuntimeVideoV3 = jest.fn(async () => ({ protocolVersion: 3, executionMode: 'disabled',
      executionAvailable: false, profiles: [profile] }));
    Object.assign(runtime, { getRuntimeVideoV3 });
    await expect(service.profiles(videoClaims, 3)).resolves.toMatchObject({ protocolVersion: 3, profiles: [profile] });
    getRuntimeVideoV3.mockResolvedValueOnce({ protocolVersion: 3, executionMode: 'disabled', executionAvailable: false, profiles: [] });
    await expect(service.profiles(videoClaims, 3)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
  });

  it.each(['text-to-video', 'image-to-video'] as const)(
    'passes the strict adapter contract and sends exactly one %s HTTP submission', async operation => {
      const connection = { base: 'https://relay.invalid/v1', key: 'private-test-key', fingerprint: '' };
      connection.fingerprint = createHash('sha256').update(connection.base + '\0' + connection.key).digest('hex');
      adapter.connection.mockResolvedValue(connection);
      const realAdapter = new Sub2apiVideoAdapter({} as never);
      adapter.submit.mockImplementation(realAdapter.submit.bind(realAdapter));
      const quoteInput = { ...input, operation, referenceIds: [] as string[] };
      if (operation === 'image-to-video') {
        const reference = await store.saveReference(scope, { mock: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), mimeType: 'image/png',
          sha256: createHash('sha256').update(MEDIA_MOCK_PNG).digest('hex'),
          byteLength: MEDIA_MOCK_PNG.length, width: 1, height: 1 });
        quoteInput.referenceIds = [reference.referenceId];
      }
      adapter.pricing.mockImplementation(async () => ({ model: 'minimax-h3', operation,
        resolution: '720p', duration_seconds: 4, pricing_status: 'quoted', amount_usd: '0.2',
        pricing_version: 'pricing-1', expires_at: new Date(Date.now() + 60_000).toISOString() }));
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        object: 'video', id: 'task-original', model: 'minimax-h3', status: 'queued',
      }), { headers: { 'Content-Type': 'application/json', 'X-Client-Request-ID': 'relay-original' } }));
      try {
        const quote = await service.quote(videoClaims, quoteInput);
        const request = { ...quoteInput, quoteId: quote.quoteId, clientRequestId: 'full-client-request' };
        const receipt = await service.submit(videoClaims, request);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(connection.base + '/videos');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
        expect(receipt).toMatchObject({ status: 'QUEUED', billingStatus: 'RESERVED' });
        await service.submit(videoClaims, request);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally { fetchMock.mockRestore(); }
    });

  it('persists reservation/dispatch marker before exactly one concurrent POST', async () => {
    const quote = await service.quote(videoClaims, input);
    const request = { ...input, quoteId: quote.quoteId, clientRequestId: 'same-key' };
    adapter.submit.mockImplementation(async () => {
      const [row] = [...db.state.requests.values()];
      expect(row.configuration.dispatchState).toBe('DISPATCHING');
      expect(row.receipt.billingStatus).toBe('RESERVED');
      expect(db.state.reservations.get(row.id).status).toBe('RESERVED');
      return { taskId: 'task-original', requestId: 'client:original', status: 'queued' };
    });
    await Promise.all([service.submit(videoClaims, request), service.submit(videoClaims, request)]);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(billing.reserve).toHaveBeenCalledTimes(1);
    const [record] = [...db.state.requests.values()];
    expect(record.configuration).toMatchObject({ upstreamTaskId: 'task-original', upstreamRequestId: 'client:original' });
    expect(adapter.submit).toHaveBeenCalledWith(expect.objectContaining({ fingerprint }), input, 'minimax-h3', [],
      'same-key', record.configuration.pricingVersion);
  });

  it('downloads validated original content before success and settles matching evidence with frozen rate', async () => {
    const { receipt } = await quotedSubmit();
    expect(receipt.status).toBe('QUEUED');
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    expect(completed).toMatchObject({ status: 'SUCCEEDED', mock: false, billingStatus: 'SETTLED', actualCostCny: '0.700000',
      outputs: [{ outputId: `${receipt.receiptId}-output-1`, ...outputMetadata, durationSeconds: 4.458333, width: 1344, height: 768 }] });
    expect(adapter.query).toHaveBeenCalledWith(expect.objectContaining({ fingerprint }), 'task-original', 'minimax-h3');
    expect(cache.saveOutput).toHaveBeenCalledWith(scope, `${receipt.receiptId}-output-1`, expect.any(Response), expect.any(String));
    expect(billing.settleVideo).toHaveBeenCalledWith(receipt.receiptId, '0.700000', '0.100000', 'minimax-h3');
    const download = await service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(videoBytes);
    expect(cache.readOutput).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(completed.outputs[0]).not.toHaveProperty('hasAudio');
  });

  it('accepts measured native 720p metadata without rewriting it to 768P', async () => {
    cache.saveOutput.mockResolvedValue({ ...outputMetadata, hasAudio: true });
    const { receipt } = await quotedSubmit();
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUCCEEDED',
      outputs: [{ width: 1280, height: 720, durationSeconds: 4, frameRate: 24 }] });
  });

  it.each([{ width: 1280, height: 720 }, { width: 1344, height: 768 }])(
    'delivers observed 15s H3 output %j with unchanged frozen billing', async dimensions => {
      cache.saveOutput.mockResolvedValue({ ...outputMetadata, ...dimensions, durationSeconds: 15, hasAudio: true });
      const { receipt } = await quotedSubmit();
      const completed = await service.receipt(videoClaims, receipt.receiptId);
      expect(completed).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED',
        outputs: [{ durationSeconds: 15, ...dimensions }] });
      const [record] = [...db.state.requests.values()];
      expect(record.configuration.parameters.durationSeconds).toBe(4);
      expect(billing.settleVideo).toHaveBeenCalledWith(receipt.receiptId, '0.700000', '0.100000', 'minimax-h3');
      await service.receipt(videoClaims, receipt.receiptId);
      expect(adapter.submit).toHaveBeenCalledTimes(1);
      expect(billing.settleVideo).toHaveBeenCalledTimes(1);
    });

  it.each([false, undefined])('does not deliver an audio-required output with hasAudio=%s', async hasAudio => {
    cache.saveOutput.mockResolvedValue({ ...outputMetadata, hasAudio });
    const { receipt } = await quotedSubmit();
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'QUEUED',
      outputs: [], errorCode: 'OUTPUT_FAILED', recovery: { canDownload: false } });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { width: 1080, height: 1920 }, { width: 1360, height: 768 }, { frameRate: 30 }, { durationSeconds: 6 },
    { durationSeconds: 0 }, { durationSeconds: 14 }, { durationSeconds: 16 },
  ])('rejects unrecognized measured output specs %j', async metadata => {
    cache.saveOutput.mockResolvedValue({ ...outputMetadata, hasAudio: true, ...metadata });
    const { receipt } = await quotedSubmit();
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'QUEUED',
      outputs: [], errorCode: 'OUTPUT_FAILED', recovery: { canDownload: false } });
  });

  it.each([false, undefined])('checks cached audio evidence before streaming hasAudio=%s', async hasAudio => {
    const { receipt } = await quotedSubmit();
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    const stream = Readable.from(videoBytes);
    cache.streamOutput.mockResolvedValue({ metadata: { ...completed.outputs[0], hasAudio }, stream });
    await expect(service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId)).rejects.toMatchObject(code('OUTPUT_FAILED'));
    expect(stream.destroyed).toBe(true);
  });

  it('recovers original jobs after execution is disabled and never starts new jobs', async () => {
    const { receipt, request } = await quotedSubmit();
    enabled = false;
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(service.findByClientId(videoClaims, request.clientRequestId)).resolves.toMatchObject({ receiptId: receipt.receiptId });
    await expect(service.submit(videoClaims, request)).resolves.toMatchObject({ receiptId: receipt.receiptId });
    await expect(service.quote(videoClaims, input)).rejects.toMatchObject(code('MEDIA_REAL_DISABLED'));
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('preserves UNKNOWN and frozen funds after lost submit response; replay never resubmits', async () => {
    adapter.submit.mockRejectedValue(new VideoDispatchError('client:original', false));
    adapter.usage.mockResolvedValue({ request_id: 'client:original', status: 'pending', actual_cost_usd: null });
    const { receipt, request } = await quotedSubmit();
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING' });
    await expect(service.submit(videoClaims, request)).resolves.toMatchObject({ status: 'SUBMISSION_UNKNOWN' });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(adapter.query).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('can settle original bill without inventing a task ID or a deliverable', async () => {
    adapter.submit.mockRejectedValue(new VideoDispatchError('client:original', false));
    const { receipt } = await quotedSubmit();
    const recovered = await service.receipt(videoClaims, receipt.receiptId);
    expect(recovered).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'SETTLED', outputs: [] });
    expect(adapter.rawContent).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('releases only a definitely rejected unsubmitted task', async () => {
    adapter.submit.mockRejectedValue(new VideoDispatchError('client:original', true));
    const { receipt } = await quotedSubmit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED' });
    expect(billing.release).toHaveBeenCalledTimes(1);
    expect(adapter.submit.mock.calls[0].at(-1)).toBe('pricing-1');
    expect(billing.settleVideo).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])('does not download or refund a %s task and keeps pending billing queryable', async status => {
    const { receipt } = await quotedSubmit();
    db.state.requests.get(receipt.receiptId).configuration.outputExpiresAt = new Date(Date.now() - 1000).toISOString();
    adapter.query.mockResolvedValue({ id: 'task-original', model: 'minimax-h3', status });
    adapter.usage.mockResolvedValue({ request_id: 'client:original', status: 'pending', actual_cost_usd: null });
    const result = await service.receipt(videoClaims, receipt.receiptId);
    expect(result).toMatchObject({ status: status.toUpperCase(), pollAfterMs: null, billingStatus: 'RECONCILING', recovery: { canQuery: true, canDownload: false } });
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: status.toUpperCase(), billingStatus: 'RECONCILING' });
    expect(adapter.query).toHaveBeenCalledTimes(1);
    expect(adapter.rawContent).not.toHaveBeenCalled();
    expect(cache.saveOutput).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
    expect(billing.settleVideo).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])('settles a %s task only after exact original usage evidence', async status => {
    const { receipt } = await quotedSubmit();
    adapter.query.mockResolvedValue({ id: 'task-original', model: 'minimax-h3', status });
    const usage = await adapter.usage();
    adapter.usage.mockResolvedValue({ ...usage, video_count: 2 });
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: status.toUpperCase(),
      billingStatus: 'RECONCILING', recovery: { canQuery: true } });
    expect(billing.settleVideo).not.toHaveBeenCalled();
    adapter.usage.mockResolvedValue(usage);
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: status.toUpperCase(),
      billingStatus: 'SETTLED', pollAfterMs: null, recovery: { canQuery: false, canDownload: false } });
    expect(billing.settleVideo).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
    expect(adapter.rawContent).not.toHaveBeenCalled();
  });

  it('does not call upstream after reservation failure', async () => {
    billing.reserve.mockRejectedValue(new HttpException({ error: { code: 'INSUFFICIENT_FUNDS' } }, 402));
    await expect(quotedSubmit()).rejects.toMatchObject(code('INSUFFICIENT_FUNDS'));
    expect(adapter.submit).not.toHaveBeenCalled();
    expect([...db.state.requests.values()][0].receipt).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_RESERVED' });
  });

  it('leaves unknown reservation outcomes frozen and never submits', async () => {
    billing.reserve.mockRejectedValue(new Error('database response lost'));
    const { receipt } = await quotedSubmit();
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING' });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('recovers and releases a committed reservation whose response was lost before dispatch', async () => {
    billing.reserve.mockImplementation(async (_claims, receiptId) => {
      db.state.reservations.set(receiptId, { receiptId, status: 'RESERVED' });
      throw new Error('reserve response lost');
    });
    const { receipt } = await quotedSubmit();
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', billingStatus: 'RECONCILING' });
    const row = db.state.requests.get(receipt.receiptId);
    expect(row.configuration.dispatchState).toBe('NOT_DISPATCHED');
    row.submissionDeadline = new Date(Date.now() - 1000);
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      recovery: { canQuery: false } });
    expect(billing.release).toHaveBeenCalledTimes(1);
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.connection).toHaveBeenCalledTimes(2);
  });

  it('does not release an ambiguously settled undispatched reservation', async () => {
    billing.reserve.mockImplementation(async (_claims, receiptId) => {
      db.state.reservations.set(receiptId, { receiptId, status: 'SETTLED', settledCny: '0.700000' });
      throw new Error('reserve evidence conflicts');
    });
    const { receipt } = await quotedSubmit();
    db.state.requests.get(receipt.receiptId).submissionDeadline = new Date(Date.now() - 1000);
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING',
      recovery: { canQuery: true } });
    expect(billing.release).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it('marks overdue dispatch with no returned IDs UNKNOWN without reposting or refunding', async () => {
    const { receipt } = await quotedSubmit();
    const row = db.state.requests.get(receipt.receiptId);
    Object.assign(row.configuration, { upstreamTaskId: null, upstreamRequestId: null, dispatchState: 'DISPATCHING' });
    row.receipt.status = row.status = 'SUBMITTING'; row.submissionDeadline = new Date(Date.now() - 1000);
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUBMISSION_UNKNOWN',
      billingStatus: 'RECONCILING', outputs: [] });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('preserves a second original task but cannot attach or settle a reused upstream bill', async () => {
    const first = await quotedSubmit('first');
    adapter.submit.mockResolvedValue({ taskId: 'task-second', requestId: 'client:original', status: 'queued' });
    const second = await quotedSubmit('second');
    const row = db.state.requests.get(second.receipt.receiptId);
    expect(row.configuration).toMatchObject({ upstreamTaskId: 'task-second', upstreamRequestId: null, dispatchState: 'ACCEPTED' });
    expect(second.receipt).toMatchObject({ status: 'QUEUED', billingStatus: 'RECONCILING' });
    adapter.query.mockResolvedValue({ id: 'task-second', model: 'minimax-h3', status: 'failed' });
    await expect(service.receipt(videoClaims, second.receipt.receiptId)).resolves.toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING' });
    expect(adapter.usage).not.toHaveBeenCalled();
    expect(billing.settleVideo).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
    expect(db.state.requests.get(first.receipt.receiptId).configuration.upstreamRequestId).toBe('client:original');
  });

  it.each([
    ['model', 'different-model'], ['duration_seconds', 5], ['resolution', '1080p'],
    ['video_count', 2], ['request_id', 'client:another'],
  ])('does not settle mismatched %s evidence', async (field, value) => {
    const { receipt } = await quotedSubmit();
    const usage = await adapter.usage();
    adapter.usage.mockResolvedValue({ ...usage, [field]: value });
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING' });
    expect(billing.settleVideo).not.toHaveBeenCalled();
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('refuses changed connection fingerprints while billing is pending but allows authorized cached content', async () => {
    const { receipt } = await quotedSubmit();
    adapter.usage.mockResolvedValue({ request_id: 'client:original', status: 'pending', actual_cost_usd: null });
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    expect(completed.billingStatus).toBe('RECONCILING');
    adapter.query.mockClear(); adapter.rawContent.mockClear();
    adapter.connection.mockResolvedValue({ base: 'https://other.invalid/v1', key: 'other-secret', fingerprint: 'f'.repeat(64) });
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('CONFIG_CHANGED'));
    const download = await service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId);
    download.stream.destroy();
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.rawContent).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['SETTLED', 'RELEASED'])('queries and downloads finalized %s cached results without any upstream connection', async billingStatus => {
    const { receipt, request } = await quotedSubmit();
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    db.state.requests.get(receipt.receiptId).receipt.billingStatus = billingStatus;
    adapter.connection.mockClear(); adapter.query.mockClear(); adapter.usage.mockClear(); adapter.rawContent.mockClear();
    adapter.connection.mockRejectedValue(new Error('old upstream is unavailable'));
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUCCEEDED', billingStatus,
      recovery: { canQuery: false, canDownload: true } });
    await expect(service.findByClientId(videoClaims, request.clientRequestId)).resolves.toMatchObject({ status: 'SUCCEEDED', billingStatus });
    await expect(service.submit(videoClaims, request)).resolves.toMatchObject({ status: 'SUCCEEDED', billingStatus });
    const download = await service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(videoBytes);
    expect(adapter.connection).not.toHaveBeenCalled();
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.usage).not.toHaveBeenCalled();
    expect(adapter.rawContent).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('still checks ownership and profile grants for finalized cached results', async () => {
    const { receipt } = await quotedSubmit();
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    adapter.connection.mockClear();
    db.enterpriseMember.findFirst.mockResolvedValueOnce(null);
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
    await expect(service.receipt({ ...videoClaims, memberId: 'other-member' }, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_NOT_FOUND'));
    db.state.model.enabled = false;
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('CONFIG_CHANGED'));
    await expect(service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId)).rejects.toMatchObject(code('CONFIG_CHANGED'));
    expect(adapter.connection).not.toHaveBeenCalled();
  });

  it('rechecks revoked membership, subscription and profile grants before recovery', async () => {
    const { receipt } = await quotedSubmit();
    db.enterpriseMember.findFirst.mockResolvedValueOnce(null);
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
    db.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
    db.state.enterprise.mediaPolicy.video.enabledProfileIds = [];
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_FORBIDDEN'));
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it('does not authorize another scope or replace a changed model', async () => {
    const { receipt } = await quotedSubmit();
    await expect(service.receipt({ ...videoClaims, memberId: 'other-member' }, receipt.receiptId)).rejects.toMatchObject(code('MEDIA_NOT_FOUND'));
    db.state.model.modelId = 'some-fallback-model';
    await expect(service.receipt(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('CONFIG_CHANGED'));
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it('does not report success for corrupt/mismatched completed output and retries only download', async () => {
    const { receipt } = await quotedSubmit();
    cache.saveOutput.mockRejectedValueOnce(new Error('invalid mp4'));
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'QUEUED', outputs: [], errorCode: 'OUTPUT_FAILED' });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    await expect(service.receipt(videoClaims, receipt.receiptId)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(cache.saveOutput).toHaveBeenCalledTimes(2);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('rejects expired downloads without re-generating or re-downloading upstream', async () => {
    const { receipt } = await quotedSubmit();
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    const row = db.state.requests.get(receipt.receiptId);
    row.receipt.outputs[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId)).rejects.toMatchObject(code('RESULT_EXPIRED'));
    expect(adapter.rawContent).toHaveBeenCalledTimes(1);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('does not deliver corrupted cached bytes', async () => {
    const { receipt } = await quotedSubmit();
    const completed = await service.receipt(videoClaims, receipt.receiptId);
    cache.streamOutput.mockRejectedValue(new HttpException({ error: { code: 'OUTPUT_FAILED' } }, 502));
    await expect(service.content(videoClaims, receipt.receiptId, completed.outputs[0].outputId)).rejects.toMatchObject(code('OUTPUT_FAILED'));
  });

  it('rejects cancellation without promising a refund', async () => {
    const { receipt } = await quotedSubmit();
    await expect(service.cancel(videoClaims, receipt.receiptId)).rejects.toMatchObject(code('CANCEL_UNSUPPORTED'));
    expect(billing.release).not.toHaveBeenCalled();
  });

  it('rejects unsupported specs and changed replay inputs', async () => {
    db.state.enterprise.mediaPolicy.video.maxDurationSeconds = 5;
    await expect(service.quote(videoClaims, { ...input, parameters: { ...input.parameters, durationSeconds: 5 } })).rejects.toMatchObject(code('INVALID_PARAMETER'));
    const { request } = await quotedSubmit();
    await expect(service.submit(videoClaims, { ...request, creativeBrief: 'changed' })).rejects.toMatchObject(code('IDEMPOTENCY_CONFLICT'));
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it('ignores deprecated enterprise parameter restrictions', async () => {
    db.state.enterprise.mediaPolicy.video.allowedAspectRatios = ['1:1'];
    await expect(service.quote(videoClaims, input)).resolves.toMatchObject({ mock: false });
  });
});
