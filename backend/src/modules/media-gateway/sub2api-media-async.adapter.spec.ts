import { Sub2apiImageAdapter } from './sub2api-image.adapter';
import { signedMediaProtocolStub } from '../../../test/stubs/enterprise-media.stub';
import { Sub2apiVideoAdapter } from './sub2api-video.adapter';
import { contractResult } from './longdao-media.test-support';
import { IMAGE_CREATE_TIMEOUT_MS, VIDEO_CREATE_TIMEOUT_MS } from './longdao-media-contract';
import { referenceFixture } from './media-reference.test-support';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { createHash } from 'node:crypto';

const connection = { base: 'https://relay.example.test/v1', key: 'test-media-key', fingerprint: 'a'.repeat(64), compute: { enterpriseId: 'enterprise', executionId: 'execution' } };
connection.fingerprint = createHash('sha256').update(`${connection.base}\0${connection.key}`).digest('hex');
const image = { protocolVersion: 3 as const, profileId: 'image', configVersion: 'cfg1', specRevision: 1,
  operation: 'generate' as const, referenceIds: [], creativeBrief: 'Product picture', requestedSpec: { size: '1024x1024', count: 1, quality: 'medium' } };
const video = { protocolVersion: 3 as const, profileId: 'video', configVersion: 'cfg1', specRevision: 1,
  operation: 'text-to-video' as const, referenceIds: [], creativeBrief: 'Product video', requestedSpec: { durationSeconds: 4, resolution: '720p' } };

