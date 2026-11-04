import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, resolve, sep } from "path";
import AdmZip from "adm-zip";
import { isSupportedArchiveFilename, normalizeArchive } from '../archive/archive-normalizer';
import { StorageService } from '../upload/storage/storage.service';

export const RPA_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_INSPECT_BYTES = 2 * 1024 * 1024;
const SENSITIVE_NAME =
  /(^|\/)(?:\.env(?:\.|$)|id_rsa(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*(?:private[-_ ]?key|access[-_ ]?token).*)/i;
const SENSITIVE_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*[^\s]{6,}/i;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

type AdmZipEntryWithRawName = AdmZipEntry & { rawEntryName?: Buffer };

type AdmZipEntry = {
  entryName: string;
  rawEntryName?: Buffer;
  isDirectory: boolean;
  header?: { size?: number };
  getData(): Buffer;
};

export interface StoredRpaPackage {
  key: string;
  sha256: string;
  filename: string;
  fileCount: number;
  totalBytes: number;
  uncompressedBytes: number;
  files: string[];
}

@Injectable()
export class RpaPackageService {
  private readonly root: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly storage?: StorageService,
  ) {
    this.root = resolve(
      this.config.get<string>("RPA_PACKAGE_DIR") || "./uploads/rpa",
    );
  }

  async store(file: Express.Multer.File): Promise<StoredRpaPackage> {
    if (!file?.buffer?.length) throw new BadRequestException("未上传 RPA 包");
    if (!isSupportedArchiveFilename(file.originalname))
      throw new BadRequestException("仅支持 ZIP、TAR、TAR.GZ 或 TGZ 压缩包");
    if (file.buffer.length > RPA_PACKAGE_MAX_BYTES) {
      throw new BadRequestException(
        `RPA 包不能超过 ${Math.floor(RPA_PACKAGE_MAX_BYTES / 1024 / 1024)}MB`,
      );
    }
    let buffer: Buffer;
    try {
      buffer = await normalizeArchive(file.originalname, file.buffer, {
        maxEntries: MAX_ENTRIES,
        maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '压缩包无法解析');
    }
    if (buffer.length > RPA_PACKAGE_MAX_BYTES) {
      throw new BadRequestException('转换后的 RPA ZIP 不能超过 50MB');
    }
    this.assertZipMagic(buffer);
    const sha256 = crypto
      .createHash("sha256")
      .update(buffer)
      .digest("hex");
    const parsed = this.parse(buffer, sha256);
    if (this.usesSharedStorage()) {
      await this.storage!.put({ key: parsed.key, buffer, mime: 'application/zip', filename: file.originalname });
    } else {
      await mkdir(this.root, { recursive: true });
      try {
        await writeFile(this.resolveStoredPath(parsed.key), buffer, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return { ...parsed, filename: this.sanitizeFilename(file.originalname) };
  }

  async read(sha256: string): Promise<StoredRpaPackage> {
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new BadRequestException("RPA 包 sha256 格式非法");
    let buffer: Buffer;
    try {
      buffer = await this.readBytes(this.keyFor(sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new NotFoundException("RPA 包不存在或已过期，请重新上传");
      throw error;
    }
    return { ...this.parse(buffer, sha256), filename: `${sha256}.zip` };
  }

  async readBytes(key: string): Promise<Buffer> {
    this.assertStorageKey(key);
    try {
      return this.usesSharedStorage()
        ? await this.storage!.get(key)
        : await readFile(this.resolveStoredPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('RPA 包不存在或已过期，请重新上传');
      }
      throw error;
    }
  }

  isSharedStorage() {
    return this.usesSharedStorage();
  }

  private usesSharedStorage() {
    return this.storage?.driverName === 'oss';
  }

  private assertStorageKey(key: string) {
    if (!key.startsWith('rpa/') || !/^[0-9a-f]{64}\.zip$/.test(key.slice('rpa/'.length))) {
      throw new BadRequestException('RPA 存储 key 非法');
    }
  }

  resolveStoredPath(key: string): string {
    this.assertStorageKey(key);
    if (!key.startsWith("rpa/"))
      throw new BadRequestException("RPA 存储 key 非法");
    const absolute = resolve(this.root, key.slice("rpa/".length));
    const root = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (absolute !== this.root && !absolute.startsWith(root))
      throw new BadRequestException("RPA 存储路径越界");
    return absolute;
  }

  private keyFor(sha256: string) {
    return `rpa/${sha256}.zip`;
  }

  private parse(
    buffer: Buffer,
    sha256: string,
  ): Omit<StoredRpaPackage, "filename"> {
    this.assertZipMagic(buffer);
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new BadRequestException("RPA ZIP 无法解析");
    }
    const entries = zip.getEntries();
    if (!entries.length) throw new BadRequestException("RPA ZIP 不能为空");
    if (entries.length > MAX_ENTRIES)
      throw new BadRequestException(`RPA ZIP 文件数不能超过 ${MAX_ENTRIES}`);

    let uncompressedBytes = 0;
    const files: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const rawEntryName = (entry as AdmZipEntryWithRawName).rawEntryName;
      const name = entry.entryName.replace(/\\/g, "/");
      // adm-zip normalizes some ../ names while parsing. Validate the original
      // central-directory name as well, otherwise a malicious archive could pass
      // the path check only because the parser cleaned the evidence first.
      this.assertSafeEntryName(
        rawEntryName ? rawEntryName.toString("utf8") : name,
        entry.entryName,
      );
      if (seen.has(name))
        throw new BadRequestException(`RPA ZIP 包含重复路径：${name}`);
      seen.add(name);
      if (entry.isDirectory) continue;
      if (SENSITIVE_NAME.test(name))
        throw new BadRequestException(
          `RPA ZIP 不应包含凭据或私钥文件：${name}`,
        );
      const size = entry.header?.size;
      if (!Number.isSafeInteger(size) || size < 0)
        throw new BadRequestException(`RPA ZIP 文件大小信息非法：${name}`);
      uncompressedBytes += size;
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES)
        throw new BadRequestException("RPA ZIP 解压后大小超过限制");
      if (
        size <= MAX_INSPECT_BYTES &&
        /\.(?:txt|json|ya?ml|ini|cfg|conf|xml|js|ts|py|bat|sh|md)$/i.test(name)
      ) {
        let content: Buffer;
        try {
          content = entry.getData();
        } catch {
          throw new BadRequestException(`RPA ZIP 文件无法读取：${name}`);
        }
        if (SENSITIVE_CONTENT.test(content.toString("utf8")))
          throw new BadRequestException(`RPA ZIP 疑似包含明文凭据：${name}`);
      }
      files.push(name);
    }
    files.sort();
    return {
      key: this.keyFor(sha256),
      sha256,
      fileCount: files.length,
      totalBytes: buffer.length,
      uncompressedBytes,
      files,
    };
  }

  private assertZipMagic(buffer: Buffer) {
    if (ZIP_MAGIC.some((value, index) => buffer[index] !== value))
      throw new BadRequestException("上传文件不是有效 ZIP");
  }

  private assertSafeEntryName(rawName: string, displayName: string) {
    const name = rawName.replace(/\\/g, "/");
    if (
      !name ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[A-Za-z]:\//.test(name) ||
      name.split("/").includes("..")
    ) {
      throw new BadRequestException(`RPA ZIP 包含非法路径：${displayName}`);
    }
  }

  private sanitizeFilename(filename: string) {
    const clean = basename(filename)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
      .trim();
    return clean || "rpa-package.zip";
  }
}
