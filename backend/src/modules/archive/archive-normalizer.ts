import AdmZip from 'adm-zip';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';

export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'] as const;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const TAR_MAGIC = Buffer.from('ustar');

export interface ArchiveLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  strictExtension?: boolean;
}

export function isSupportedArchiveFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Convert supported source archives to ZIP in memory; consumers keep their existing ZIP pipeline. */
export async function normalizeArchive(
  filename: string,
  buffer: Buffer,
  limits: ArchiveLimits,
): Promise<Buffer> {
  const lower = filename.toLowerCase();
  const isZip = buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
  const isGzip = buffer.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC);
  const expectsGzip = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const expectsTar = lower.endsWith('.tar');
  if (isZip) {
    if (limits.strictExtension && !lower.endsWith('.zip')) throw new Error('压缩包扩展名与内容不匹配');
    return buffer;
  }
  if (!isGzip && !expectsTar) throw new Error('不支持的压缩包格式');
  if (expectsGzip && !isGzip) throw new Error('TAR.GZ 文件格式无效');
  if (isGzip && !expectsGzip) throw new Error('压缩包扩展名与内容不匹配');

  let tarBytes: Buffer;
  try {
    tarBytes = isGzip
      ? gunzipSync(buffer, { maxOutputLength: limits.maxUncompressedBytes + limits.maxEntries * 1024 })
      : buffer;
  } catch {
    throw new Error('TAR.GZ 文件无法解压或超过解压限制');
  }
  if (tarBytes.length < 512 || !tarBytes.subarray(257, 262).equals(TAR_MAGIC)) {
    throw new Error('TAR 文件格式无效');
  }

  const zip = new AdmZip();
  const extract = tar.extract();
  let entryCount = 0;
  let totalBytes = 0;
  let parseError: Error | undefined;
  extract.on('entry', (header, stream, next) => {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      parseError = new Error('压缩包条目数超过限制');
      stream.resume();
      next(parseError);
      return;
    }
    if (header.type === 'directory') {
      stream.resume();
      stream.on('end', next);
      return;
    }
    if (header.type !== 'file' && header.type !== 'contiguous-file') {
      parseError = new Error('TAR 包不能包含链接或特殊文件');
      stream.resume();
      next(parseError);
      return;
    }
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    stream.on('data', (chunk: Buffer) => {
      entryBytes += chunk.length;
      totalBytes += chunk.length;
      if (totalBytes > limits.maxUncompressedBytes) {
        parseError = new Error('压缩包解压后体积超过限制');
        stream.destroy(parseError);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error: Error) => { parseError ??= error; });
    stream.on('end', () => {
      if (header.size !== undefined && entryBytes !== header.size) {
        parseError = new Error('TAR 条目大小不匹配');
        next(parseError);
        return;
      }
      const name = header.name.replace(/^(?:\.\/)+/, '');
      const normalizedName = name.replace(/\\/g, '/');
      if (!name || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) ||
        normalizedName.split('/').includes('..') || name.includes('\\')) {
        parseError = new Error(`TAR 条目路径非法：${name}`);
        stream.resume();
        next(parseError);
        return;
      }
      zip.addFile(name, Buffer.concat(chunks, entryBytes));
      next();
    });
  });
  try {
    const source = Readable.from([tarBytes]);
    await pipeline(source, extract);
  } catch (error) {
    throw parseError ?? (error instanceof Error ? error : new Error('TAR 文件无法解析'));
  }
  if (!entryCount) throw new Error('TAR 包不能为空');
  return zip.toBuffer();
}
