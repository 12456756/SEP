import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { VIDEO_INPUT_REQUEST_MAX_BYTES } from 'shared';
import { RedisService } from '../../redis/redis.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

const run = promisify(execFile);
export const VIDEO_UPLOAD_TIMEOUT_MS = 300_000;
const leaseKey = 'sep:media:video-reference-uploads';
export type InspectedVideoReference = { path: string; byteLength: number; sha256: string; mimeType: 'video/mp4' | 'video/quicktime' };
export function videoUploadError(status: number, code: string, message: string, stage: string, cause?: unknown): never {
  throw new HttpException({ error: { code, message, origin: 'sep', source: 'platform', stage,
    ...(cause === undefined ? {} : { details: exceptionDetails(cause) }) }, ...(status === 429 ? { retryAfterSeconds: 1 } : {}) }, status);
}

@Injectable()
export class VideoReferenceUploadService {
  private readonly logger = new Logger(VideoReferenceUploadService.name);
  private readonly root = resolve(process.env.MEDIA_VIDEO_CACHE_DIR ?? join(process.env.UPLOAD_PATH ?? 'uploads', 'media-video'), 'incoming');
  constructor(private readonly redis: RedisService) {}

  async acquire(): Promise<() => Promise<void>> {
    const token = randomUUID();
    try {
      // Redis time avoids clock skew between backend instances. Expiry also recovers crashed workers.
      const allowed = await this.redis.redis.eval(`
        local t = redis.call('TIME')
        local now = t[1] * 1000 + math.floor(t[2] / 1000)
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
        if redis.call('ZCARD', KEYS[1]) >= 2 then return 0 end
        redis.call('ZADD', KEYS[1], now + 330000, ARGV[1])
        redis.call('PEXPIRE', KEYS[1], 360000)
        return 1`, 1, leaseKey, token);
      if (Number(allowed) !== 1) videoUploadError(429, 'VIDEO_REFERENCE_UPLOAD_BUSY', '参考视频上传繁忙，请稍后重试', 'admission');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      videoUploadError(503, 'VIDEO_REFERENCE_ADMISSION_UNAVAILABLE', '参考视频上传并发检查不可用', 'admission', error);
    }
    return async () => {
      try { await this.redis.redis.zrem(leaseKey, token); }
      catch (error) { this.logger.warn({ event: 'video_upload_lease_release_failed', details: exceptionDetails(error) }); }
    };
  }

  async directory() {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) videoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE', '参考视频临时目录无效', 'receive');
      // Only our random staging directories are eligible; live uploads are bounded to five minutes.
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^upload-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const path = join(this.root, entry.name);
        try {
          if (Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) await rm(path, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const directory = await mkdtemp(join(this.root, 'upload-'));
      await chmod(directory, 0o700);
      return directory;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      videoUploadError(503, 'MEDIA_STORAGE_UNAVAILABLE', '无法创建参考视频临时文件', 'receive', error);
    }
  }

