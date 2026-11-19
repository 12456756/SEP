import { HttpException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../../shared/fixtures/media-video-v1.json';
import { VIDEO_CACHE_MAX_BYTES, VideoFileCacheService } from './video-file-cache.service';

jest.mock('node:child_process', () => {
  const execFile = jest.fn();
  execFile[jest.requireActual<typeof import('node:util')>('node:util').promisify.custom] = execFile;
  return { execFile };
});

const MP4 = Buffer.from(fixture.mediaFixture.base64, 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64');
const probe = () => ({ stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 16, height: 16, avg_frame_rate: '24/1' }],
  format: { duration: '1', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }) });
const expected = (bytes: Buffer, expiresAt: string) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, expiresAt });
const content = (bytes = MP4) => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp4' } });

describe('VideoFileCacheService concurrency and security', () => {
  let parent: string;
  let root: string;
  let cache: VideoFileCacheService;
  let oldRoot: string | undefined;
  let expiresAt: string;
  beforeEach(async () => {
    oldRoot = process.env.MEDIA_VIDEO_CACHE_DIR;
    parent = await realpath(await mkdtemp(join(tmpdir(), 'sep-video-security-')));
    root = join(parent, 'cache');
    process.env.MEDIA_VIDEO_CACHE_DIR = root;
    cache = new VideoFileCacheService();
    expiresAt = new Date(Date.now() + 60_000).toISOString();
    (execFile as unknown as jest.Mock).mockReset().mockResolvedValue(probe());
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (oldRoot === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR; else process.env.MEDIA_VIDEO_CACHE_DIR = oldRoot;
    await rm(parent, { force: true, recursive: true });
  });
  async function errorOf(promise: Promise<unknown>, code?: string) {
    const error = await promise.then(() => { throw new Error('Expected failure'); }, error => error);
    expect(error).toBeInstanceOf(HttpException);
    if (code) expect(error.getResponse()).toMatchObject({ error: { code } });
    return error as HttpException;
  }
  async function entry() {
    return join(root, (await readdir(root)).find(name => /^[a-f0-9]{64}$/.test(name))!);
  }
  async function noParts() {
    const names = await readdir(root).catch(() => []);
    expect(names.filter(name => name.endsWith('.part'))).toEqual([]);
    return names;
  }
  async function assertUnreadable(code?: string) {
    await errorOf(cache.readOutput('scope', 'output-1', expected(MP4, expiresAt)), code);
    await errorOf(cache.streamOutput('scope', 'output-1', expected(MP4, expiresAt)), code);
  }
  async function consume(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  it('allows only one immutable winner when two instances concurrently publish different bytes', async () => {
    const other = new VideoFileCacheService();
    const alternate = Buffer.concat([MP4, Buffer.from('different-file')]);
    const results = await Promise.allSettled([
      cache.saveOutput('scope', 'output-1', content(), expiresAt),
      other.saveOutput('scope', 'output-1', content(alternate), expiresAt),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const bytes = results[0].status === 'fulfilled' ? MP4 : alternate;
    expect(await cache.readOutput('scope', 'output-1', expected(bytes, expiresAt))).toEqual(bytes);
    expect(await consume((await cache.streamOutput('scope', 'output-1', expected(bytes, expiresAt))).stream)).toEqual(bytes);
    expect(await noParts()).toHaveLength(1);
  });

  it('reuses equal concurrent content with matching manifest and private files', async () => {
    const results = await Promise.all([
      cache.saveOutput('scope', 'output-1', content(), expiresAt),
      new VideoFileCacheService().saveOutput('scope', 'output-1', content(), expiresAt),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await cache.readOutput('scope', 'output-1', expected(MP4, expiresAt))).toEqual(MP4);
    const target = await entry();
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
    expect(manifest.sha256).toBe(expected(MP4, expiresAt).sha256);
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(target, 'data'))).mode & 0o777).toBe(0o600);
    expect(await noParts()).toHaveLength(1);
  });

  it.each([false, true])('records measured audio-track presence %s independently of requested settings', async hasAudio => {
    const result = JSON.parse(probe().stdout);
    if (hasAudio) result.streams.push({ codec_type: 'audio', codec_name: 'aac' });
    (execFile as unknown as jest.Mock).mockResolvedValue({ stdout: JSON.stringify(result) });
    const saved = await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    expect(saved).toMatchObject({ hasAudio });
    const manifest = JSON.parse(await readFile(join(await entry(), 'manifest.json'), 'utf8'));
    expect(manifest.hasAudio).toBe(hasAudio);
    const cached = await new VideoFileCacheService().streamOutput('scope', 'output-1', expected(MP4, expiresAt));
    expect(cached.metadata).toMatchObject({ hasAudio });
    expect(await consume(cached.stream)).toEqual(MP4);
  });

  it('retains measured duration and frame rate beyond the legacy product lists', async () => {
    const result = JSON.parse(probe().stdout);
    result.streams[0].avg_frame_rate = '144/1';
    result.format.duration = '901';
    (execFile as unknown as jest.Mock).mockResolvedValue({ stdout: JSON.stringify(result) });
    const saved = await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    expect(saved).toMatchObject({ durationSeconds: 901, frameRate: 144 });
    const cached = await new VideoFileCacheService().streamOutput('scope', 'output-1', expected(MP4, expiresAt));
    expect(cached.metadata).toMatchObject({ durationSeconds: 901, frameRate: 144 });
    expect(await consume(cached.stream)).toEqual(MP4);
  });

  it('refuses contradictory audio evidence on retries rather than upgrading a silent file', async () => {
    const original = await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    expect(original).toMatchObject({ hasAudio: false });
    const result = JSON.parse(probe().stdout);
    result.streams.push({ codec_type: 'audio' });
    (execFile as unknown as jest.Mock).mockResolvedValue({ stdout: JSON.stringify(result) });
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'OUTPUT_FAILED');
    expect(JSON.parse(await readFile(join(await entry(), 'manifest.json'), 'utf8')).hasAudio).toBe(false);
    expect(await noParts()).toHaveLength(1);
  });

  it('rejects conflicting overwrites and freezes the original expiry for identical retries', async () => {
    const original = await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    await errorOf(cache.saveOutput('scope', 'output-1', content(Buffer.concat([MP4, Buffer.from('different')])), expiresAt), 'OUTPUT_FAILED');
    expect(await cache.saveOutput('scope', 'output-1', content(), new Date(Date.now() + 120_000).toISOString())).toEqual(original);
    expect(JSON.parse(await readFile(join(await entry(), 'manifest.json'), 'utf8')).expiresAt).toBe(expiresAt);
    expect(await cache.readOutput('scope', 'output-1', expected(MP4, expiresAt))).toEqual(MP4);
  });

  it('isolates scope, media kind and ID and persists PNG references across instances', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    await errorOf(cache.readOutput('other', 'output-1', expected(MP4, expiresAt)), 'RESULT_EXPIRED');
    await errorOf(cache.streamOutput('other', 'output-1', expected(MP4, expiresAt)), 'RESULT_EXPIRED');
    await errorOf(cache.readOutput('scope', 'missing', expected(MP4, expiresAt)), 'RESULT_EXPIRED');
    await errorOf(cache.readReference('scope', 'output-1'), 'REFERENCE_EXPIRED');
    const values = await Promise.all([
      cache.saveReference('scope', 'reference-1', PNG, expiresAt),
      new VideoFileCacheService().saveReference('scope', 'reference-1', PNG, expiresAt),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toEqual({ width: 1, height: 1, sha256: expected(PNG, expiresAt).sha256, byteLength: PNG.length });
    expect(await new VideoFileCacheService().readReference('scope', 'reference-1', expected(PNG, expiresAt))).toEqual(PNG);
    await errorOf(cache.saveReference('scope', 'bad-png', Buffer.from('not PNG'), expiresAt));
    expect(await noParts()).toHaveLength(2);
  });

  it('expires reference and output entries and bounds maintenance work', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    await cache.saveReference('scope', 'reference-1', PNG, expiresAt);
    await cache.saveOutput('other', 'output-2', content(), new Date(Date.now() + 3600_000).toISOString());
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    await assertUnreadable('RESULT_EXPIRED');
    await errorOf(cache.readReference('scope', 'reference-1', expected(PNG, expiresAt)), 'REFERENCE_EXPIRED');
    expect(await cache.pruneExpired(0)).toBe(0);
    expect(await cache.pruneExpired(1)).toBe(1);
    expect(await cache.pruneExpired(100)).toBe(1);
    expect(await noParts()).toHaveLength(1);
  });

  it.each([
    { sha256: 'a'.repeat(64) }, { byteLength: 1 }, { mimeType: 'image/png' }, { durationSeconds: undefined },
    { frameRate: undefined }, { durationSeconds: 0 }, { frameRate: 0 }, { width: 0 }, { height: -1 },
    { expiresAt: 'invalid' }, { privateUrl: 'private' }, { hasAudio: undefined }, { hasAudio: null }, { hasAudio: 'true' },
  ])('fails closed for invalid or inconsistent manifest %#', async patch => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const manifest = join(await entry(), 'manifest.json');
    const original = JSON.parse(await readFile(manifest, 'utf8'));
    await writeFile(manifest, JSON.stringify({ ...original, ...patch }));
    await assertUnreadable();
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt));
    expect(await noParts()).toHaveLength(1);
  });

  it('rejects corrupt bytes, malformed JSON and oversized manifests without silent repair', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const target = await entry();
    await writeFile(join(target, 'data'), Buffer.alloc(MP4.length));
    await assertUnreadable('OUTPUT_FAILED');
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'OUTPUT_FAILED');
    await writeFile(join(target, 'manifest.json'), '{broken');
    await assertUnreadable();
    await writeFile(join(target, 'manifest.json'), 'x'.repeat(4097));
    await assertUnreadable('MEDIA_STORAGE_UNAVAILABLE');
  });

  it('rejects caller hash, size or expiry mismatch without removing a valid original', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    for (const patch of [{ sha256: '0'.repeat(64) }, { byteLength: 1 }, { expiresAt: new Date(Date.now() + 120_000).toISOString() }]) {
      await errorOf(cache.readOutput('scope', 'output-1', { ...expected(MP4, expiresAt), ...patch }), 'OUTPUT_FAILED');
      await errorOf(cache.streamOutput('scope', 'output-1', { ...expected(MP4, expiresAt), ...patch }), 'OUTPUT_FAILED');
    }
    expect(await consume((await cache.streamOutput('scope', 'output-1', expected(MP4, expiresAt))).stream)).toEqual(MP4);
  });

  it('streams the verified descriptor even when the pathname is replaced before consumption', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const result = await cache.streamOutput('scope', 'output-1', expected(MP4, expiresAt));
    const data = join(await entry(), 'data');
    await rename(data, join(parent, 'original-inode'));
    await writeFile(data, Buffer.alloc(MP4.length));
    expect(await consume(result.stream)).toEqual(MP4);
    await assertUnreadable('OUTPUT_FAILED');
  });

  it('closes the descriptor when the caller aborts a download', async () => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const { stream } = await cache.streamOutput('scope', 'output-1', expected(MP4, expiresAt));
    const closed = new Promise<void>(resolve => stream.once('close', resolve));
    stream.destroy();
    await closed;
    expect(stream.closed).toBe(true);
    expect(await cache.readOutput('scope', 'output-1', expected(MP4, expiresAt))).toEqual(MP4);
  });

  it.each(['../escape', '.', '', 'id/child', 'id?private'])('rejects invalid ID %s and cancels source', async id => {
    const cancel = jest.fn();
    await errorOf(cache.saveOutput('scope', id, new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'video/mp4' },
    }), expiresAt), 'INVALID_PARAMETER');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await noParts()).toEqual([]);
  });

  it.each(['invalid', '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z'])('rejects invalid deadline %s and cancels source', async expiry => {
    const cancel = jest.fn();
    await errorOf(cache.saveOutput('scope', 'output-1', new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'video/mp4' },
    }), expiry), 'INVALID_PARAMETER');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await noParts()).toEqual([]);
  });

  it.each([
    { 'Content-Type': 'text/html' }, { 'Content-Length': '-1' }, { 'Content-Length': '0' },
    { 'Content-Length': String(VIDEO_CACHE_MAX_BYTES + 1) }, { 'Content-Length': 'abc' },
  ])('rejects wrong MIME or declared size and cancels source %#', async headers => {
    const cancel = jest.fn();
    await errorOf(cache.saveOutput('scope', 'output-1', new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'video/mp4', ...headers },
    }), expiresAt), 'OUTPUT_FAILED');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await noParts()).toEqual([]);
  });

  it('rejects empty, truncated, wrong-signature and partial bodies without publishing', async () => {
    for (const response of [content(Buffer.alloc(0)), content(Buffer.from('not a video file')),
      new Response(new Uint8Array(MP4), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MP4.length + 1) } }),
      new Response(new Uint8Array(MP4), { status: 206, headers: { 'Content-Type': 'video/mp4' } })]) {
      await errorOf(cache.saveOutput('scope', 'output-1', response, expiresAt), 'OUTPUT_FAILED');
      expect(await noParts()).toEqual([]);
    }
  });

  it('cleans partial files and redacts stream failure after some bytes were written', async () => {
    let pulls = 0;
    const response = new Response(new ReadableStream({ pull(c) {
      if (!pulls++) c.enqueue(new Uint8Array(MP4)); else c.error(new Error('ECONNRESET token=private-stream-key'));
    } }), { headers: { 'Content-Type': 'video/mp4' } });
    const error = await errorOf(cache.saveOutput('scope', 'output-1', response, expiresAt), 'OUTPUT_FAILED');
    expect(error.getResponse()).toMatchObject({ error: { cause: { message: 'ECONNRESET token=[REDACTED]' } } });
    expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain('private-stream-key');
    expect(await noParts()).toEqual([]);
  });

  it('enforces the 256MiB streamed byte cap without Content-Length', async () => {
    const chunk = Buffer.alloc(4 * 1024 * 1024); MP4.copy(chunk);
    let pulls = 0;
    const response = new Response(new ReadableStream({ pull(c) {
      if (pulls++ < 65) c.enqueue(chunk); else c.close();
    } }), { headers: { 'Content-Type': 'application/octet-stream' } });
    await errorOf(cache.saveOutput('scope', 'output-1', response, expiresAt), 'OUTPUT_FAILED');
    expect(execFile).not.toHaveBeenCalled();
    expect(await noParts()).toEqual([]);
  }, 30_000);

  it.each(['data', 'manifest.json'])('rejects symlinked or hard-linked %s on read, stream and reuse', async filename => {
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const file = join(await entry(), filename);
    const outside = join(parent, 'outside');
    const original = await readFile(file); await writeFile(outside, original);
    await rm(file); await symlink(outside, file);
    await assertUnreadable('MEDIA_STORAGE_UNAVAILABLE');
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt));
    expect(await readFile(outside)).toEqual(original);
    await rm(file); await link(outside, file);
    await assertUnreadable('MEDIA_STORAGE_UNAVAILABLE');
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt));
    expect(await readFile(outside)).toEqual(original);
    expect(await noParts()).toHaveLength(1);
  });

  it('rejects symlinked roots, ancestors and entry directories', async () => {
    const outside = join(parent, 'outside'); await mkdir(outside);
    await symlink(outside, root);
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'MEDIA_STORAGE_UNAVAILABLE');
    await rm(root);
    await symlink(outside, join(parent, 'linked-parent'));
    process.env.MEDIA_VIDEO_CACHE_DIR = join(parent, 'linked-parent', 'cache');
    await errorOf(new VideoFileCacheService().saveOutput('scope', 'output-1', content(), expiresAt), 'MEDIA_STORAGE_UNAVAILABLE');
    process.env.MEDIA_VIDEO_CACHE_DIR = root;
    await cache.saveOutput('scope', 'output-1', content(), expiresAt);
    const target = await entry(); await rm(target, { recursive: true }); await symlink(outside, target);
    await assertUnreadable('MEDIA_STORAGE_UNAVAILABLE');
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'MEDIA_STORAGE_UNAVAILABLE');
    expect(await readdir(outside)).toEqual([]);
  });

  it('fails closed for missing or failing ffprobe without publishing files or private errors', async () => {
    (execFile as unknown as jest.Mock).mockRejectedValue(Object.assign(new Error('ffprobe ENOENT password=private-probe-key'), { code: 'ENOENT' }));
    const error = await errorOf(cache.assertAvailable(), 'VIDEO_INSPECTOR_UNAVAILABLE');
    expect(error.getResponse()).toMatchObject({ error: { cause: { code: 'ENOENT', message: 'ffprobe ENOENT password=[REDACTED]' } } });
    expect(JSON.stringify(error.getResponse()) + error.stack).not.toContain('private-probe-key');
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'OUTPUT_FAILED');
    expect(await noParts()).toEqual([]);
  });

  it.each([
    '{invalid', JSON.stringify({ streams: [], format: { duration: '4', format_name: 'mp4' } }),
    JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '4', format_name: 'mp4' } }),
    JSON.stringify({ streams: [{ codec_type: 'video', width: 16, height: 16, avg_frame_rate: '0/0' }], format: { duration: '4', format_name: 'mp4' } }),
    JSON.stringify({ streams: [{ codec_type: 'video', width: 16, height: 16, avg_frame_rate: '24/1' }], format: { duration: 'NaN', format_name: 'mp4' } }),
    JSON.stringify({ streams: [{ codec_type: 'video', width: 16, height: 16, avg_frame_rate: '24/1' }], format: { duration: '4', format_name: 'matroska' } }),
  ])('fails closed for malformed or incompatible ffprobe output %#', async stdout => {
    (execFile as unknown as jest.Mock).mockResolvedValue({ stdout });
    await errorOf(cache.saveOutput('scope', 'output-1', content(), expiresAt), 'OUTPUT_FAILED');
    expect(await noParts()).toEqual([]);
  });
});
