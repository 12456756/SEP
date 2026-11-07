import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OSS from 'ali-oss';
import {
  DEFAULT_URL_TTL_SECONDS,
  PutObjectInput,
  StorageDriver,
  StoredObject,
} from './storage.types';

export interface OssConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint?: string;
}

/**
 * 读取并校验 OSS 配置。四个必填项缺任意一个就返回 null ——
 * 由 StorageService 据此回退到本地驱动，而不是启动即崩。
 */
export function readOssConfig(config: ConfigService): OssConfig | null {
  const region = config.get<string>('OSS_REGION');
  const accessKeyId = config.get<string>('OSS_ACCESS_KEY_ID');
  const accessKeySecret = config.get<string>('OSS_ACCESS_KEY_SECRET');
  const bucket = config.get<string>('OSS_BUCKET');

  if (!region || !accessKeyId || !accessKeySecret || !bucket) return null;

  return {
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint: config.get<string>('OSS_ENDPOINT') || undefined,
  };
}

/**
 * 阿里云 OSS 驱动。
 *
 * 对象一律私有读，前端拿到的都是 1 小时有效期的签名 URL；这样即使
 * 聊天记录被转发，链接过期后也访问不到。
 */
@Injectable()
export class OssStorageDriver implements StorageDriver {
  readonly name = 'oss' as const;

  private readonly logger = new Logger(OssStorageDriver.name);
  private readonly client: OSS;

  constructor(cfg: OssConfig) {
    this.client = new OSS({
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      secure: true,
    });
    this.logger.log(`OSS driver ready (bucket=${cfg.bucket}, region=${cfg.region})`);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    await this.client.put(input.key, input.buffer, {
      mime: input.mime,
      headers: {
        // 私有读：不带签名直接访问会 403
        'x-oss-object-acl': 'private',
        // 附件名用 RFC 5987 编码，中文名下载时不会乱码
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(
          input.filename,
        )}`,
      },
    });

    return {
      key: input.key,
      url: await this.getSignedUrl(input.key),
      size: input.buffer.length,
    };
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.get(key);
    return result.content as Buffer;
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix || prefix.includes('\0') || !prefix.endsWith('/') || prefix.startsWith('/')) {
      throw new Error('Invalid object prefix');
    }

    let continuationToken: string | undefined;
    do {
      const result = await this.client.listV2({
        prefix,
        'max-keys': 1000,
        ...(continuationToken ? { 'continuation-token': continuationToken } : {}),
      });
      const names = result.objects
        .map((object) => object.name)
        .filter((name): name is string => typeof name === 'string' && name.startsWith(prefix));
      for (let offset = 0; offset < names.length; offset += 1000) {
        await this.deleteBatchWithRetry(names.slice(offset, offset + 1000));
      }
      continuationToken = result.isTruncated ? result.nextContinuationToken : undefined;
    } while (continuationToken);
  }

  private async deleteBatchWithRetry(names: string[]): Promise<void> {
    if (names.length === 0) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.deleteMulti(names, { quiet: true });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          this.logger.warn(`OSS deleteMulti failed (attempt ${attempt}/3), retrying`);
        }
      }
    }
    throw lastError;
  }

  async getSignedUrl(
    key: string,
    expiresInSeconds = DEFAULT_URL_TTL_SECONDS,
  ): Promise<string> {
    // signatureUrl 是同步返回的，包一层 Promise 以符合驱动接口
    return this.client.signatureUrl(key, { expires: expiresInSeconds });
  }
}