  async receive(req: Request, res: Response, directory: string, maxBytes: number, signal: AbortSignal): Promise<InspectedVideoReference> {
    const rawLength = req.headers['content-length'];
    if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > VIDEO_INPUT_REQUEST_MAX_BYTES)) {
      videoUploadError(413, 'VIDEO_REFERENCE_TOO_LARGE', '参考视频请求不能超过 92 MiB', 'receive');
    }
    if (!req.is('multipart/form-data')) videoUploadError(415, 'INVALID_VIDEO_REFERENCE_UPLOAD', '请使用 multipart/form-data 的 file 字段上传视频', 'receive');
    const path = join(directory, 'input');
    const receiving = new AbortController();
    const receiveSignal = AbortSignal.any([signal, receiving.signal]);
    let writing: Promise<void> | undefined;
    const sha = createHash('sha256');
    let byteLength = 0;
    const storage: multer.StorageEngine = {
      _handleFile: (_request, file, callback) => {
        const measure = new Transform({ transform(chunk: Buffer, _encoding, next) {
          byteLength += chunk.length;
          if (byteLength > maxBytes) { next(new HttpException({ error: { code: 'VIDEO_REFERENCE_TOO_LARGE', message: '参考视频超过 Profile 单文件上限', origin: 'sep', stage: 'receive' } }, 413)); return; }
          sha.update(chunk); next(null, chunk);
        } });
        writing = pipeline(file.stream, measure, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: receiveSignal });
        writing.then(() => callback(null, { path, size: byteLength }), error => callback(error));
      },
      _removeFile: (_request, _file, callback) => { rm(path, { force: true }).then(() => callback(null), callback); },
    };
    // A bounded proxy stream enforces the whole-request cap, including chunked multipart overhead.
    const proxy = Object.assign(new PassThrough(), { headers: req.headers, method: req.method }) as unknown as Request;
    let total = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, next) {
      total += chunk.length;
      if (total > VIDEO_INPUT_REQUEST_MAX_BYTES) {
        next(new HttpException({ error: { code: 'VIDEO_REFERENCE_TOO_LARGE', message: '参考视频请求不能超过 92 MiB', origin: 'sep', stage: 'receive' } }, 413)); return;
      }
      next(null, chunk);
    } });
    try {
      await new Promise<void>((resolveUpload, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true; signal.removeEventListener('abort', aborted);
          req.unpipe(limiter); limiter.unpipe(proxy as unknown as PassThrough);
          if (error) { receiving.abort(); (proxy as unknown as PassThrough).destroy(); limiter.destroy(); req.resume(); reject(error); }
          else { req.file = proxy.file; resolveUpload(); }
        };
        const aborted = () => finish(signal.reason ?? new Error('Video upload aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        limiter.on('error', finish); proxy.on('error', finish);
        if (signal.aborted) { aborted(); return; }
        multer({ storage, limits: { fileSize: maxBytes + 1, files: 1, fields: 0, parts: 2, fieldNameSize: 64, headerPairs: 64 } })
          .single('file')(proxy, res, finish);
        req.pipe(limiter).pipe(proxy as unknown as PassThrough);
      });
      if (!req.file || !byteLength) videoUploadError(400, 'INVALID_VIDEO_REFERENCE_UPLOAD', '需要一个非空的 file 视频文件', 'receive');
      const mimeType = await this.inspect(path, signal);
      return { path, byteLength, sha256: sha.digest('hex'), mimeType };
    } catch (error) {
      receiving.abort(); await writing?.catch(() => {});
      if (error instanceof HttpException) throw error;
      if (error instanceof multer.MulterError) videoUploadError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? 'VIDEO_REFERENCE_TOO_LARGE' : 'INVALID_VIDEO_REFERENCE_UPLOAD', error.message, 'receive', error);
      videoUploadError(signal.aborted ? 408 : 503, signal.aborted ? 'VIDEO_REFERENCE_UPLOAD_TIMEOUT' : 'MEDIA_STORAGE_UNAVAILABLE',
        signal.aborted ? '参考视频上传已中断或超时' : '参考视频接收失败', 'receive', error);
    }
  }

  async inspect(path: string, signal: AbortSignal): Promise<InspectedVideoReference['mimeType']> {
    const handle = await open(path, 'r');
    const header = Buffer.alloc(12);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const brand = header.toString('ascii', 8, 12);
    if (header.toString('ascii', 4, 8) !== 'ftyp' || !/^(qt  |isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(brand)) {
      videoUploadError(415, 'UNSUPPORTED_VIDEO_REFERENCE_FORMAT', '文件实际格式必须为 MP4 或 MOV', 'inspect');
    }
    try {
      const { stdout } = await run(process.env.MEDIA_VIDEO_FFPROBE_PATH || 'ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file', '-enable_drefs', '0', '-show_format', '-show_streams', '-of', 'json', path,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, signal });
      const parsed = z.object({ format: z.object({ format_name: z.string() }), streams: z.array(z.object({
        codec_type: z.string(), codec_name: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).optional(),
      })) }).safeParse(JSON.parse(stdout));
      if (!parsed.success || !parsed.data.format.format_name.split(',').includes('mov') || !parsed.data.streams.some(stream =>
        stream.codec_type === 'video' && stream.codec_name && stream.codec_name !== 'unknown' && stream.width > 0 && stream.height > 0 && !stream.disposition?.attached_pic)) {
        videoUploadError(400, 'INVALID_VIDEO_REFERENCE', '参考文件没有可读取的视频轨道', 'inspect');
      }
      return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (signal.aborted) videoUploadError(408, 'VIDEO_REFERENCE_UPLOAD_TIMEOUT', '参考视频检查已中断或超时', 'inspect', error);
      const unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT';
      videoUploadError(unavailable ? 503 : 400, unavailable ? 'VIDEO_INSPECTOR_UNAVAILABLE' : 'INVALID_VIDEO_REFERENCE',
        unavailable ? '参考视频检查工具不可用' : '参考视频损坏或无法安全解析', 'inspect', error);
    }
  }
}
