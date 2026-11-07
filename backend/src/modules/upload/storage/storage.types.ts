/**
 * 存储驱动抽象。
 *
 * 目的是让上层（UploadService / 会话流）完全不关心文件落在本地磁盘还是
 * 阿里云 OSS：本地开发不需要 OSS 凭据也能跑通完整链路，生产配上
 * OSS_* 环境变量即自动切换。新增驱动（COS / S3）只需实现这个接口。
 */

export interface StoredObject {
  /** 存储键（对象路径），如 `ent_1/user_2/1699999999_ab12_report.pdf` */
  key: string;
  /** 可直接给前端使用的访问地址（本地驱动为签名 URL，OSS 为签名 URL） */
  url: string;
  size: number;
}

export interface PutObjectInput {
  key: string;
  buffer: Buffer;
  mime: string;
  /** 原始文件名，用于设置下载时的 Content-Disposition */
  filename: string;
}

export interface StorageDriver {
  /** 驱动名，用于日志与健康检查 */
  readonly name: 'local' | 'oss';

  put(input: PutObjectInput): Promise<StoredObject>;

  /**
   * 取回对象内容。会话流需要它来做两件事：把图片字节交给多模态模型，
   * 以及抽取文档正文注入提示词 —— 两者都不能依赖公网可达的 URL
   * （本地开发时上游模型访问不到 localhost）。
   */
  get(key: string): Promise<Buffer>;

  delete(key: string): Promise<void>;

  /** 删除指定目录前缀下的所有对象。操作必须幂等。 */
  deletePrefix(prefix: string): Promise<void>;

  /**
   * 生成带时效的访问地址。
   * @param expiresInSeconds 有效期，默认 1 小时
   */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

/** 签名 URL 默认有效期：1 小时 */
export const DEFAULT_URL_TTL_SECONDS = 3600;
