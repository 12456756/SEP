import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalStorageDriver } from './local-storage.driver';

function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sep-upload-'));
    driver = new LocalStorageDriver(
      configWith({
        UPLOAD_LOCAL_DIR: root,
        UPLOAD_URL_SECRET: 'test-secret',
      }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('签名 URL', () => {
    it('默认签发相对路径，供前端拼到 /api 代理前缀后', async () => {
      const url = await driver.getSignedUrl('personal/u1/1_ab_a.png');
      expect(url.startsWith('/uploads/')).toBe(true);
      expect(url).toContain('exp=');
      expect(url).toContain('sig=');
    });

    it('配了 UPLOAD_PUBLIC_BASE_URL 时签发绝对地址', async () => {
      const abs = new LocalStorageDriver(
        configWith({
          UPLOAD_LOCAL_DIR: root,
          UPLOAD_URL_SECRET: 'test-secret',
          UPLOAD_PUBLIC_BASE_URL: 'https://files.example.com/',
        }),
      );
      const url = await abs.getSignedUrl('personal/u1/a.png');
      expect(url.startsWith('https://files.example.com/uploads/')).toBe(true);
    });

    it('对路径段做 URL 编码，中文名不会破坏链接', async () => {
      const url = await driver.getSignedUrl('personal/u1/1_ab_报告.pdf');
      expect(url).not.toContain('报告');
      expect(url).toContain(encodeURIComponent('报告.pdf'));
      // 目录分隔符本身不能被编码，否则路由匹配不到
      expect(url).toContain('personal/u1/');
    });
  });

  describe('verifySignature', () => {
    const key = 'personal/u1/1_ab_a.png';

    it('接受自己签发的有效签名', () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      expect(driver.verifySignature(key, exp, driver.sign(key, exp))).toBe(true);
    });

    it('拒绝过期签名', () => {
      const exp = Math.floor(Date.now() / 1000) - 1;
      expect(driver.verifySignature(key, exp, driver.sign(key, exp))).toBe(false);
    });

    it('拒绝被篡改的 key（拿别人的对象套自己的签名）', () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const sig = driver.sign(key, exp);
      expect(driver.verifySignature('personal/u2/1_ab_a.png', exp, sig)).toBe(
        false,
      );
    });

    it('拒绝被延长的有效期', () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const sig = driver.sign(key, exp);
      expect(driver.verifySignature(key, exp + 3600, sig)).toBe(false);
    });

    it('拒绝畸形/缺失的签名，而不是抛错', () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      expect(driver.verifySignature(key, exp, '')).toBe(false);
      expect(driver.verifySignature(key, exp, 'zz')).toBe(false);
      expect(driver.verifySignature(key, Number.NaN, 'zz')).toBe(false);
    });

    it('换密钥后旧签名失效', () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const sig = driver.sign(key, exp);
      const other = new LocalStorageDriver(
        configWith({ UPLOAD_LOCAL_DIR: root, UPLOAD_URL_SECRET: 'other' }),
      );
      expect(other.verifySignature(key, exp, sig)).toBe(false);
    });
  });

  describe('put / get / delete', () => {
    it('写入后能按 key 读回原始字节', async () => {
      const payload = Buffer.from('hello 世界', 'utf8');
      const stored = await driver.put({
        key: 'personal/u1/a.txt',
        buffer: payload,
        mime: 'text/plain',
        filename: 'a.txt',
      });

      expect(stored.key).toBe('personal/u1/a.txt');
      expect(stored.size).toBe(payload.length);
      expect(await driver.get('personal/u1/a.txt')).toEqual(payload);
    });

    it('读不存在的对象抛 404', async () => {
      await expect(driver.get('personal/u1/missing.txt')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('删除后再读抛 404，重复删除不报错', async () => {
      await driver.put({
        key: 'personal/u1/a.txt',
        buffer: Buffer.from('x'),
        mime: 'text/plain',
        filename: 'a.txt',
      });
      await driver.delete('personal/u1/a.txt');
      await expect(driver.get('personal/u1/a.txt')).rejects.toThrow(
        NotFoundException,
      );
      await expect(driver.delete('personal/u1/a.txt')).resolves.toBeUndefined();
    });

    it('拒绝穿出根目录的 key', async () => {
      await expect(driver.get('../../etc/passwd')).rejects.toThrow();
      await expect(
        driver.put({
          key: '../escape.txt',
          buffer: Buffer.from('x'),
          mime: 'text/plain',
          filename: 'escape.txt',
        }),
      ).rejects.toThrow();
    });
  });

  describe('deletePrefix', () => {
    it('只删除企业目录，拒绝根目录，并允许重复删除', async () => {
      await driver.put({ key: 'enterprise-a/u1/a.txt', buffer: Buffer.from('a'), mime: 'text/plain', filename: 'a.txt' });
      await driver.put({ key: 'enterprise-a/u2/b.txt', buffer: Buffer.from('b'), mime: 'text/plain', filename: 'b.txt' });
      await driver.put({ key: 'enterprise-a2/u1/c.txt', buffer: Buffer.from('c'), mime: 'text/plain', filename: 'c.txt' });

      await driver.deletePrefix('enterprise-a/');
      await driver.deletePrefix('enterprise-a/');

      await expect(driver.get('enterprise-a/u1/a.txt')).rejects.toThrow(NotFoundException);
      await expect(driver.get('enterprise-a/u2/b.txt')).rejects.toThrow(NotFoundException);
      expect(await driver.get('enterprise-a2/u1/c.txt')).toEqual(Buffer.from('c'));
      await expect(driver.deletePrefix('/')).rejects.toThrow();
      await expect(driver.deletePrefix('')).rejects.toThrow();
      await expect(driver.deletePrefix('../')).rejects.toThrow();
    });

    it('删除企业目录中的符号链接本身，不跟随链接到根目录外', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'sep-outside-'));
      const secret = join(outside, 'secret.txt');
      try {
        await writeFile(secret, 'keep');
        await mkdir(join(root, 'enterprise-link'));
        await symlink(outside, join(root, 'enterprise-link', 'outside'));

        await driver.deletePrefix('enterprise-link/');

        expect(await readFile(secret, 'utf8')).toBe('keep');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
