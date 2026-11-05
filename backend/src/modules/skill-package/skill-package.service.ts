import { BadRequestException, HttpException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, join, posix, resolve, sep } from 'path';
import { TextDecoder } from 'util';
import { inflateRawSync } from 'zlib';
import AdmZip from 'adm-zip';
import { isSupportedArchiveFilename, normalizeArchive } from '../archive/archive-normalizer';
import { isSafeSkillPathComponent, SkillArtifactFrontmatterSchema } from 'shared';
import { parseSkillMarkdown, prepareSkillMarkdown, SKILL_CONTENT_MAX_BYTES, skillLocalResourceReferences } from '../../shared/skill-content';
import { SKILL_PACKAGE_MAX_BYTES, SKILL_PACKAGE_MAX_ENTRIES, SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES } from '../../shared/skill-content-schema';
import { StorageService } from '../upload/storage/storage.service';

export { SKILL_PACKAGE_MAX_BYTES } from '../../shared/skill-content-schema';
/** 解压后总字节上限 —— 压缩比炸弹（几 KB 解出几 GB）只能靠这条拦。 */
const MAX_UNCOMPRESSED_BYTES = SKILL_PACKAGE_MAX_UNCOMPRESSED_BYTES;
/** 条目数上限，防止上万个空条目把解析拖死。 */
const MAX_ENTRIES = SKILL_PACKAGE_MAX_ENTRIES;
/** SKILL.md 正文上限 */
const MAX_SKILL_MARKDOWN_BYTES = SKILL_CONTENT_MAX_BYTES;
/** 包里必须存在的入口文件；按 basename 精确匹配，不能用 endsWith（会误收 NOTSKILL.md）。 */
const SKILL_ENTRY_NAME = 'SKILL.md';
/** zip 魔数 PK\x03\x04。只看扩展名会被改名的任意文件骗过。 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

type AdmZipEntryWithRawName = { rawEntryName?: Buffer };
export interface SkillPackageWarning { code: string; message: string; path?: string }

/** 按 sha256 重新解包得到的内容 —— 全部字段都从 zip 本身推导，不含客户端输入。 */
export interface SkillPackageContent {
  /** 存储 key，`skills/<sha256>.zip` */
  key: string;
  sha256: string;
  fileCount: number;
  /** zip 自身字节数 */
  totalBytes: number;
  /** SKILL.md 剥掉 frontmatter 的正文 */
  content: string;
  /** frontmatter 里可用于预填能力信息的字段 */
  suggested: { name: string | null; description: string | null };
  warnings: SkillPackageWarning[];
}

export interface StoredSkillPackage extends SkillPackageContent {
  /** 上传时的原始文件名。仅用于展示，真正的定位靠 sha256。 */
  filename: string;
}

export interface InstallableSkillPackage {
  buffer: Buffer;
  sha256: string;
  skillName: string;
  content: string;
  entryPath: string;
  entrySha256: string;
  /** ZIP 自身字节数，与 store/read 的语义一致。 */
  totalBytes: number;
  fileCount: number;
  warnings: SkillPackageWarning[];
}

/**
 * SKILL 包（zip）的解析与内容寻址存储。
 *
 * 内容寻址（文件名即 sha256）带来两个性质，上层依赖它们：
 *   1. 同一份包重复上传只落一次盘；
 *   2. 拿着 sha256 就能重新取回**当初校验过的那份正文** —— 所以创建能力时
 *      服务端从这里重读正文，而不是接受客户端回传，否则可以拿 A 包的哈希
 *      配 B 包的正文绕过自动校验。
 *
 * 故意不依赖 CapabilityValidatorService：解析与业务校验分属两层，
 * 由调用方组合（见 CapabilityContributionController.uploadSkillPackage）。
 */
