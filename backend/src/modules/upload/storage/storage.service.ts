import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { LocalStorageDriver } from './local-storage.driver';
import { OssStorageDriver, readOssConfig } from './oss-storage.driver';
import {
  DEFAULT_URL_TTL_SECONDS,
  PutObjectInput,
  StorageDriver,
  StoredObject,
} from './storage.types';

export interface StorageKeyParts {
  enterpriseId: string | null;
  userId: string;
  /** 已清洗过的文件名 */
  safeName: string;
}

/**
 * 存储门面：对外只暴露 put/delete/getSignedUrl，内部按配置选驱动。
 *
 * 配了 OSS_* 四件套就走 OSS，否则落本地磁盘。这样本地开发和演示环境
 * 无需云凭据即可跑通完整上传链路，生产只改环境变量。
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: StorageDriver;

  constructor(
    private readonly config: ConfigService,
    private readonly localDriver: LocalStorageDriver,
  ) {
    const ossConfig = readOssConfig(this.config);
    if (ossConfig) {
      this.driver = new OssStorageDriver(ossConfig);
    } else {
      this.driver = this.localDriver;
      this.logger.warn(
        'OSS 未配置（缺少 OSS_REGION / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET），使用本地磁盘存储',
      );
    }
  }

  get driverName(): StorageDriver['name'] {
    return this.driver.name;
  }

  /**
   * 生成存储键：`{enterpriseId}/{userId}/{timestamp}_{random}_{safeName}`。
   *
   * 按企业/用户分目录是为了存储隔离 —— 后续做配额统计或企业级清理时，
   * 可以直接按前缀操作。随机段防止同一毫秒内的同名文件互相覆盖。
   */
  buildKey({ enterpriseId, userId, safeName }: StorageKeyParts): string {
    const scope = enterpriseId || 'personal';
    const nonce = randomBytes(4).toString('hex');
    return `${scope}/${userId}/${Date.now()}_${nonce}_${safeName}`;
  }

  put(input: PutObjectInput): Promise<StoredObject> {
    return this.driver.put(input);
  }

  get(key: string): Promise<Buffer> {
    return this.driver.get(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  /**
   * 永久删除企业的全部上传文件。企业 ID 必须是单一路径段，避免把
   * 任意路径交给存储驱动。
   */
  deleteEnterpriseFiles(enterpriseId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(enterpriseId)) {
      throw new BadRequestException('企业 ID 格式不正确');
    }
    return this.driver.deletePrefix(`${enterpriseId}/`);
  }

  getSignedUrl(
    key: string,
    expiresInSeconds = DEFAULT_URL_TTL_SECONDS,
  ): Promise<string> {
    return this.driver.getSignedUrl(key, expiresInSeconds);
  }
}