describe('Longdao async adapters (mock fetch, no paid calls)', () => {
  let fetchMock: jest.SpyInstance;
  let timeout: jest.SpyInstance;
  const images = new Sub2apiImageAdapter({} as never, signedMediaProtocolStub as never);
  const videos = new Sub2apiVideoAdapter({} as never, signedMediaProtocolStub as never);
  const respond = (id: string, patch = {}, http = 202) => new Response(JSON.stringify(contractResult(id, patch, http).contract), {
    status: http, headers: { 'content-type': 'application/json' },
  });
  beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); timeout = jest.spyOn(AbortSignal, 'timeout'); });
  afterEach(() => jest.restoreAllMocks());

  it('uses async generation, stable request headers, URL response mode and the image timeout', async () => {
    fetchMock.mockResolvedValueOnce(respond('image-1', { status: 'processing' }));
    await images.submitAsync(image, [], 'gpt-image-2-1k', 'image-1', connection);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(connection.base + '/images/generations/async');
    expect(request).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = new Headers(request.headers);
    expect(headers.get('authorization')).toBe('Bearer test-media-key');
    expect(headers.get('x-client-request-id')).toBe('image-1'); expect(headers.get('idempotency-key')).toBe('image-1');
    expect(JSON.parse(request.body)).toEqual({ model: 'gpt-image-2-1k', prompt: image.creativeBrief, n: 1,
      size: '1024x1024', quality: 'medium', response_format: 'url' });
    expect(timeout).toHaveBeenCalledWith(IMAGE_CREATE_TIMEOUT_MS); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploads original PNG/JPEG/WebP as ordered same-name image[] fields', async () => {
    const originals = [MEDIA_MOCK_PNG, await referenceFixture('jpeg'), await referenceFixture('webp')];
    fetchMock.mockResolvedValueOnce(respond('edit-1', { status: 'processing' }));
    await images.submitAsync({ ...image, operation: 'edit', referenceIds: ['front', 'side', 'scene'] }, originals,
      'gpt-image-2-1k', 'edit-1', connection);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(connection.base + '/images/edits/async');
    const files = (request.body as FormData).getAll('image[]') as File[];
    expect(files.map(file => file.type)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    for (let i = 0; i < files.length; i++) expect(Buffer.from(await files[i].arrayBuffer())).toEqual(originals[i]);
    expect(new Headers(request.headers).has('content-type')).toBe(false);
  });

  it.each([null, 'task-original'])('recovers image by %s identity without a new POST', async task => {
    fetchMock.mockResolvedValueOnce(respond('image-1', { status: 'processing' }, 200));
    await images.queryAsync(connection, 'image-1', task);
    expect(fetchMock.mock.calls[0][0]).toBe(connection.base + '/images/tasks/' + (task ?? 'image-1?id_type=request_id'));
    expect(fetchMock.mock.calls[0][1].method).toBe('GET'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the real async image usage v2 shape without image_count', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: 'sub2api.request_usage', schema_version: 2, currency: 'USD',
      request_id: 'image-1', model: 'gpt-image-2-1k', status: 'settled', actual_cost_usd: '0.12', pending_reason: '' }), { headers: { 'content-type': 'application/json' } }));
    expect(await images.usage('image-1', connection)).toMatchObject({ schema_version: 2, status: 'settled', actual_cost_usd: '0.12' });
  });

  it.each(['png', 'jpeg', 'webp'] as const)('downloads original %s content from the protected task endpoint', async type => {
    const bytes = type === 'png' ? MEDIA_MOCK_PNG : await referenceFixture(type);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': `image/${type}` } }));
    const result = await images.contentAsync(connection, 'task-original');
    expect(result.bytes).toEqual(bytes); expect(result.metadata.mimeType).toBe(`image/${type}`);
    expect(fetchMock.mock.calls[0][0]).toBe(connection.base + '/images/tasks/task-original/content');
  });

  it('rejects MIME/signature mismatch without returning unsafe image bytes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(await referenceFixture('jpeg'), { headers: { 'content-type': 'image/png' } }));
    await expect(images.contentAsync(connection, 'task-original')).rejects.toMatchObject({ status: 400 });
  });

  it.each(['0', '20971521', 'invalid'])('rejects unsafe image content length %s before buffering', async length => {
    fetchMock.mockResolvedValueOnce(new Response(MEDIA_MOCK_PNG, { headers: { 'content-type': 'image/png', 'content-length': length } }));
    await expect(images.contentAsync(connection, 'task-original')).rejects.toMatchObject({ status: 503 });
  });

  it('rejects an incomplete image stream even when the remaining bytes form a valid image', async () => {
    fetchMock.mockResolvedValueOnce(new Response(MEDIA_MOCK_PNG, { headers: { 'content-type': 'image/png', 'content-length': String(MEDIA_MOCK_PNG.length + 1) } }));
    await expect(images.contentAsync(connection, 'task-original')).rejects.toMatchObject({ status: 503 });
  });

  it('preserves a non-2xx exhausted video receipt and never starts its own retry loop', async () => {
    fetchMock.mockResolvedValueOnce(respond('video-1', { task_id: null, submission_status: 'failed', status: null,
      billing: { status: 'not_charged', actual_cost_usd: '0' }, error: { message: 'EOF' },
      submission_retry: { attempts: 4, exhausted: true } }, 502));
    expect(await videos.submitContract(connection, video, 'seedance-2.0', [], 'video-1', 'price1')).toMatchObject({ httpStatus: 502,
      contract: { submission_status: 'failed', error: { message: 'EOF' }, submission_retry: { attempts: 4 } } });
    expect(fetchMock.mock.calls[0][0]).toBe(connection.base + '/videos');
    expect(timeout).toHaveBeenCalledWith(VIDEO_CREATE_TIMEOUT_MS); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses repeated input_reference fields for one video submission', async () => {
    const originals = [await referenceFixture('jpeg'), await referenceFixture('webp')];
    fetchMock.mockResolvedValueOnce(respond('video-1'));
    await videos.submitContract(connection, { ...video, operation: 'image-to-video', referenceIds: ['front', 'side'] },
      'seedance-2.0', originals, 'video-1', 'price1');
    const form = fetchMock.mock.calls[0][1].body as FormData;
    const files = form.getAll('input_reference') as File[];
    expect(files.map(file => file.type)).toEqual(['image/jpeg', 'image/webp']);
    for (let i = 0; i < files.length; i++) expect(Buffer.from(await files[i].arrayBuffer())).toEqual(originals[i]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers video by original request ID, then cancels by task ID using PUT', async () => {
    fetchMock.mockResolvedValueOnce(respond('video-1', {}, 200)).mockResolvedValueOnce(respond('video-1', {
      status: 'cancelled', is_final: true, billing: { status: 'not_charged', actual_cost_usd: '0' } }, 200));
    await videos.queryContract(connection, 'video-1'); await videos.cancelContract(connection, 'video-1', 'task-original');
    expect(fetchMock.mock.calls[0][0]).toBe(connection.base + '/videos/video-1?id_type=request_id');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe(connection.base + '/videos/task-original/cancel');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
  });

  it('rejects an unrelated request identity and retains the concrete response', async () => {
    fetchMock.mockResolvedValueOnce(respond('other-request'));
    await expect(images.queryAsync(connection, 'image-1')).rejects.toMatchObject({ status: 502, response: {
      error: { message: expect.stringContaining('identity'), details: { request_id: 'other-request' } } } });
  });
});
