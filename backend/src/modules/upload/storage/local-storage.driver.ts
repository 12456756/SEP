import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'fs/promises';
import { dirname, join, normalize, resolve, sep } from 'path';
import {
  DEFAULT_URL_TTL_SECONDS,
  PutObjectInput,
  StorageDriver,
  StoredObject,
} from './storage.types';

/**
 * 本地磁盘驱动 —— 未配置 OSS 时的默认实现。
 *
 * 访问控制用 HMAC 签名 URL 而不是 JWT 守卫：聊天里的图片要走
 * `<img src>` 渲染，浏览器发不出 Authorization 头。签名把「谁能看」
 * 收敛成「谁拿到了这条时效链接」，与 OSS 签名 URL 的语义保持一致，
 * 两个驱动切换时前端无需改动。
 */
@Injectable()
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;

  private readonly logger = new Logger(LocalStorageDriver.name);
  private readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly signingSecret: string;

  constructor(private readonly config: ConfigService) {
    this.root = resolve(
      this.config.get<string>('UPLOAD_LOCAL_DIR') || './uploads/chat',
    );
    // 默认发相对路径（`/uploads/...`）：前端把它拼到 `/api` 前缀后，
    // 图片请求走 Next 的同源代理，不引入跨域也不写死端口。
    // 后端被独立域名直接访问时，配 UPLOAD_PUBLIC_BASE_URL 换成绝对地址。
    this.publicBaseUrl = (
      this.config.get<string>('UPLOAD_PUBLIC_BASE_URL') || ''
    ).replace(/\/+$/, '');
    // 复用 JWT_SECRET 只是为了少一个必填环境变量；需要单独轮换时配
    // UPLOAD_URL_SECRET 即可（此时旧链接会立即失效，符合预期）。
    this.signingSecret =
      this.config.get<string>('UPLOAD_URL_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET');
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const target = this.resolveKey(input.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.buffer);

    this.logger.debug(`Stored ${input.key} (${input.buffer.length} bytes)`);

    return {
      key: input.key,
      url: await this.getSignedUrl(input.key),
      size: input.buffer.length,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (err) {
      // 已经不在了就当删成功，保持幂等
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const target = this.resolveEnterprisePrefix(prefix);
    try {
      await this.removeTree(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async getSignedUrl(
    key: string,
    expiresInSeconds = DEFAULT_URL_TTL_SECONDS,
  ): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = this.sign(key, exp);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBaseUrl}/uploads/${encodedKey}?exp=${exp}&sig=${sig}`;
  }

  get(key: string): Promise<Buffer> {
    return this.read(key);
  }

  /** 读取文件内容供 controller 回传；签名校验由调用方先做。 */
  async read(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('文件不存在或已过期');
      }
      throw err;
    }
  }

  sign(key: string, exp: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${key}:${exp}`)
      .digest('hex');
  }

  /**
   * 校验签名与有效期。返回布尔而不抛异常，让 controller 统一成 403/404，
   * 避免把"键存在但签名错"和"键不存在"区分出来给探测者。
   */
  verifySignature(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = this.sign(key, exp);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(sig ?? '', 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * 把存储键解析成绝对路径，并确保结果仍在根目录内。
   * 键由服务端生成，但多一道校验可以挡住构造出的 `../` 键。
   *
   * 刻意**拒绝**而不是剥掉 `../`：剥掉的话 `../escape.txt` 会被静默改写成
   * `escape.txt`，文件确实还在根目录内，但 put() 返回的 key 与字节实际落
   * 盘的位置不再对应 —— 之后按 key 读取/删除/校验归属全都会对不上。
   */
  private resolveKey(key: string): string {
    const normalized = normalize(key);
    const target = resolve(join(this.root, normalized));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new NotFoundException('文件不存在或已过期');
    }
    return target;
  }

  private resolveEnterprisePrefix(prefix: string): string {
    if (
      !prefix ||
      prefix.includes('\0') ||
      prefix.includes('\\') ||
      prefix.startsWith('/') ||
      !prefix.endsWith('/')
    ) {
      throw new NotFoundException('文件不存在或已过期');
    }
    const normalized = normalize(prefix);
    const canonical = normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
    const segments = canonical.split(sep).filter(Boolean);
    if (
      segments.length !== 1 ||
      segments[0] === '..' ||
      segments[0] === '.' ||
      !/^[A-Za-z0-9_-]+$/.test(segments[0]) ||
      canonical !== prefix
    ) {
      throw new NotFoundException('文件不存在或已过期');
    }
    const target = resolve(join(this.root, canonical));
    if (target === this.root || !target.startsWith(this.root + sep)) {
      throw new NotFoundException('文件不存在或已过期');
    }
    return target;
  }

  /** 删除树时只对 lstat 结果采取动作，永不跟随符号链接。 */
  private async removeTree(path: string): Promise<void> {
    let stat;
    try {
      stat = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await unlink(path);
      return;
    }

    for (const entry of await readdir(path)) {
      await this.removeTree(join(path, entry));
    }
    try {
      await rmdir(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
