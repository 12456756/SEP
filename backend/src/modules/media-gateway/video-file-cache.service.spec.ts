import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fixture from '../../shared/fixtures/media-video-v1.json';
import { VideoFileCacheService } from './video-file-cache.service';

const bytes = Buffer.from(fixture.mediaFixture.base64, 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const streamBytes = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

describe('VideoFileCacheService', () => {
  let root: string;
  let cache: VideoFileCacheService;
  let original: string | undefined;
  beforeEach(async () => {
    original = process.env.MEDIA_VIDEO_CACHE_DIR;
    root = await realpath(await mkdtemp(join(tmpdir(), 'sep-video-cache-')));
    process.env.MEDIA_VIDEO_CACHE_DIR = root;
    cache = new VideoFileCacheService();
  });
  afterEach(async () => {
    if (original === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR;
    else process.env.MEDIA_VIDEO_CACHE_DIR = original;
    await rm(root, { recursive: true, force: true });
  });

  it('persists scoped MP4 with probed metadata and streams the same verified bytes', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const metadata = await cache.saveOutput('enterprise/sub/member/user', 'receipt-output',
      new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }), expiresAt);
    // The shared MP4 fixture is intentionally silent; requested audio settings are not evidence.
    expect(metadata).toMatchObject({ mimeType: 'video/mp4', sha256, byteLength: bytes.length, hasAudio: false });
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
    const saved = await cache.streamOutput('enterprise/sub/member/user', 'receipt-output', { sha256, byteLength: bytes.length, expiresAt });
    expect(saved.metadata).toMatchObject(metadata);
    expect(await streamBytes(saved.stream)).toEqual(bytes);
    await expect(cache.streamOutput('other-enterprise/sub/member/user', 'receipt-output', { sha256, byteLength: bytes.length, expiresAt }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('does not replace an output with different bytes after a partial retry', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const create = (content: Buffer) => new Response(new Uint8Array(content), { headers: { 'content-type': 'video/mp4' } });
    await cache.saveOutput('scope', 'same-output', create(bytes), expiresAt);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await expect(cache.saveOutput('scope', 'same-output', create(changed), expiresAt)).rejects.toThrow();
    const actual = await cache.streamOutput('scope', 'same-output', { sha256, byteLength: bytes.length, expiresAt });
    expect(await streamBytes(actual.stream)).toEqual(bytes);
  });

  it('rejects expired, mismatched and corrupt receipts without publishing bytes', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await cache.saveOutput('scope', 'receipt-output', new Response(bytes, { headers: { 'content-type': 'video/mp4' } }), expiresAt);
    await expect(cache.streamOutput('scope', 'receipt-output', { sha256, byteLength: bytes.length + 1, expiresAt })).rejects.toThrow();
    await expect(cache.streamOutput('scope', 'receipt-output', { sha256, byteLength: bytes.length, expiresAt: new Date(0).toISOString() }))
      .rejects.toMatchObject({ status: 410 });
    const target = join(root, createHash('sha256').update(JSON.stringify(['output', 'scope', 'receipt-output'])).digest('hex'), 'data');
    const changed = Buffer.from(bytes); changed[100] ^= 1;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, changed);
    await expect(cache.streamOutput('scope', 'receipt-output', { sha256, byteLength: bytes.length, expiresAt })).rejects.toThrow();
  });

  it('keeps output expiry frozen across idempotent saves and prunes expired entries', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = await cache.saveOutput('scope', 'expiring', new Response(bytes, { headers: { 'content-type': 'video/mp4' } }), expiresAt);
    const target = join(root, createHash('sha256').update(JSON.stringify(['output', 'scope', 'expiring'])).digest('hex'), 'manifest.json');
    const manifest = JSON.parse(await readFile(target, 'utf8'));
    manifest.expiresAt = new Date(Date.now() - 1000).toISOString();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, JSON.stringify(manifest));
    expect(await cache.pruneExpired(10)).toBe(1);
    await expect(cache.readOutput('scope', 'expiring', { sha256: result.sha256, byteLength: result.byteLength, expiresAt }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('rejects an interrupted stream and leaves no visible entry or stale temporary directory', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 64));
        controller.error(new Error('interrupted ECONNRESET token=private-stream-token'));
      },
    });
    const failure = await cache.saveOutput('scope', 'broken', new Response(body, { headers: { 'content-type': 'video/mp4' } }), expiresAt)
      .catch(error => error);
    expect(failure.getStatus()).toBe(502);
    expect(failure.getResponse()).toMatchObject({ error: { code: 'OUTPUT_FAILED',
      cause: { message: 'interrupted ECONNRESET token=[REDACTED]' } } });
    expect(await cache.pruneExpired(10)).toBe(0);
  });

  it('retains a missing file reason without exposing the private cache path', async () => {
    const failure = await cache.streamOutput('scope', 'missing', {
      sha256, byteLength: bytes.length, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).catch(error => error);
    expect(failure.getStatus()).toBe(410);
    expect(failure.getResponse()).toMatchObject({ error: { code: 'RESULT_EXPIRED', cause: { code: 'ENOENT' } } });
    expect(JSON.stringify(failure.getResponse())).not.toContain(root);
  });
});
