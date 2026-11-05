import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync, inflateRawSync } from 'zlib';
import AdmZip from 'adm-zip';
import tar from 'tar-stream';
import { gzipSync } from 'node:zlib';
import { StorageService } from '../upload/storage/storage.service';
import { SKILL_PACKAGE_MAX_BYTES, SkillPackageService } from './skill-package.service';

const SKILL_BODY = [
  '# 角色',
  '你是竞品分析助手。',
  '# 输入',
  '竞品名称列表',
  '# 步骤',
  '1. 收集公开资料',
  '# 输出',
  '一份周报',
].join('\n');

function zipWith(entries: Array<[string, string | Buffer]>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  return zip.toBuffer();
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function installableMarkdown(name = 'weekly', description = '生成竞品周报'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n  ${SKILL_BODY}\n`;
}

/**
 * 造带恶意条目名的包。
 * AdmZip 的 addFile 会把 `../../evil.sh` 规范成 `evil.sh`、把 `/etc/x` 规范成
 * `etc/x`，所以先用安全名写入，再直接改 entryName —— 改后的名字能活到 zip
 * 字节里，这才是攻击者真正会送上来的形态。
 */
function zipWithRawName(maliciousName: string, markdown = SKILL_BODY): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(markdown, 'utf8'));
  zip.addFile('placeholder.txt', Buffer.from('x', 'utf8'));
  const planted = zip.getEntries().find((entry) => entry.entryName === 'placeholder.txt');
  if (!planted) throw new Error('fixture 失效：找不到待改名的条目');
  planted.entryName = maliciousName;
  return zip.toBuffer();
}

function upload(buffer: Buffer, originalname = 'skill.zip'): Express.Multer.File {
  return { buffer, originalname, size: buffer.length } as Express.Multer.File;
}

function tarWith(entries: Array<[string, string]>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of entries) {
    const body = Buffer.from(content);
    pack.entry({ name, size: body.length }, body);
  }
  pack.finalize();
  return done;
}

describe('SkillPackageService', () => {
  let root: string;
  let service: SkillPackageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sep-skill-pkg-'));
    service = new SkillPackageService({
      get: () => join(root, 'skills'),
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('store', () => {
    it('解析 SKILL.md 正文、剥掉 frontmatter，并按 sha256 落盘', async () => {
      const buffer = zipWith([
        ['SKILL.md', `---\nname: 竞品周报\ndescription: 生成竞品周报\n---\n${SKILL_BODY}`],
      ]);
      const stored = await service.store(upload(buffer, '竞品周报.zip'));

      expect(stored.content.startsWith('# 角色')).toBe(true);
      expect(stored.content).not.toContain('---');
      expect(stored.key).toBe(`skills/${stored.sha256}.zip`);
      expect(stored.fileCount).toBe(1);
      expect(stored.totalBytes).toBe(buffer.length);
      // frontmatter 用于预填第三步的能力信息
      expect(stored.suggested).toEqual({ name: '竞品周报', description: '生成竞品周报' });
      // 落盘后能按 sha256 重新读回同一份正文
      await expect(service.read(stored.sha256)).resolves.toMatchObject({
        content: stored.content,
        fileCount: 1,
      });
    });

    it('同一份包重复上传落同一个 key（内容寻址去重）', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()]]);
      const first = await service.store(upload(buffer));
      const second = await service.store(upload(buffer, '另一个名字.zip'));
      expect(second.sha256).toBe(first.sha256);
      expect(second.key).toBe(first.key);
    });

    it('没有 frontmatter 时仍可上传并给出兼容提示', async () => {
      await expect(service.store(upload(zipWith([['SKILL.md', SKILL_BODY]])))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'METADATA_NORMALIZED' })]) });
    });

    it('接受嵌在子目录里的 SKILL.md', async () => {
      const stored = await service.store(
        upload(zipWith([['weekly/SKILL.md', installableMarkdown()], ['weekly/ref.md', '附件']])),
      );
      expect(stored.fileCount).toBe(2);
      expect(stored.content.startsWith('# 角色')).toBe(true);
    });

    it('兼容 Windows ZIP 反斜杠目录并将存储包规范化为正斜杠', async () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      zip.addFile('placeholder.txt', Buffer.from('参考资料'));
      zip.getEntry('placeholder.txt')!.entryName = 'references\\guide.md';
      zip.addFile('placeholder-dir/', Buffer.alloc(0)).entryName = 'references\\';

      const stored = await service.store(upload(zip.toBuffer()));
      const installable = await service.readInstallablePackage(stored.sha256);
      const normalizedZip = new AdmZip(installable.buffer);

      expect(normalizedZip.getEntry('references/guide.md')?.getData().toString()).toBe('参考资料');
      expect(normalizedZip.getEntry('references/')).toBeDefined();
      expect(normalizedZip.getEntries().map((entry) => entry.entryName)).not.toContain('references\\guide.md');
      expect(normalizedZip.getEntries().map((entry) => entry.entryName)).not.toContain('references\\');
    });

    it.each(['skill.tar', 'skill.tar.gz', 'skill.tgz'])('将 %s 转换为已校验的 ZIP 存储', async (filename) => {
      const tarBuffer = await tarWith([['./SKILL.md', installableMarkdown()], ['./references/guide.md', 'guide']]);
      const source = filename === 'skill.tar' ? tarBuffer : gzipSync(tarBuffer);
      const stored = await service.store(upload(source, filename));
      const installable = await service.readInstallablePackage(stored.sha256);
      const zip = new AdmZip(installable.buffer);

      expect(zip.getEntry('SKILL.md')?.getData().toString()).toContain('name: weekly');
      expect(zip.getEntry('references/guide.md')?.getData().toString()).toBe('guide');
      expect(stored.key).toBe(`skills/${stored.sha256}.zip`);
    });

    it('拒绝 TAR 包内的路径穿越条目', async () => {
      const source = await tarWith([['../SKILL.md', installableMarkdown()]]);
      await expect(service.store(upload(source, 'skill.tar'))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('拒绝非法包', () => {
    const reject = (file: Express.Multer.File) =>
      expect(service.store(file)).rejects.toBeInstanceOf(BadRequestException);

    it('拒绝空上传', () => reject(upload(Buffer.alloc(0))));

    it('拒绝未支持的压缩包扩展名', async () =>
      expect(service.store(upload(zipWith([['SKILL.md', SKILL_BODY]]), 'skill.rar'))).rejects.toBeInstanceOf(BadRequestException));

    it('拒绝改名成 .zip 的非 zip 内容（魔数校验）', () =>
      reject(upload(Buffer.from('这不是 zip，只是改了后缀'), 'fake.zip')));

    it('拒绝缺少 SKILL.md 的包', () =>
      reject(upload(zipWith([['README.md', SKILL_BODY]]))));

    it('不把 NOTSKILL.md 当成 SKILL.md（按 basename 精确匹配）', () =>
      reject(upload(zipWith([['NOTSKILL.md', SKILL_BODY]]))));

    it('拒绝 SKILL.md 正文为空', () =>
      reject(upload(zipWith([['SKILL.md', '---\nname: 空\n---\n   \n']]))));

    it('拒绝含路径穿越条目的包', () => reject(upload(zipWithRawName('../../evil.sh'))));

    it('拒绝绝对路径条目', () => reject(upload(zipWithRawName('/etc/cron.d/evil'))));

    it('拒绝 Windows 盘符条目', () => reject(upload(zipWithRawName('C:\\evil.bat'))));

    it('拒绝反斜杠伪装的穿越条目', () => reject(upload(zipWithRawName('..\\..\\evil.sh'))));

    it('放宽条目数上限，仍保留可解析性', async () => {
      const entries: Array<[string, string]> = [['SKILL.md', SKILL_BODY]];
      for (let i = 0; i < 600; i += 1) entries.push([`pad/${i}.txt`, 'x']);
      await expect(service.store(upload(zipWith(entries)))).resolves.toMatchObject({ fileCount: 601 });
    });

    it('放宽解压后体积上限', async () => {
      const bomb = zipWith([['SKILL.md', SKILL_BODY], ['bomb.txt', 'a'.repeat(1024 * 1024)]]);
      await expect(service.store(upload(bomb))).resolves.toBeDefined();
    });
  });

  describe('read', () => {
    it('sha256 格式非法时报 400', () =>
      expect(service.read('not-a-hash')).rejects.toBeInstanceOf(BadRequestException));

    it('包不存在时报 404', () =>
      expect(service.read('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException));
  });

  describe('upload/install compatibility', () => {
    it.each(['CON.txt', 'com9', 'LPT¹.txt', 'ＮＵＬ.txt', 'dir./file.txt', 'dir /file.txt', 'bad?.txt'])('rejects Windows-unsafe paths at both upload and installation: %s', async (path) => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], [path, 'payload']]);
      await expect(service.store(upload(buffer))).rejects.toBeInstanceOf(BadRequestException);
      jest.spyOn(service, 'readBytes').mockResolvedValue(buffer);
      await expect(service.readInstallablePackage(sha256(buffer))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('多个入口优先根目录且完整保留其他技能和附件', async () => {
      const buffer = zipWith([
        ['nested/SKILL.md', installableMarkdown('nested')],
        ['SKILL.md', installableMarkdown('root')],
        ['nested/scripts/run.py', 'print(1)'],
      ]);
      jest.spyOn(service, 'readBytes').mockResolvedValue(buffer);
      const result = await service.readInstallablePackage(sha256(buffer));
      expect(result).toMatchObject({ entryPath: 'SKILL.md', skillName: 'root', fileCount: 3 });
      expect(new AdmZip(result.buffer).getEntry('nested/scripts/run.py')!.getData().toString()).toBe('print(1)');
    });

    it('文件数量超过客户端上限时仍可审核和读取原始包，并给出兼容提示', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()],
        ...Array.from({ length: 500 }, (_, index) => [`assets/${index}.txt`, 'x'] as [string, string])]);
      await expect(service.store(upload(buffer))).resolves.toMatchObject({ fileCount: 501,
        warnings: expect.arrayContaining([expect.objectContaining({ code: 'CLIENT_ARTIFACT_LIMIT' })]),
      });
      jest.spyOn(service, 'readBytes').mockResolvedValue(buffer);
      await expect(service.readInstallablePackage(sha256(buffer))).resolves.toMatchObject({ fileCount: 501 });
    });

    it.each(['CRM 标签体系', 'SKU 生命周期管理', '电商 SOP 编排'])('preserves safe internal spaces at upload and installation: %s', async (name) => {
      const markdown = installableMarkdown(name);
      const buffer = zipWith([[`${name}/SKILL.md`, markdown]]);
      const stored = await service.store(upload(buffer));
      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ skillName: name, entryPath: `${name}/SKILL.md`, entrySha256: sha256(Buffer.from(markdown)) });
    });

    it('checks ZIP self references and does not exempt an absent parent entry', async () => {
      const markdown = installableMarkdown().replace(SKILL_BODY, '[Self](./SKILL.md#section)');
      await expect(service.store(upload(zipWith([['weekly/SKILL.md', markdown]])))).resolves.toMatchObject({ fileCount: 1 });
      await expect(service.store(upload(zipWith([['weekly/SKILL.md', markdown.replace('./SKILL.md', '../SKILL.md')]])))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'RESOURCE_REFERENCE' })]) });
    });

    it('preserves NFKC-equivalent directory and Unicode name bytes', async () => {
      const markdown = '\ufeff\n' + installableMarkdown('ＡＩ-竞品');
      const buffer = zipWith([['AI-竞品/SKILL.md', markdown]]);
      const stored = await service.store(upload(buffer));
      expect(stored.suggested.name).toBe('ＡＩ-竞品');
      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ skillName: 'ＡＩ-竞品', entryPath: 'AI-竞品/SKILL.md', entrySha256: sha256(Buffer.from(markdown)), buffer });
    });

    it('requires referenced input files but not output files or external assets', async () => {
      const markdown = installableMarkdown().replace(SKILL_BODY, 'Read references/input.md. Output `result.json`. [External](https://example.com/assets/a.png)');
      const missing = zipWith([['weekly/SKILL.md', markdown]]);
      await expect(service.store(upload(missing))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'RESOURCE_REFERENCE' })]) });
      const buffer = zipWith([['weekly/SKILL.md', markdown], ['weekly/references/input.md', 'input']]);
      const stored = await service.store(upload(buffer));
      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ fileCount: 2 });
    });

    it('rejects normalized path collisions at upload', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], ['Ａ.txt', 'a'], ['A.txt', 'b']]);
      await expect(service.store(upload(buffer))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('readInstallablePackage', () => {
    it('keeps the upload budget but rejects a generated entry exceeding that same budget', async () => {
      const markdown = '# ' + 'x'.repeat(2 * 1024 * 1024 - 2);
      const stored = await service.store(upload(zipWith([['SKILL.md', markdown]])));
      await expect(service.readInstallablePackage(stored.sha256)).rejects.toThrow('2MiB');
      await expect(service.read(stored.sha256)).resolves.toMatchObject({ content: markdown });
    });

    it.each([
      ['a.txt', 'A.txt'], ['assets/a.txt', 'Assets/b.txt'], ['file', 'file/child.txt'],
      ['café/a.txt', 'cafe\u0301/b.txt'],
    ])('rejects installation path aliases or file-directory conflicts: %s %s', async (first, second) => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], [first, 'one'], [second, 'two']]);
      const stored = await service.store(upload(buffer));
      await expect(service.readInstallablePackage(stored.sha256)).rejects.toThrow('冲突');
    });

    it('allows missing resources with individual warnings through upload, reread and installation', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown() + '\n[Input](references/missing.md)\nRead `scripts/missing.py`.\n[Again](references/missing.md)']]);
      const stored = await service.store(upload(buffer));
      const warnings = ['references/missing.md', 'scripts/missing.py'].map((path) => ({
        code: 'RESOURCE_REFERENCE', path, message: expect.stringContaining(path),
      }));
      expect(stored.warnings).toEqual(warnings);
      await expect(service.read(stored.sha256)).resolves.toMatchObject({ warnings });
      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ warnings, buffer });
    });

    it('accepts output names, remote links and case-equivalent skill directory names', async () => {
      const markdown = installableMarkdown() + '\nSave `report.md`. [Remote](https://example.com)';
      const stored = await service.store(upload(zipWith([['Weekly/SKILL.md', markdown]])));
      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ skillName: 'weekly' });
    });
    const readPackage = (buffer: Buffer, hash = sha256(buffer)) => {
      jest.spyOn(service, 'readBytes').mockResolvedValue(buffer);
      return service.readInstallablePackage(hash);
    };
    const rejectPackage = (buffer: Buffer) =>
      expect(readPackage(buffer)).rejects.toBeInstanceOf(BadRequestException);

    it('读取正常嵌套包及资源，返回入口信息但不泄露 storage 路径', async () => {
      const markdown = installableMarkdown();
      const buffer = zipWith([
        ['bundle/weekly/', ''],
        ['bundle/weekly/SKILL.md', markdown],
        ['bundle/weekly/resources/reference.md', '附件'],
        ['bundle/weekly/scripts/run.sh', '#!/bin/sh\n'],
      ]);
      const stored = await service.store(upload(buffer));

      await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({
        buffer,
        sha256: stored.sha256,
        skillName: 'weekly',
        content: `${SKILL_BODY}\n`,
        entryPath: 'bundle/weekly/SKILL.md',
        entrySha256: sha256(Buffer.from(markdown, 'utf8')),
        totalBytes: buffer.length,
        fileCount: 3,
        warnings: [],
      });
    });

    it('根入口将 CRLF 规范为 LF，与批准正文一致且保留原包', async () => {
      const markdown = '---\r\nname: root-skill\r\ndescription: "  原始说明  "\r\nextra: keep\r\n---\r\n\r\n  # Original\r\n';
      const buffer = zipWith([['SKILL.md', markdown]]);
      const stored = await service.store(upload(buffer));
      const result = await service.readInstallablePackage(stored.sha256);

      const normalized = markdown.replace(/\r\n/g, '\n');
      expect(result.buffer.equals(buffer)).toBe(false);
      expect(await service.readBytes(stored.key)).toEqual(buffer);
      expect(new AdmZip(result.buffer).getEntry('SKILL.md')!.getData()).toEqual(Buffer.from(normalized));
      expect(result.content).toBe(stored.content);
      expect(result.entryPath).toBe('SKILL.md');
      expect(result.skillName).toBe('root-skill');
      expect(result.entrySha256).toBe(sha256(Buffer.from(normalized)));
      expect(result.entrySha256).not.toBe(sha256(Buffer.from(result.content)));
      expect(result).not.toHaveProperty('key');
      expect(result).not.toHaveProperty('suggested');
    });

    it('通过已有 OSS storage 读取相同 ZIP', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()]]);
      const storage = { driverName: 'oss', get: jest.fn().mockResolvedValue(buffer) };
      service = new SkillPackageService(
        { get: () => join(root, 'skills') } as unknown as ConfigService,
        storage as unknown as StorageService,
      );
      const result = await service.readInstallablePackage(sha256(buffer));
      expect(storage.get).toHaveBeenCalledWith(`skills/${sha256(buffer)}.zip`);
      expect(result.buffer).toEqual(buffer);
    });

    it('normalizes reproducibly while retaining every attachment and original source', async () => {
      const original = new AdmZip(zipWith([['demo/skill.md', '---\nname: demo\n---\n# Instructions'], ['demo/script.py', 'print(1)'],
        ['shared/input.txt', 'input']]));
      const timestamp = new Date('2001-01-02T03:04:06');
      original.getEntry('demo/skill.md')!.header.time = timestamp;
      const buffer = original.toBuffer();
      const stored = await service.store(upload(buffer));
      const first = await service.readInstallablePackage(stored.sha256);
      const second = await service.readInstallablePackage(stored.sha256);
      expect(second.buffer).toEqual(first.buffer);
      expect(second.sha256).toBe(first.sha256);
      const normalized = new AdmZip(first.buffer);
      expect(normalized.getEntry('demo/SKILL.md')!.header.time).toEqual(timestamp);
      expect(normalized.getEntry('demo/SKILL.md')!.getData().toString()).toContain('# Instructions');
      expect(normalized.getEntry('demo/script.py')!.getData().toString()).toBe('print(1)');
      expect(normalized.getEntry('shared/input.txt')!.getData().toString()).toBe('input');
      expect(await service.readBytes(stored.key)).toEqual(buffer);
    });

    it('sha256 格式非法时报 400，不读取 storage', async () => {
      const readBytes = jest.spyOn(service, 'readBytes');
      await expect(service.readInstallablePackage('not-a-hash')).rejects.toBeInstanceOf(BadRequestException);
      expect(readBytes).not.toHaveBeenCalled();
    });

    it('本地存储不存在时保留 404', () =>
      expect(service.readInstallablePackage('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException));

    it('OSS 存储不存在时保留 404', async () => {
      const storage = { driverName: 'oss', get: jest.fn().mockRejectedValue(new NotFoundException()) };
      service = new SkillPackageService(
        { get: () => join(root, 'skills') } as unknown as ConfigService,
        storage as unknown as StorageService,
      );
      await expect(service.readInstallablePackage('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('只在安装读取层把 OSS NoSuchKey/status404 转成 Nest 404', async () => {
      const missing = Object.assign(new Error('mock object missing'), { code: 'NoSuchKey', status: 404 });
      const storage = { driverName: 'oss', get: jest.fn().mockRejectedValue(missing) };
      service = new SkillPackageService(
        { get: () => join(root, 'skills') } as unknown as ConfigService,
        storage as unknown as StorageService,
      );
      await expect(service.readInstallablePackage('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.readBytes(`skills/${'a'.repeat(64)}.zip`)).rejects.toBe(missing);
      await expect(service.read('a'.repeat(64))).rejects.toBe(missing);
    });

    it('把已有 Nest HttpException 404 规范成 NotFoundException', async () => {
      jest.spyOn(service, 'readBytes').mockRejectedValue(new HttpException('mock missing', 404));
      await expect(service.readInstallablePackage('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      { code: 'TransportError', status: 404 },
      { code: 'NoSuchKey', status: 503 },
      { code: 'ETIMEDOUT' },
    ])('其他存储传输故障原样抛出：%j', async (fields) => {
      const transportError = Object.assign(new Error('mock transport failure'), fields);
      jest.spyOn(service, 'readBytes').mockRejectedValue(transportError);
      await expect(service.readInstallablePackage('a'.repeat(64))).rejects.toBe(transportError);
    });

    it('拒绝存储内容被篡改导致的 ZIP hash 不匹配', () => {
      const original = zipWith([['SKILL.md', installableMarkdown()]]);
      const tampered = zipWith([['SKILL.md', installableMarkdown('changed')]]);
      return expect(readPackage(tampered, sha256(original))).rejects.toThrow('SHA256 不匹配');
    });

    it('多个入口稳定选择浅层入口并给出 warning', async () => {
      const buffer = zipWith([
        ['weekly/SKILL.md', installableMarkdown()],
        ['other/SKILL.md', installableMarkdown('other')],
      ]);
      await expect(service.store(upload(buffer))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'MULTIPLE_ENTRIES' })]) });
      jest.spyOn(service, 'readBytes').mockResolvedValue(buffer);
      await expect(service.read(sha256(buffer))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'MULTIPLE_ENTRIES' })]) });
      await expect(service.readInstallablePackage(sha256(buffer))).resolves.toMatchObject({
        entryPath: 'other/SKILL.md', skillName: 'other',
        warnings: expect.arrayContaining([expect.objectContaining({ code: 'MULTIPLE_ENTRIES', path: 'other/SKILL.md' })]),
      });
    });

    it('拒绝缺少精确 basename SKILL.md 的包', () =>
      rejectPackage(zipWith([['NOTSKILL.md', installableMarkdown()]])));

    it.each([
      ['无 frontmatter', SKILL_BODY],
      ['前导空格', ` ${installableMarkdown()}`],
      ['非 YAML 分隔符', installableMarkdown().replace(/^---/, '---yaml')],
      ['缺少 name', `---\ndescription: valid\n---\n${SKILL_BODY}`],
      ['缺少 description', `---\nname: weekly\n---\n${SKILL_BODY}`],
      ['下划线 name', installableMarkdown('weekly_report')],
      ['前导短横线', installableMarkdown('-weekly')],
      ['尾随短横线', installableMarkdown('weekly-')],
      ['连续短横线', installableMarkdown('weekly--report')],
      ['name 超长', installableMarkdown('a'.repeat(65))],
      ['name 空白', installableMarkdown('" "')],
      ['name 首尾空格', installableMarkdown('" weekly "')],
      ['非字符串 name', installableMarkdown('123')],
      ['非字符串 description', installableMarkdown('weekly', '123')],
      ['空 description', installableMarkdown('weekly', '"   "')],
      ['description 超长', installableMarkdown('weekly', 'x'.repeat(1025))],
      ['description 原始长度超长但 trim 后合规', installableMarkdown('weekly', `" ${'x'.repeat(1024)} "`)],
      ['损坏 YAML', `---\nname: [\n---\n${SKILL_BODY}`],
      ['正文为空', '---\nname: weekly\ndescription: valid\n---\n   \n'],
    ])('兼容导入非法 frontmatter：%s', async (_label, markdown) => {
      if (_label === '正文为空') return rejectPackage(zipWith([['SKILL.md', markdown]]));
      await expect(readPackage(zipWith([['SKILL.md', markdown]]))).resolves.toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: 'METADATA_NORMALIZED' })]) });
    });

    it.each(['a', 'a'.repeat(64), 'skill-01'])('接受边界合法 name：%s', async (name) => {
      await expect(readPackage(zipWith([['SKILL.md', installableMarkdown(name, `"  ${'x'.repeat(1020)}  "`)]])))
        .resolves.toMatchObject({ content: `${SKILL_BODY}\n` });
    });

    it('接受规范内的可选字段，不重写原始 frontmatter', async () => {
      const markdown = [
        '---',
        'name: weekly',
        'description: valid',
        'license: MIT',
        'allowed-tools: Bash Read',
        `compatibility: ${'a'.repeat(500)}`,
        'metadata:',
        '  author: test',
        '  version: "1"',
        '---',
        SKILL_BODY,
      ].join('\n');
      const buffer = zipWith([['SKILL.md', markdown]]);
      const result = await readPackage(buffer);
      expect(result.skillName).toBe('weekly');
      expect(result.buffer).toEqual(buffer);
      expect(result.entrySha256).toBe(sha256(Buffer.from(markdown)));
    });

    it.each([
      ['compatibility 数字', 'compatibility: 123'],
      ['compatibility null', 'compatibility: null'],
      ['compatibility 空字符串', 'compatibility: ""'],
      ['compatibility 超长', `compatibility: ${'a'.repeat(501)}`],
      ['metadata 字符串', 'metadata: text'],
      ['metadata 数组', 'metadata: [a, b]'],
      ['metadata null', 'metadata: null'],
      ['license 数字', 'license: 123'],
      ['license null', 'license: null'],
      ['allowed-tools 数组', 'allowed-tools: [Read, Bash]'],
      ['allowed-tools null', 'allowed-tools: null'],
    ])('兼容导入非法可选字段：%s', async (_label, field) => {
      await expect(readPackage(zipWith([['SKILL.md', `---\nname: weekly\ndescription: valid\n${field}\n---\n${SKILL_BODY}`]]))).resolves.toBeDefined();
    });

    it.each(['a', 'a'.repeat(500)])('接受 compatibility 1..500 边界（长度 %s）', async (compatibility) => {
      const markdown = `---\nname: weekly\ndescription: valid\ncompatibility: ${compatibility}\n---\n${SKILL_BODY}`;
      await expect(readPackage(zipWith([['SKILL.md', markdown]]))).resolves.toMatchObject({ skillName: 'weekly' });
    });

    it('上传与安装兼容非法 compatibility 和 description', async () => {
      const markdown = `---\nname: weekly\ndescription: " ${'x'.repeat(1024)} "\ncompatibility: ""\n---\n${SKILL_BODY}`;
      const buffer = zipWith([['SKILL.md', markdown]]);
      await expect(service.store(upload(buffer))).resolves.toBeDefined();
      await expect(readPackage(buffer)).resolves.toBeDefined();
    });

    it('目录 basename 与 name 不一致时上传与安装均通过且不提示名称不一致', async () => {
      const buffer = zipWith([['different/SKILL.md', installableMarkdown()]]);
      await expect(service.store(upload(buffer))).resolves.toMatchObject({ warnings: [] });
      await expect(readPackage(buffer)).resolves.toMatchObject({
        skillName: 'weekly', entryPath: 'different/SKILL.md', warnings: [], buffer,
      });
    });

    it('上传与安装均接受中文和大写名称及 BOM/空行头部', async () => {
      for (const markdown of [installableMarkdown('竞品周报'), installableMarkdown('Weekly'), `\ufeff\n \t\n${installableMarkdown()}`]) {
        const stored = await service.store(upload(zipWith([['SKILL.md', markdown]])));
        await expect(service.read(stored.sha256)).resolves.toMatchObject({ content: stored.content });
        await expect(service.readInstallablePackage(stored.sha256)).resolves.toMatchObject({ entrySha256: sha256(Buffer.from(markdown)) });
      }
    });

    it.each(['SKILL.md', 'weekly/link', 'weekly/link/'])('拒绝符号链接 ZIP entry：%s', (entryPath) => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      const entry = zip.addFile(entryPath, Buffer.from(installableMarkdown()));
      entry.header.made = (3 << 8) | 20;
      entry.attr = (0o120777 << 16) >>> 0;
      return rejectPackage(zip.toBuffer());
    });

    it('上传与安装均拒绝入口无效 UTF-8', async () => {
      const bytes = Buffer.concat([Buffer.from(installableMarkdown()), Buffer.from([0xc3, 0x28])]);
      const buffer = zipWith([['SKILL.md', bytes]]);
      await expect(service.store(upload(buffer))).rejects.toBeInstanceOf(BadRequestException);
      await rejectPackage(buffer);
    });

    it('拒绝损坏或截断 ZIP，统一转成 400', () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()]]);
      return rejectPackage(buffer.subarray(0, buffer.length - 12));
    });

    it('拒绝附件数据损坏，即使 SKILL.md 完好', () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      zip.addFile('resource.txt', Buffer.from('unique-resource-payload')).header.method = 0;
      const buffer = zip.toBuffer();
      const offset = buffer.indexOf(Buffer.from('unique-resource-payload'));
      expect(offset).toBeGreaterThan(0);
      buffer[offset] ^= 0xff;
      return rejectPackage(buffer);
    });

    it('复用 ZIP 魔数校验', () => rejectPackage(Buffer.from('not a zip')));

    it('复用 ZIP 大小限制', () => rejectPackage(Buffer.alloc(SKILL_PACKAGE_MAX_BYTES + 1)));

    it.each(['../../evil.sh', '/etc/evil', 'C:\\evil.bat', '..\\evil.sh'])('复用路径穿越校验：%s', (entryName) =>
      rejectPackage(zipWithRawName(entryName)));

    it.each(['../resource.txt', 'bb/resource.txt'])('拒绝本地文件头与中央目录名称不同：%s', async (localName) => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], ['aa/resource.txt', 'payload']]);
      const entry = new AdmZip(buffer).getEntry('aa/resource.txt')!;
      expect(Buffer.byteLength(localName)).toBe(entry.header.fileNameLength);
      buffer.write(localName, entry.header.offset + 30, 'utf8');
      // The existing parser still reads the central name and payload successfully.
      expect(new AdmZip(buffer).getEntry('aa/resource.txt')!.getData().toString()).toBe('payload');
      await rejectPackage(buffer);
    });

    it.each(['flags', 'method'])('拒绝本地文件头与中央目录压缩元数据不同：%s', async (field) => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], ['aa/resource.txt', 'payload']]);
      const entry = new AdmZip(buffer).getEntry('aa/resource.txt')!;
      buffer.writeUInt16LE(field === 'flags' ? entry.header.flags ^ 1 : 0, entry.header.offset + (field === 'flags' ? 6 : 8));
      await rejectPackage(buffer);
    });

    it('拒绝两处名称一致但不是 UTF-8 的附件名', async () => {
      const buffer = zipWith([['SKILL.md', installableMarkdown()], ['aa/resource.txt', 'payload']]);
      const entry = new AdmZip(buffer).getEntry('aa/resource.txt')!;
      buffer[entry.header.offset + 30] = 0xff;
      const centralNameOffset = buffer.lastIndexOf(Buffer.from('aa/resource.txt'));
      expect(centralNameOffset).toBeGreaterThan(entry.header.offset + 30);
      buffer[centralNameOffset] = 0xff;
      await rejectPackage(buffer);
    });

    it.each([
      '', './resource.txt', 'weekly/./resource.txt', 'weekly//resource.txt',
      'weekly/resource:stream', 'weekly\u0000resource.txt',
      'weekly\nresource.txt', 'weekly\u007fresource.txt', 'a'.repeat(1025),
      './resources/', 'weekly//resources/',
    ])('上传与安装均拒绝不安全条目：%j', async (entryName) => {
      const buffer = zipWithRawName(entryName, installableMarkdown());
      await expect(service.store(upload(buffer))).rejects.toBeInstanceOf(BadRequestException);
      await rejectPackage(buffer);
    });

    it('上传时规范化反斜线技能入口', async () => {
      const zip = new AdmZip();
      zip.addFile('placeholder', Buffer.from(installableMarkdown())).entryName = 'weekly\\SKILL.md';
      const stored = await service.store(upload(zip.toBuffer()));
      const installable = await service.readInstallablePackage(stored.sha256);
      expect(installable.entryPath).toBe('weekly/SKILL.md');
    });

    it('接受 1024 字符安全附件路径与合法空 STORED 资源', async () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      zip.addFile('a'.repeat(1024), Buffer.from('resource'));
      zip.addFile('empty.txt', Buffer.alloc(0)).header.method = 0;
      await expect(readPackage(zip.toBuffer())).resolves.toMatchObject({ fileCount: 3 });
    });

    it('接受真实空 DEFLATED 文件和目录，目录不调用 getData', async () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      for (const entryName of ['empty.txt', 'resources/']) {
        const entry = zip.addFile(entryName, Buffer.alloc(0));
        const compressed = deflateRawSync(Buffer.alloc(0));
        entry.header.method = 8;
        entry.header.size = 0;
        entry.header.compressedSize = compressed.length;
        entry.header.crc = 0;
        jest.spyOn(entry, 'getCompressedData').mockReturnValue(compressed);
      }
      const buffer = zip.toBuffer();
      const entries: AdmZip.IZipEntry[] = (service as any).validateEntries(buffer);
      const emptyFile = entries.find((entry) => entry.entryName === 'empty.txt')!;
      const directory = entries.find((entry) => entry.entryName === 'resources/')!;
      expect(emptyFile.header.method).toBe(8);
      expect(directory.header.method).toBe(8);
      expect(inflateRawSync(emptyFile.getCompressedData(), { maxOutputLength: 1 })).toEqual(Buffer.alloc(0));
      const fileRead = jest.spyOn(emptyFile, 'getData');
      const directoryRead = jest.spyOn(directory, 'getData');
      const directoryCompressedRead = jest.spyOn(directory, 'getCompressedData');
      jest.spyOn(service as any, 'validateEntries').mockReturnValue(entries);
      await expect(readPackage(buffer)).resolves.toMatchObject({ skillName: 'weekly', fileCount: 2 });
      expect(fileRead).toHaveBeenCalledTimes(1);
      expect(directoryRead).not.toHaveBeenCalled();
      expect(directoryCompressedRead).not.toHaveBeenCalled();
    });

    it.each([
      ['SKILL.md', 1024 * 1024], ['bomb.txt', 1024 * 1024], ['bomb.txt', 1],
    ])('在任何无预算 getData 前拒绝伪造 size=0 的 DEFLATED 条目：%s/%s bytes', async (entryName, length) => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      zip.addFile(entryName, Buffer.from('a'.repeat(length)));
      const buffer = zip.toBuffer();
      const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
      let offset = buffer.indexOf(centralSignature);
      let patched = false;
      while (offset !== -1) {
        const nameLength = buffer.readUInt16LE(offset + 28);
        if (buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') === entryName) {
          buffer.writeUInt32LE(0, offset + 24);
          patched = true;
          break;
        }
        offset = buffer.indexOf(centralSignature, offset + 46 + nameLength);
      }
      expect(patched).toBe(true);
      await expect(service.store(upload(buffer))).rejects.toBeInstanceOf(BadRequestException);
      const entries: AdmZip.IZipEntry[] = (service as any).validateEntries(buffer);
      expect(entries.find((entry) => entry.entryName === entryName)!.header.method).toBe(8);
      const reads = entries.map((entry) => jest.spyOn(entry, 'getData'));
      jest.spyOn(service as any, 'validateEntries').mockReturnValue(entries);
      await expect(readPackage(buffer)).rejects.toBeInstanceOf(BadRequestException);
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    });

    it('复用重复路径校验', () => {
      const zip = new AdmZip();
      zip.addFile('SKILL.md', Buffer.from(installableMarkdown()));
      zip.addFile('a.txt', Buffer.from('a'));
      zip.addFile('b.txt', Buffer.from('b')).entryName = 'a.txt';
      return rejectPackage(zip.toBuffer());
    });

    it('复用放宽后的条目数限制', async () => {
      const entries: Array<[string, string]> = [['SKILL.md', installableMarkdown()]];
      for (let i = 0; i < 500; i += 1) entries.push([`pad/${i}.txt`, 'x']);
      await expect(readPackage(zipWith(entries))).resolves.toBeDefined();
    });

    it('复用放宽后的解压后体积限制', async () => expect(readPackage(zipWith([
      ['SKILL.md', installableMarkdown()],
      ['bomb.txt', 'a'.repeat(1024 * 1024)],
    ]))).resolves.toBeDefined());

    it('复用放宽后的入口大小限制', () =>
      expect(readPackage(zipWith([['SKILL.md', `${installableMarkdown()}${'a'.repeat(500 * 1024)}`]])).then(() => true)).resolves.toBe(true));
  });

  describe('resolveStoredPath', () => {
    it('把 key 解成存储根下的绝对路径', async () => {
      const stored = await service.store(upload(zipWith([['SKILL.md', installableMarkdown()]])));
      expect(service.resolveStoredPath(stored.key)).toBe(
        join(root, 'skills', `${stored.sha256}.zip`),
      );
    });

    it.each([
      ['纯穿越', '../../../etc/passwd'],
      ['前缀内穿越', 'skills/../../etc/passwd'],
      ['反斜杠穿越', 'skills\\..\\..\\etc\\passwd'],
      ['缺少 skills/ 前缀', 'chat/other-user-file.png'],
      ['绝对路径', '/etc/passwd'],
    ])('拒绝越界的 key（%s）', (_label, key) => {
      expect(() => service.resolveStoredPath(key)).toThrow(BadRequestException);
    });
  });
});
