import { HttpException, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { inspectMediaPng } from './media-png';

const run = promisify(execFile);
export const VIDEO_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const referenceMax = 10 * 1024 * 1024;
const hour = 60 * 60 * 1000;
type Expected = { sha256: string; byteLength: number; expiresAt: string | null };
const MetadataSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().max(VIDEO_CACHE_MAX_BYTES),
  expiresAt: z.string().datetime({ offset: true }), mimeType: z.enum(['image/png', 'video/mp4']),
  width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
  durationSeconds: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  frameRate: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  hasAudio: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mimeType === 'video/mp4' && (value.durationSeconds === undefined || value.frameRate === undefined || value.hasAudio === undefined) ||
    value.mimeType === 'image/png' && (value.byteLength > referenceMax || value.width > 4096 || value.height > 4096 ||
      value.durationSeconds !== undefined || value.frameRate !== undefined || value.hasAudio !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cached media metadata.' });
  }
});
type Metadata = z.infer<typeof MetadataSchema>;
const fail = (code: string, status = 503): never => {
  throw new HttpException({ error: { code, message: '视频文件暂不可用，请查询原任务，不要重新生成' } }, status);
};

/** Private persistent volume, never served as a public upload directory. */
@Injectable()
export class VideoFileCacheService {
  private readonly root = resolve(process.env.MEDIA_VIDEO_CACHE_DIR ?? join(process.env.UPLOAD_PATH ?? 'uploads', 'media-video'));

  async assertAvailable(): Promise<void> {
    try { await run(process.env.MEDIA_VIDEO_FFPROBE_PATH || 'ffprobe', ['-version'], { timeout: 5000, maxBuffer: 64 * 1024 }); }
    catch { fail('VIDEO_INSPECTOR_UNAVAILABLE'); }
    await this.directory();
  }

  async saveReference(scope: string, id: string, bytes: Buffer, expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()) {
    this.deadline(expiresAt, 15 * 60_000);
    const dimensions = inspectMediaPng(bytes, referenceMax);
    const metadata: Metadata = { ...dimensions, mimeType: 'image/png', byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt };
    let stage: string;
    try {
      const target = await this.path('reference', scope, id);
      stage = await this.stage(target);
      await this.write(join(stage, 'data'), bytes);
      await this.publish(stage, target, 'reference', metadata);
      return { sha256: metadata.sha256, byteLength: bytes.length, ...dimensions };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      fail('MEDIA_STORAGE_UNAVAILABLE');
    } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
  }

  async readReference(scope: string, id: string, expected?: Expected): Promise<Buffer> {
    return this.read('reference', scope, id, expected);
  }

