import { VideoReferenceUploadService } from './video-reference-upload.service';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIDEO_INPUT_MAX_BYTES, VIDEO_INPUT_REQUEST_MAX_BYTES } from 'shared';

describe('reference video admission', () => {
  it('rejects a full global upload pool with a retry interval', async () => {
    const redis = { eval: jest.fn(async () => 0), zrem: jest.fn() };
    const uploads = new VideoReferenceUploadService({ redis } as never);
    await expect(uploads.acquire()).rejects.toMatchObject({ status: 429, response: {
      retryAfterSeconds: 1, error: { code: 'VIDEO_REFERENCE_UPLOAD_BUSY', origin: 'sep', stage: 'admission' },
    } });
    expect(redis.zrem).not.toHaveBeenCalled();
  });
  it('fails closed when shared admission storage cannot be reached', async () => {
    const uploads = new VideoReferenceUploadService({ redis: { eval: jest.fn().mockRejectedValue(new Error('Synthetic Redis outage')) } } as never);
    await expect(uploads.acquire()).rejects.toMatchObject({ status: 503, response: { error: { code: 'VIDEO_REFERENCE_ADMISSION_UNAVAILABLE' } } });
  });
  it('releases only its own admitted upload token', async () => {
    const redis = { eval: jest.fn(async () => 1), zrem: jest.fn(async (_key: string, _token: string) => 1) };
    const uploads = new VideoReferenceUploadService({ redis } as never);
    const releaseFirst = await uploads.acquire(); const releaseSecond = await uploads.acquire();
    await releaseFirst(); await releaseSecond();
    expect(redis.zrem.mock.calls[0][1]).not.toBe(redis.zrem.mock.calls[1][1]);
    expect(redis.zrem).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized declared body before receiving bytes', async () => {
    const uploads = new VideoReferenceUploadService({} as never);
    await expect(uploads.receive({ headers: { 'content-length': String(VIDEO_INPUT_REQUEST_MAX_BYTES + 1) } } as never,
      {} as never, tmpdir(), VIDEO_INPUT_MAX_BYTES, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
  });

  it('enforces 92 MiB on a chunked multipart stream without Content-Length', async () => {
    const uploads = new VideoReferenceUploadService({} as never);
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const stream = Readable.from((function* () { for (let i = 0; i < 93; i++) yield chunk; })());
    const req = Object.assign(stream, { headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'transfer-encoding': 'chunked' },
      method: 'POST', is: () => true });
    await expect(uploads.receive(req as never, {} as never, tmpdir(), VIDEO_INPUT_MAX_BYTES, new AbortController().signal))
      .rejects.toMatchObject({ status: 413, response: { error: { code: 'VIDEO_REFERENCE_TOO_LARGE' } } });
  });

  it('aborts a partially received file and closes its writer before returning', async () => {
    const uploads = new VideoReferenceUploadService({} as never);
    const directory = await mkdtemp(join(tmpdir(), 'sep-upload-abort-'));
    const abort = new AbortController();
    const req = Object.assign(new PassThrough(), { headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'transfer-encoding': 'chunked' },
      method: 'POST', is: () => true });
    try {
      const receiving = uploads.receive(req as never, {} as never, directory, VIDEO_INPUT_MAX_BYTES, abort.signal);
      req.write(Buffer.from('--synthetic\r\nContent-Disposition: form-data; name="file"; filename="test.mp4"\r\nContent-Type: video/mp4\r\n\r\npartial-file'));
      setImmediate(() => abort.abort(new Error('Synthetic disconnect')));
      await expect(receiving).rejects.toMatchObject({ status: 408, response: { error: { code: 'VIDEO_REFERENCE_UPLOAD_TIMEOUT' } } });
    } finally { req.destroy(); await rm(directory, { recursive: true, force: true }); }
  });
});
