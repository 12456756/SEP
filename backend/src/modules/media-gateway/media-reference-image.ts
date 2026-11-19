import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import sharp from 'sharp';
import type { MediaReferenceMimeType } from 'shared';
import { inspectMediaPng } from './media-png';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

const MAX_DIMENSION = 4096;
const MAX_INSPECTIONS = 2;
const MAX_WAITING = 16;
let inspecting = 0;
const waiting: Array<() => void> = [];

export type ReferenceImageMetadata = {
  mimeType: MediaReferenceMimeType; extension: 'png' | 'jpg' | 'webp'; width: number; height: number;
};

function invalid(message: string, cause?: unknown): never {
  throw new BadRequestException({ error: { code: 'INVALID_REFERENCE', message,
    ...(cause !== undefined ? { cause: exceptionDetails(cause) } : {}) } });
}

async function acquire() {
  if (inspecting < MAX_INSPECTIONS) { inspecting++; return; }
  if (waiting.length >= MAX_WAITING) {
    throw new ServiceUnavailableException({ error: { code: 'REFERENCE_INSPECTOR_BUSY', message: '参考图检查繁忙，请稍后重试' } });
  }
  await new Promise<void>(resolve => waiting.push(resolve));
}

/** Decode only to validate; callers must store and forward the original bytes. */
export async function inspectReferenceImage(bytes: Buffer, maxBytes: number, declaredMime?: string): Promise<ReferenceImageMetadata> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes) invalid('参考图为空或超过大小限制');
  let mimeType: MediaReferenceMimeType;
  let extension: ReferenceImageMetadata['extension'];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png'; extension = 'png';
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg'; extension = 'jpg';
  } else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('WebP 文件长度无效');
    mimeType = 'image/webp'; extension = 'webp';
  } else invalid('仅支持 JPEG、PNG、WebP 参考图');
  if (declaredMime !== undefined && declaredMime !== mimeType) invalid('参考图声明的 MIME 与实际文件格式不一致');

  await acquire();
  try {
    if (mimeType === 'image/png') return { ...inspectMediaPng(bytes, maxBytes), mimeType, extension };
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_DIMENSION ** 2 }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    if (metadata.format !== (mimeType === 'image/jpeg' ? 'jpeg' : 'webp') ||
        !metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION ||
        (metadata.pages ?? 1) !== 1) invalid('参考图须为宽高不超过 4096 像素的静态单图');
    // Decode every pixel through the timeout-aware pipeline; discard the result.
    await image.raw().toBuffer();
    return { mimeType, extension, width: metadata.width, height: metadata.height };
  } catch (cause) {
    if (cause instanceof BadRequestException) throw cause;
    invalid('参考图文件损坏或无法解码', cause);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inspecting--;
  }
}
