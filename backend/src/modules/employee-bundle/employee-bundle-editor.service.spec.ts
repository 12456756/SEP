import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { EmployeeBundleEditorService } from './employee-bundle-editor.service';
import { BundleCopyDraftDtoSchema, MAX_BUNDLE_COVER_SIZE } from '../../shared/employee-bundle.dto';

describe('EmployeeBundleEditorService', () => {
  const prisma = { digitalEmployee: { findMany: jest.fn() } };
  const copyDraft = { generateBundle: jest.fn() };
  const storage = { put: jest.fn(), get: jest.fn() };
  const service = new EmployeeBundleEditorService(prisma as any, copyDraft as any, storage as any);
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const file = (overrides: Record<string, unknown> = {}) => ({ originalname: 'cover.png', size: png.length, buffer: png, ...overrides }) as Express.Multer.File;

  beforeEach(() => jest.resetAllMocks());

  it('loads approved employee context in selection order and delegates to the existing model route', async () => {
    prisma.digitalEmployee.findMany.mockResolvedValue([
      { id: 'b', name: 'Sales', description: 'Follow up customers', industry: 'Retail', position: 'Sales', bindings: [] },
      { id: 'a', name: 'Designer', description: 'Design products', industry: 'Retail', position: 'Design', bindings: [{ capability: { name: 'Analysis', description: 'Analyze requirements' } }] },
    ]);
    copyDraft.generateBundle.mockResolvedValue({ draft: 'Bundle description', modelId: 'platform-model', modelSource: 'PLATFORM_DEFAULT' });
    await expect(service.generateDescription({ name: 'Team', employeeIds: ['a', 'b'] })).resolves.toMatchObject({ modelId: 'platform-model' });
    expect(prisma.digitalEmployee.findMany.mock.calls[0][0]).toMatchObject({ where: { status: 'APPROVED' }, select: { bindings: { where: { enabled: true, capability: { status: 'APPROVED' } } } } });
    expect(copyDraft.generateBundle).toHaveBeenCalledWith({ name: 'Team', employees: [
      { name: 'Designer', description: 'Design products', industry: 'Retail', position: 'Design', capabilities: [{ name: 'Analysis', description: 'Analyze requirements' }] },
      { name: 'Sales', description: 'Follow up customers', industry: 'Retail', position: 'Sales', capabilities: [] },
    ] });
  });

  it('rejects unavailable employees and duplicate input before model execution', async () => {
    prisma.digitalEmployee.findMany.mockResolvedValue([]);
    await expect(service.generateDescription({ name: 'Team', employeeIds: ['missing'] })).rejects.toThrow(BadRequestException);
    expect(copyDraft.generateBundle).not.toHaveBeenCalled();
    expect(BundleCopyDraftDtoSchema.safeParse({ name: 'Team', employeeIds: ['a', 'a'] }).success).toBe(false);
  });

  it('stores validated bytes and returns a stable cover path rather than the storage URL', async () => {
    storage.put.mockResolvedValue({ url: 'https://storage.example/temporary' });
    const result = await service.uploadCover(file());
    expect(result.cover).toMatch(new RegExp('^/api/market/bundles/covers/[a-f0-9-]+[.]png$'));
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({ key: expect.stringMatching('^bundle-covers/'), buffer: png, mime: 'image/png' }));
    storage.get.mockResolvedValue(png);
    await expect(service.readCover(result.cover.split('/').pop()!)).resolves.toEqual({ buffer: png, mime: 'image/png' });
  });

  it('rejects missing, oversized, unsupported and forged image files', async () => {
    await expect(service.uploadCover()).rejects.toThrow(BadRequestException);
    await expect(service.uploadCover(file({ size: MAX_BUNDLE_COVER_SIZE + 1 }))).rejects.toThrow(PayloadTooLargeException);
    await expect(service.uploadCover(file({ originalname: 'cover.svg' }))).rejects.toThrow(BadRequestException);
    await expect(service.uploadCover(file({ buffer: Buffer.from('not a png') }))).rejects.toThrow(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('prevents reading outside the dedicated cover namespace', async () => {
    await expect(service.readCover('../private.png')).rejects.toThrow(NotFoundException);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