  async saveOutput(scope: string, id: string, response: Response, expiresAt = new Date(Date.now() + 24 * hour).toISOString()) {
    let stage: string;
    try {
      this.deadline(expiresAt, 24 * hour);
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || !response.body || !['video/mp4', 'application/octet-stream'].includes(mime ?? '')) fail('OUTPUT_FAILED', 502);
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) ||
        Number(length) <= 0 || Number(length) > VIDEO_CACHE_MAX_BYTES)) fail('OUTPUT_FAILED', 502);
      const target = await this.path('output', scope, id);
      stage = await this.stage(target);
      const part = join(stage, 'data');
      const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      let byteLength = 0;
      let signature = Buffer.alloc(0);
      try {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > VIDEO_CACHE_MAX_BYTES) fail('OUTPUT_FAILED', 502);
            const bytes = Buffer.from(value);
            if (signature.length < 12) signature = Buffer.concat([signature, bytes.subarray(0, 12 - signature.length)]);
            hash.update(bytes);
            await handle.writeFile(bytes);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (length !== null && Number(length) !== byteLength || signature.length < 12 || signature.toString('ascii', 4, 8) !== 'ftyp') fail('OUTPUT_FAILED', 502);
        await handle.sync();
      } finally { await handle.close(); }
      const media = await this.inspect(part);
      const metadata: Metadata = { mimeType: 'video/mp4', sha256: hash.digest('hex'), byteLength, expiresAt, ...media };
      const stored = await this.publish(stage, target, 'output', metadata);
      return { width: stored.width, height: stored.height, durationSeconds: stored.durationSeconds!, frameRate: stored.frameRate!,
        hasAudio: stored.hasAudio!, mimeType: 'video/mp4' as const, sha256: stored.sha256, byteLength: stored.byteLength };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      fail('OUTPUT_FAILED', 502);
    } finally {
      if (!response.body?.locked) await response.body?.cancel().catch(() => {});
      if (stage) await rm(stage, { force: true, recursive: true });
    }
  }

  async readOutput(scope: string, id: string, expected: Expected): Promise<Buffer> {
    return this.read('output', scope, id, expected);
  }

  async removeScoped(scope: string, id: string): Promise<void> {
    for (const kind of ['reference', 'output'] as const) {
      const target = await this.path(kind, scope, id);
      await rm(target, { recursive: true, force: true });
    }
  }

  /** Verify from the opened inode, then stream that same descriptor to avoid buffering 256MiB outputs. */
  async streamOutput(scope: string, id: string, expected: Expected): Promise<{ metadata: Metadata; stream: ReadStream }> {
    const target = await this.path('output', scope, id);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const { metadata } = await this.entry(target, 'output', false);
      if (!expected || !/^[a-f0-9]{64}$/i.test(expected.sha256) || !Number.isSafeInteger(expected.byteLength) ||
        expected.expiresAt === null || !Number.isFinite(Date.parse(expected.expiresAt)) || Date.parse(expected.expiresAt) <= Date.now()) {
        fail('RESULT_EXPIRED', 410);
      }
      if (metadata.sha256 !== expected.sha256.toLowerCase() || metadata.byteLength !== expected.byteLength ||
        metadata.expiresAt !== expected.expiresAt) fail('OUTPUT_FAILED', 502);
      const path = join(target, 'data');
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== metadata.byteLength) fail('MEDIA_STORAGE_UNAVAILABLE');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== metadata.byteLength) {
        fail('MEDIA_STORAGE_UNAVAILABLE');
      }
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < opened.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) fail('MEDIA_STORAGE_UNAVAILABLE');
        if (offset === 0 && (bytesRead < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp')) fail('OUTPUT_FAILED', 502);
        digest.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        offset !== opened.size || digest.digest('hex') !== metadata.sha256) fail('OUTPUT_FAILED', 502);
      if (Date.parse(metadata.expiresAt) <= Date.now()) fail('RESULT_EXPIRED', 410);
      const stream = handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: true });
      handle = undefined;
      return { metadata, stream };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('RESULT_EXPIRED', 410);
      fail('MEDIA_STORAGE_UNAVAILABLE');
    } finally { await handle?.close().catch(() => {}); }
  }

  private async inspect(path: string) {
    try {
      const { stdout } = await run(process.env.MEDIA_VIDEO_FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', path,
      ], { timeout: 30_000, maxBuffer: 256 * 1024 });
      const value = JSON.parse(stdout);
      const streams = z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional(),
        avg_frame_rate: z.string().optional() })).max(16).parse(value.streams);
      const videos = streams.filter(item => item.codec_type === 'video');
      const hasAudio = streams.some(item => item.codec_type === 'audio');
      const [numerator, denominator] = (videos[0]?.avg_frame_rate ?? '').split('/').map(Number);
      const metadata = MetadataSchema.parse({ sha256: '0'.repeat(64), byteLength: 1, expiresAt: new Date().toISOString(),
        mimeType: 'video/mp4', width: videos[0]?.width, height: videos[0]?.height,
        durationSeconds: Number(value.format?.duration), frameRate: numerator / denominator, hasAudio });
      if (videos.length !== 1 || !value.format?.format_name?.split(',').includes('mp4')) fail('OUTPUT_FAILED', 502);
      return { width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds!, frameRate: metadata.frameRate!, hasAudio };
    } catch { fail('OUTPUT_FAILED', 502); }
  }

  private async read(kind: 'reference' | 'output', scope: string, id: string, expected?: Expected) {
    const target = await this.path(kind, scope, id);
    try {
      const { metadata, bytes } = await this.entry(target, kind);
      if (expected && expected.expiresAt !== null && (!Number.isFinite(Date.parse(expected.expiresAt)) || Date.parse(expected.expiresAt) <= Date.now())) {
        fail(kind === 'reference' ? 'REFERENCE_EXPIRED' : 'RESULT_EXPIRED', 410);
      }
      if (expected && (metadata.sha256 !== expected.sha256.toLowerCase() || metadata.byteLength !== expected.byteLength ||
        expected.expiresAt !== null && metadata.expiresAt !== expected.expiresAt)) fail('OUTPUT_FAILED', 502);
      return bytes;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(kind === 'reference' ? 'REFERENCE_EXPIRED' : 'RESULT_EXPIRED', 410);
      fail('MEDIA_STORAGE_UNAVAILABLE');
    }
  }

  private entry(target: string, kind: 'reference' | 'output', includeBytes?: true): Promise<{ metadata: Metadata; bytes: Buffer }>;
  private entry(target: string, kind: 'reference' | 'output', includeBytes: false): Promise<{ metadata: Metadata }>;
  private async entry(target: string, kind: 'reference' | 'output', includeBytes = true): Promise<{ metadata: Metadata; bytes?: Buffer }> {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('MEDIA_STORAGE_UNAVAILABLE');
    const metadata = MetadataSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(join(target, 'manifest.json'), 4096))));
    if (!metadata.success || metadata.data.mimeType !== (kind === 'reference' ? 'image/png' : 'video/mp4')) fail('OUTPUT_FAILED', 502);
    const value = metadata.data;
    if (Date.parse(value.expiresAt) <= Date.now()) fail(kind === 'reference' ? 'REFERENCE_EXPIRED' : 'RESULT_EXPIRED', 410);
    if (!includeBytes) return { metadata: value };
    const bytes = await this.bytes(join(target, 'data'), kind === 'reference' ? referenceMax : VIDEO_CACHE_MAX_BYTES);
    if (bytes.length !== value.byteLength || createHash('sha256').update(bytes).digest('hex') !== value.sha256) fail('OUTPUT_FAILED', 502);
    if (Date.parse(value.expiresAt) <= Date.now()) fail(kind === 'reference' ? 'REFERENCE_EXPIRED' : 'RESULT_EXPIRED', 410);
    return { metadata: value, bytes };
  }

  private async stage(target: string) {
    const stage = `${target}.${randomUUID()}.part`;
    await mkdir(stage, { mode: 0o700 });
    return stage;
  }

  private async publish(stage: string, target: string, kind: 'reference' | 'output', metadata: Metadata): Promise<Metadata> {
    this.deadline(metadata.expiresAt, kind === 'reference' ? 15 * 60_000 : 24 * hour);
    await this.write(join(stage, 'manifest.json'), Buffer.from(JSON.stringify(MetadataSchema.parse(metadata))));
    // A nonempty destination directory cannot be replaced by rename, even across processes.
    // Data and manifest become visible together; later writers may only reuse verified identical content.
    let exists = false;
    try { await lstat(target); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      try { await rename(stage, target); return metadata; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code)) throw error; }
    }
    const existing = await this.entry(target, kind);
    if (existing.metadata.sha256 !== metadata.sha256 || existing.metadata.byteLength !== metadata.byteLength ||
      existing.metadata.width !== metadata.width || existing.metadata.height !== metadata.height ||
      existing.metadata.durationSeconds !== metadata.durationSeconds || existing.metadata.frameRate !== metadata.frameRate ||
      existing.metadata.hasAudio !== metadata.hasAudio) fail('OUTPUT_FAILED', 502);
    return existing.metadata;
  }

  private async bytes(path: string, max: number) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > max) fail('MEDIA_STORAGE_UNAVAILABLE');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > max ||
        info.dev !== before.dev || info.ino !== before.ino) fail('MEDIA_STORAGE_UNAVAILABLE');
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) fail('MEDIA_STORAGE_UNAVAILABLE');
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.nlink !== 1 || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('MEDIA_STORAGE_UNAVAILABLE');
      return bytes;
    } finally { await handle.close(); }
  }

  private async write(target: string, bytes: Buffer) {
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }

  private async directory() {
    try {
      let current = parse(this.root).root;
      for (const part of this.root.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) fail('MEDIA_STORAGE_UNAVAILABLE');
      }
    } catch { fail('MEDIA_STORAGE_UNAVAILABLE'); }
  }

  private async path(kind: 'reference' | 'output', scope: string, id: string) {
    if (typeof scope !== 'string' || !scope || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) fail('INVALID_PARAMETER', 400);
    await this.directory();
    return join(this.root, createHash('sha256').update(JSON.stringify([kind, scope, id])).digest('hex'));
  }

  private deadline(expiresAt: string, max: number) {
    const left = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(left) || left <= 0 || left > max + 1000) fail('INVALID_PARAMETER', 400);
  }

  /** Explicit bounded maintenance; never traverses another upload directory. */
  async pruneExpired(limit = 100): Promise<number> {
    await this.directory();
    let deleted = 0;
    for (const name of (await readdir(this.root)).slice(0, 10_000)) {
      if (deleted >= Math.max(0, Math.min(1000, limit))) break;
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const target = join(this.root, name);
      try {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const metadata = MetadataSchema.parse(JSON.parse((await this.bytes(join(target, 'manifest.json'), 4096)).toString('utf8')));
        if (Date.parse(metadata.expiresAt) > Date.now()) continue;
        const data = await lstat(join(target, 'data'));
        if (!data.isFile() || data.nlink !== 1) continue;
        await rm(join(target, 'data')); await rm(join(target, 'manifest.json')); await rmdir(target); deleted++;
      } catch { /* Invalid evidence is retained for explicit repair. */ }
    }
    return deleted;
  }
}
