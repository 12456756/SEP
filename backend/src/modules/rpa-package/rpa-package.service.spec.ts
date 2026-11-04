import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import AdmZip from "adm-zip";
import tar from 'tar-stream';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { RpaPackageService } from "./rpa-package.service";

function zipWith(entries: Record<string, string>) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries))
    zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

function tarWith(entries: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content);
    pack.entry({ name, size: body.length }, body);
  }
  pack.finalize();
  return done;
}

describe("RpaPackageService", () => {
  let root: string;
  let service: RpaPackageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sep-rpa-"));
    service = new RpaPackageService({
      get: () => root,
    } as unknown as ConfigService);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("stores a valid zip by content hash and returns metadata", async () => {
    const stored = await service.store({
      originalname: "flow.zip",
      buffer: zipWith({ "flow.json": "{}" }),
    } as Express.Multer.File);
    expect(stored.key).toMatch(/^rpa\/[0-9a-f]{64}\.zip$/);
    expect(stored.fileCount).toBe(1);
    expect((await service.read(stored.sha256)).sha256).toBe(stored.sha256);
  });

  it('converts TAR.GZ input to a stored ZIP package', async () => {
    const source = gzipSync(await tarWith({ 'flow.json': '{}' }));
    const stored = await service.store({ originalname: 'flow.tar.gz', buffer: source } as Express.Multer.File);
    const bytes = await service.readBytes(stored.key);
    expect(new AdmZip(bytes).getEntry('flow.json')?.getData().toString()).toBe('{}');
    expect(stored.key).toMatch(/^rpa\/[0-9a-f]{64}\.zip$/);
  });

  it("rejects path traversal and credential files", async () => {
    await expect(
      service.store({
        originalname: "flow.zip",
        buffer: zipWith({ "C:/escape.txt": "x" }),
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    const normalizedTraversal = zipWith({ "safe.txt": "x" });
    // Keep the ZIP valid but replace both local-header and central-directory
    // names with an equal-length traversal name. adm-zip normalizes this while
    // parsing, so the service must inspect rawEntryName too.
    const traversalZip = Buffer.from(normalizedTraversal);
    const safeName = Buffer.from("safe.txt");
    const traversalName = Buffer.from("../a.txt");
    for (
      let offset = 0;
      offset <= traversalZip.length - safeName.length;
      offset += 1
    ) {
      if (
        traversalZip.subarray(offset, offset + safeName.length).equals(safeName)
      ) {
        traversalName.copy(traversalZip, offset);
      }
    }
    await expect(
      service.store({
        originalname: "flow.zip",
        buffer: traversalZip,
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.store({
        originalname: "flow.zip",
        buffer: zipWith({ ".env": "TOKEN=secret-value" }),
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects non-zip uploads", async () => {
    await expect(
      service.store({
        originalname: "flow.zip",
        buffer: Buffer.from("not zip"),
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.store({
        originalname: "flow.txt",
        buffer: Buffer.from("PK\x03\x04"),
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