@Injectable()
export class SkillPackageService {
  private readonly root: string;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly storage?: StorageService,
  ) {
    this.root = resolve(
      this.config.get<string>('SKILL_PACKAGE_DIR') || './uploads/skills',
    );
  }

  /** 解析并落盘。已存在同 sha256 的包时跳过写入。 */
  async store(file: Express.Multer.File): Promise<StoredSkillPackage> {
    if (!file?.buffer?.length) throw new BadRequestException('未上传文件');
    if (file.buffer.length > SKILL_PACKAGE_MAX_BYTES) {
      throw new BadRequestException(
        `包不能超过 ${Math.floor(SKILL_PACKAGE_MAX_BYTES / 1024 / 1024)}MB`,
      );
    }
    if (!isSupportedArchiveFilename(file.originalname)) {
      throw new BadRequestException('仅支持 ZIP、TAR、TAR.GZ 或 TGZ 压缩包');
    }
    let source: Buffer;
    try {
      source = await normalizeArchive(file.originalname, file.buffer, {
        maxEntries: MAX_ENTRIES,
        maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '压缩包无法解析');
    }
    this.assertZipMagic(source);
    const buffer = this.normalizeEntrySeparators(source);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const parsed = this.packageContent(this.validatePackage(buffer, sha256));

    if (this.usesSharedStorage()) {
      await this.storage!.put({ key: parsed.key, buffer, mime: 'application/zip', filename: file.originalname });
    } else {
      await mkdir(this.root, { recursive: true });
      // wx：已存在就不重写。内容寻址下同名即同内容，重写只是浪费 IO。
      try {
        await writeFile(this.resolveStoredPath(parsed.key), buffer, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }

    return { ...parsed, filename: this.sanitizeFilename(file.originalname) };
  }

  /**
   * 按 sha256 取回已上传的包并重新提取正文。
   * 创建能力 / 发布新版本时走这条路，正文来源永远是磁盘上那份字节。
   */
  async read(sha256: string): Promise<SkillPackageContent> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new BadRequestException('sha256 格式非法');
    }
    const key = this.keyFor(sha256);
    let buffer: Buffer;
    try {
      buffer = await this.readBytes(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('上传的 SKILL 包不存在或已过期，请重新上传');
      }
      throw error;
    }
    return this.packageContent(this.validatePackage(buffer, sha256));
  }

  /** 上传、发布重读与安装共用相同的包校验。 */
  async readInstallablePackage(sha256: string): Promise<InstallableSkillPackage> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new BadRequestException('sha256 格式非法');
    }
    // 存储异常不属于包解析异常，尤其不能把未找到的 404 转成 400。
    let buffer: Buffer;
    try {
      buffer = await this.readBytes(this.keyFor(sha256));
    } catch (error) {
      const storageError = error as { code?: string; status?: number };
      if ((error instanceof HttpException && error.getStatus() === 404) ||
        (storageError?.code === 'NoSuchKey' && storageError.status === 404)) {
        throw new NotFoundException('上传的 SKILL 包不存在或已过期，请重新上传');
      }
      throw error;
    }
    const pkg = this.validatePackage(buffer, sha256);
    this.assertInstallablePaths(buffer);
    const zip = new AdmZip(buffer);
    const original = zip.getEntry(pkg.entryPath)!.getData();
    // Approved package bodies use LF; deliver the same body to byte-sensitive installers.
    const prepared = prepareSkillMarkdown(original.toString('utf8').replace(/\r\n?/g, '\n'), pkg.skillName);
    if (prepared.status !== 'AVAILABLE') throw new BadRequestException('技能正文不能为空');
    const entryPath = posix.join(posix.dirname(pkg.entryPath), SKILL_ENTRY_NAME);
    if (prepared.content === original.toString('utf8') && entryPath === pkg.entryPath) return pkg;
    const entryTime = zip.getEntry(pkg.entryPath)!.header.time;
    zip.deleteFile(pkg.entryPath);
    const entryBytes = Buffer.from(prepared.content, 'utf8');
    zip.addFile(entryPath, entryBytes).header.time = entryTime;
    const normalized = zip.toBuffer();
    const normalizedSha256 = crypto.createHash('sha256').update(normalized).digest('hex');
    const finalPackage = this.validatePackage(normalized, normalizedSha256);
    this.assertInstallablePaths(normalized);
    if (finalPackage.content !== pkg.content) throw new BadRequestException('规范化后的技能正文不一致');
    return { ...finalPackage, warnings: pkg.warnings };
  }

  private assertInstallablePaths(buffer: Buffer): void {
    const paths = new Map<string, { path: string; directory: boolean; explicit: boolean }>();
    for (const entry of new AdmZip(buffer).getEntries()) {
      if ((entry.header.flags & 1) || ![0, 8].includes(entry.header.method)) {
        throw new BadRequestException('ZIP 包含加密条目或不支持的压缩方式');
      }
      const type = (entry.attr >>> 16) & 0xf000;
      if (type && type !== 0x8000 && type !== 0x4000) throw new BadRequestException('ZIP 包含特殊文件');
      const parts = (entry.entryName.endsWith('/') ? entry.entryName.slice(0, -1) : entry.entryName).split('/');
      for (let index = 0; index < parts.length; index += 1) {
        const path = parts.slice(0, index + 1).join('/');
        const key = path.normalize('NFKC').toLowerCase();
        const explicit = index === parts.length - 1;
        const directory = !explicit || entry.isDirectory;
        const previous = paths.get(key);
        if (previous && (previous.path !== path || previous.directory !== directory ||
          (previous.explicit && explicit))) {
          throw new BadRequestException('ZIP 包含大小写、Unicode 或文件目录冲突');
        }
        paths.set(key, { path, directory, explicit: explicit || previous?.explicit === true });
      }
    }
  }

  private validatePackage(buffer: Buffer, sha256: string): InstallableSkillPackage {
    try {
      if (buffer.length > SKILL_PACKAGE_MAX_BYTES) {
        throw new BadRequestException('包不能超过 100MiB');
      }
      this.assertZipMagic(buffer);
      if (crypto.createHash('sha256').update(buffer).digest('hex') !== sha256) {
        throw new BadRequestException('SKILL 包 SHA256 不匹配');
      }
      const entries = this.validateEntries(buffer);
      for (const entry of entries) {
        this.assertInstallableLocalHeader(buffer, entry);
        this.assertInstallableEntryName(entry.entryName, entry.isDirectory);
        // adm-zip omits maxOutputLength for size=0; budget-check empty streams first.
        if (!entry.isDirectory && entry.header.method === 8 && entry.header.size === 0) {
          const bytes = inflateRawSync(entry.getCompressedData(), { maxOutputLength: 1 });
          if (bytes.length !== 0) {
            throw new BadRequestException('ZIP 条目大小不匹配');
          }
        }
      }
      if (entries.some((entry) => ((entry.attr >>> 16) & 0xf000) === 0xa000)) {
        throw new BadRequestException('包内不能包含符号链接');
      }
      const files = entries.filter((entry) => !entry.isDirectory);
      const warnings: SkillPackageWarning[] = [];
      const skillEntries = files.filter(
        (entry) => posix.basename(entry.entryName).toLowerCase() === SKILL_ENTRY_NAME.toLowerCase(),
      ).sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length ||
        (a.entryName < b.entryName ? -1 : a.entryName > b.entryName ? 1 : 0));
      if (!skillEntries.length) throw new BadRequestException('包内未找到 SKILL.md 入口');
      const skillEntry = skillEntries[0];
      if (skillEntries.length > 1) warnings.push({ code: 'MULTIPLE_ENTRIES', path: skillEntry.entryName,
        message: `检测到多个技能入口，已选择 ${skillEntry.entryName}（优先根目录，再按层级和路径排序）；其他文件保留，不影响审核通过。` });
      if (skillEntry.header.size > MAX_SKILL_MARKDOWN_BYTES) {
        throw new BadRequestException('SKILL.md 不能超过 2MiB');
      }
      let entryBytes: Buffer | undefined;
      let uncompressed = 0;
      // 附件也读取一次以校验 CRC/损坏压缩数据，不能只校验入口。
      for (const entry of files) {
        const bytes = entry.getData();
        if (bytes.length !== entry.header.size) {
          throw new BadRequestException('ZIP 条目大小不匹配');
        }
        uncompressed += bytes.length;
        if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
          throw new BadRequestException('解压后体积超过 500MiB');
        }
        if (entry === skillEntry) entryBytes = bytes;
      }
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entryBytes!);
      const parsed = parseSkillMarkdown(raw);
      const frontmatter = SkillArtifactFrontmatterSchema.safeParse(parsed.data);
      if (!parsed.content.trim()) throw new BadRequestException('技能正文不能为空');
      const prepared = prepareSkillMarkdown(raw, `skill-${sha256.slice(0, 12)}`);
      if (prepared.status !== 'AVAILABLE') throw new BadRequestException('技能正文无法读取');
      const name = prepared.skillName;
      if (!parsed.hasFrontmatter || !frontmatter.success) warnings.push({ code: 'METADATA_NORMALIZED', message: '元数据缺失或格式不规范，安装时会自动补齐兼容信息。' });
      const entryPath = skillEntry.entryName;
      const directory = posix.dirname(entryPath);
      const paths = new Set(files.map((entry) => entry.entryName.normalize('NFKC')));
      for (const reference of skillLocalResourceReferences(parsed.content)) {
        let resource: string;
        try { resource = decodeURIComponent(reference); } catch { resource = reference; }
        const target = posix.normalize(posix.join(directory, resource)).normalize('NFKC');
        if (resource.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(resource) ||
          target === '..' || target.startsWith('../') || !paths.has(target)) {
          warnings.push({ code: 'RESOURCE_REFERENCE', path: reference,
            message: `资源引用未匹配到包内文件：${reference}。可能影响运行，请确认是否为运行时生成或外部提供的文件；不影响审核通过。` });
        }
      }
      return {
        buffer,
        sha256,
        skillName: name,
        content: parsed.content.trimStart(),
        entryPath,
        entrySha256: crypto.createHash('sha256').update(entryBytes!).digest('hex'),
        totalBytes: buffer.length,
        fileCount: files.length,
        warnings,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('SKILL 包非法或已损坏');
    }
  }

  private packageContent(pkg: InstallableSkillPackage): SkillPackageContent {
    const zip = new AdmZip(pkg.buffer);
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(zip.getEntry(pkg.entryPath)!.getData());
    const parsed = parseSkillMarkdown(raw);
    return { key: this.keyFor(pkg.sha256), sha256: pkg.sha256, fileCount: pkg.fileCount,
      totalBytes: pkg.totalBytes, content: pkg.content,
      suggested: { name: this.readFrontmatterString(parsed.data, 'name', 100) ?? pkg.skillName, description: this.readFrontmatterString(parsed.data, 'description', 2000) },
      warnings: pkg.warnings };
  }

  /** 读取已存储的原始 ZIP；OSS 与本地磁盘共用此下载入口。 */
  async readBytes(key: string): Promise<Buffer> {
    this.assertStorageKey(key);
    try {
      return this.usesSharedStorage()
        ? await this.storage!.get(key)
        : await readFile(this.resolveStoredPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('上传的 SKILL 包不存在或已过期，请重新上传');
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
    if (!key.startsWith('skills/') || !/^[0-9a-f]{64}\.zip$/.test(key.slice('skills/'.length))) {
      throw new BadRequestException('Skill 存储 key 非法');
    }
  }

  /**
   * key → 绝对路径。
   * key 只应来自我们自己写入的 DB 字段（SkillVersion.packageKey、
   * Capability.metadata.zipPath），但仍然按不可信输入处理：先要求 `skills/`
   * 前缀，再校验解析结果没有跑出存储根。少了前缀这层，一个被改写的 key
   * 就能读到 uploads/ 下别的子目录。
   */
  resolveStoredPath(key: string): string {
    const normalized = key.replace(/\\/g, '/');
    if (!normalized.startsWith('skills/')) {
      throw new BadRequestException('非法的存储路径');
    }
    const target = resolve(join(this.root, normalized.slice('skills/'.length)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new BadRequestException('非法的存储路径');
    }
    return target;
  }

  private keyFor(sha256: string) {
    return `skills/${sha256}.zip`;
  }

  private validateEntries(buffer: Buffer): AdmZip.IZipEntry[] {
    const entries = new AdmZip(buffer).getEntries();
    const files = entries.filter((entry) => !entry.isDirectory);

    if (entries.length > MAX_ENTRIES) {
      throw new BadRequestException(`包内条目不能超过 ${MAX_ENTRIES} 个`);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const rawEntryName = (entry as AdmZipEntryWithRawName).rawEntryName;
      const normalizedName = entry.entryName.replace(/\\/g, '/').normalize('NFKC');
      // adm-zip may normalize traversal names before exposing entryName.
      // Validate the original central-directory name as well.
      this.assertSafeEntryName(rawEntryName?.toString('utf8') ?? entry.entryName, entry.entryName);
      if (seen.has(normalizedName)) {
        throw new BadRequestException(`包内包含重复路径：${entry.entryName}`);
      }
      seen.add(normalizedName);
    }
    const uncompressed = files.reduce((sum, entry) => sum + entry.header.size, 0);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new BadRequestException(
        `解压后体积超过 ${Math.floor(MAX_UNCOMPRESSED_BYTES / 1024 / 1024)}MB，请精简包内容`,
      );
    }
    return entries;
  }

  private assertZipMagic(buffer: Buffer) {
    const matched =
      buffer.length >= ZIP_MAGIC.length &&
      ZIP_MAGIC.every((byte, index) => buffer[index] === byte);
    if (!matched) throw new BadRequestException('文件内容不是有效的 zip');
  }

  /**
   * 拒绝会写到解压目录之外的条目名。这里只解析内存里的 zip、不落盘解压，
   * 但包会被下发给客户端与 OpenCode 服务解压，恶意条目名必须在入口就拦掉。
   */
  private assertSafeEntryName(entryName: string, displayName = entryName) {
    const normalized = entryName.replace(/\\/g, '/');
    const unsafe =
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').includes('..');
    if (unsafe) {
      throw new BadRequestException(`包内条目名非法：${displayName}`);
    }
  }

  private assertInstallableEntryName(entryName: string, isDirectory: boolean) {
    const path = isDirectory && entryName.endsWith('/') ? entryName.slice(0, -1) : entryName;
    for (const part of path.split('/')) {
      const normalized = part.normalize('NFKC').toLowerCase();
      if (normalized === '.sep-package-manifest.json') {
        throw new BadRequestException('包内路径不能使用客户端缓存清单保留名 .sep-package-manifest.json');
      }
      if (/[\p{Cc}\p{Cf}]/u.test(normalized)) {
        throw new BadRequestException('包内路径不能包含控制字符或不可见格式字符');
      }
    }
    if (!entryName || entryName.length > 1024 || !path.split('/').every(isSafeSkillPathComponent)) {
      throw new BadRequestException('包内条目必须为安全相对路径');
    }
    return entryName;
  }

  private normalizeEntrySeparators(buffer: Buffer): Buffer {
    const entries = this.validateEntries(buffer);
    const zip = new AdmZip(buffer);
    const outputEntries = zip.getEntries();
    let changed = false;

    for (let index = 0; index < entries.length; index += 1) {
      const normalized = this.assertInstallableLocalHeader(buffer, entries[index], true);
      if (outputEntries[index].entryName !== normalized) {
        outputEntries[index].entryName = normalized;
        changed = true;
      }
    }

    return changed ? zip.toBuffer() : buffer;
  }

  private assertInstallableLocalHeader(
    buffer: Buffer,
    entry: AdmZip.IZipEntry,
    normalizeSeparators = false,
  ): string {
    // adm-zip exposes central names only; streaming extractors may use local names.
    const { offset, flags, method, compressedSize } = entry.header;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 30 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x04034b50) {
      throw new BadRequestException('ZIP 本地文件头非法');
    }
    const nameLength = buffer.readUInt16LE(offset + 26);
    const nameEnd = offset + 30 + nameLength;
    const dataOffset = nameEnd + buffer.readUInt16LE(offset + 28);
    const centralName = (entry as AdmZipEntryWithRawName).rawEntryName;
    const localName = buffer.subarray(offset + 30, nameEnd);
    if (dataOffset > buffer.length || dataOffset + compressedSize > buffer.length ||
      !centralName || !localName.equals(centralName) ||
      buffer.readUInt16LE(offset + 6) !== flags || buffer.readUInt16LE(offset + 8) !== method) {
      throw new BadRequestException('ZIP 本地文件头与中央目录不一致');
    }
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(localName);
    const validatedName = normalizeSeparators ? name.replace(/\\/g, '/') : name;
    this.assertInstallableEntryName(validatedName, entry.isDirectory || validatedName.endsWith('/'));
    return validatedName;
  }

  /** 只取展示用的文件名：去掉路径分隔符，限长，保留 .zip 后缀。 */
  private sanitizeFilename(original: string) {
    const name = basename(original.replace(/\\/g, '/')).slice(-120);
    return name || 'package.zip';
  }

  private readFrontmatterString(
    data: Record<string, unknown>,
    key: string,
    maxLength: number,
  ): string | null {
    const value = data?.[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, maxLength) : null;
  }
}
