import { BadRequestException } from '@nestjs/common';
import { PackageSecurityScanStatus, PackageSecurityType } from '@prisma/client';
import { PackageSecurityService } from './package-security.service';
import { CapabilityValidatorService } from './capability-validator.service';

describe('PackageSecurityService', () => {
  const prisma = {
    packageSecurityScan: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const validator = { validateSkill: jest.fn() };
  const service = new PackageSecurityService(prisma as never, validator as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.packageSecurityScan.upsert.mockImplementation(async ({ create }: any) => create);
  });

  it('records Skill static validation failures and keeps the static-only warning', async () => {
    validator.validateSkill.mockReturnValue({ valid: false, issues: [{ code: 'MISSING_SECTION' }], warnings: [] });

    await service.scanSkill({ sha256: 'a'.repeat(64), content: 'bad', fileCount: 1 });

    expect(prisma.packageSecurityScan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        packageType: PackageSecurityType.SKILL,
        status: PackageSecurityScanStatus.FAILED,
        scannerVersion: 'static-zip-v1',
        issues: [{ code: 'MISSING_SECTION' }],
        warnings: [expect.objectContaining({ code: 'STATIC_ONLY_SCAN' })],
      }),
    }));
  });

  it('blocks review when a package has not passed static checks', async () => {
    prisma.packageSecurityScan.findUnique.mockResolvedValue({
      status: PackageSecurityScanStatus.QUARANTINED,
      issues: [{ code: 'SUSPICIOUS_CONTENT' }],
    });

    await expect(service.assertReviewable('b'.repeat(64), PackageSecurityType.RPA))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists import compatibility warnings for review without internal paths', async () => {
    validator.validateSkill.mockReturnValue({ valid: true, issues: [], warnings: [] });
    const warning = { code: 'RESOURCE_REFERENCE', message: '部分引用未匹配', path: 'internal/file.py' };
    await service.scanSkill({ sha256: 'a'.repeat(64), content: '# Skill', fileCount: 1,
      warnings: [warning, warning] });
    expect(prisma.packageSecurityScan.upsert.mock.calls[0][0].create.warnings).toEqual([
      { code: warning.code, message: warning.message },
      expect.objectContaining({ code: 'STATIC_ONLY_SCAN' }),
    ]);
  });

  it('marks a safe Skill package as passed with non-blocking heading warnings', async () => {
    const service = new PackageSecurityService(prisma as never, new CapabilityValidatorService());
    await service.scanSkill({ sha256: 'e'.repeat(64), content: '# 多平台经营协同\n基于用户授权数据分析多平台经营，输出风险及待确认动作。\n姚瑞泉测试', fileCount: 1 });
    expect(prisma.packageSecurityScan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: PackageSecurityScanStatus.PASSED, issues: [],
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: 'SECTION_ROLE' }),
          expect.objectContaining({ code: 'STATIC_ONLY_SCAN' }),
        ]),
      }),
    }));
  });

  it('records credential-bearing Skill packages as passed with warnings', async () => {
    const service = new PackageSecurityService(prisma as never, new CapabilityValidatorService());
    await service.scanSkill({ sha256: 'f'.repeat(64), content: 'api_key = example-secret-value', fileCount: 1 });
    expect(prisma.packageSecurityScan.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: PackageSecurityScanStatus.PASSED,
        issues: [], warnings: expect.arrayContaining([expect.objectContaining({ code: 'SECRET_API_KEY' })]),
      }),
    }));
  });

  it('blocks review when a package has no scan record', async () => {
    prisma.packageSecurityScan.findUnique.mockResolvedValue(null);

    await expect(service.assertReviewable('c'.repeat(64), PackageSecurityType.SKILL))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks download when a package has no scan record', async () => {
    prisma.packageSecurityScan.findUnique.mockResolvedValue(null);

    await expect(service.assertDownloadable('d'.repeat(64), PackageSecurityType.RPA))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks download after a scan failure', async () => {
    prisma.packageSecurityScan.findUnique.mockResolvedValue({ status: PackageSecurityScanStatus.FAILED });

    await expect(service.assertDownloadable('d'.repeat(64), PackageSecurityType.SKILL))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  describe('legacy Skill scan compatibility', () => {
    const packages = { read: jest.fn() };
    const service = new PackageSecurityService(prisma as never, new CapabilityValidatorService(), packages as never);
    const hash = 'a'.repeat(64);
    const oldScan = { status: PackageSecurityScanStatus.FAILED, scanner: 'static',
      scannerVersion: 'static-zip-v1', scannedAt: new Date('2026-10-01'),
      issues: [{ code: 'SECTION_ROLE' }, { code: 'SECRET_API_KEY' }] };

    beforeEach(() => {
      packages.read.mockReset();
      packages.read.mockResolvedValue({ content: '读取 references/check.md', fileCount: 1, warnings: [] });
    });

    it.each(['assertReviewable', 'assertDownloadable'] as const)('%s rechecks immutable bytes when a scan record is missing', async (method) => {
      prisma.packageSecurityScan.findUnique.mockResolvedValue(null);
      await expect(service[method](hash, PackageSecurityType.SKILL)).resolves.toBeUndefined();
      expect(packages.read).toHaveBeenCalledWith(hash);
      expect(prisma.packageSecurityScan.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ status: 'PASSED' }), update: {},
      }));
    });

    it('refreshes only known obsolete static failures', async () => {
      prisma.packageSecurityScan.findUnique.mockResolvedValueOnce(oldScan)
        .mockResolvedValueOnce({ ...oldScan, status: 'PASSED', issues: [] });
      await expect(service.assertReviewable(hash, PackageSecurityType.SKILL)).resolves.toBeUndefined();
      expect(prisma.packageSecurityScan.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ status: 'FAILED', scannedAt: oldScan.scannedAt }),
        data: expect.objectContaining({ status: 'PASSED', issues: [], warnings: expect.arrayContaining([
          expect.objectContaining({ code: 'STATIC_ONLY_SCAN' }),
        ]) }),
      }));
    });

    it.each([
      { ...oldScan, status: 'QUARANTINED' },
      { ...oldScan, scanner: 'external' },
      { ...oldScan, issues: [{ code: 'UNRECOGNIZED_SECURITY_FAILURE' }] },
      { ...oldScan, issues: [{ code: 'SECTION_ROLE' }, { code: 'UNRECOGNIZED_SECURITY_FAILURE' }] },
      { ...oldScan, issues: [] },
    ])('preserves quarantine and unknown failures: %j', async (scan) => {
      prisma.packageSecurityScan.findUnique.mockResolvedValue(scan);
      await expect(service.assertReviewable(hash, PackageSecurityType.SKILL)).rejects.toBeInstanceOf(BadRequestException);
      expect(packages.read).not.toHaveBeenCalled();
      expect(prisma.packageSecurityScan.updateMany).not.toHaveBeenCalled();
    });

    it('keeps a concurrent quarantine when refreshing an old failure', async () => {
      prisma.packageSecurityScan.findUnique.mockResolvedValueOnce(oldScan)
        .mockResolvedValueOnce({ ...oldScan, status: 'QUARANTINED' });
      prisma.packageSecurityScan.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.assertReviewable(hash, PackageSecurityType.SKILL)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not replace a scan created concurrently with a missing-record refresh', async () => {
      prisma.packageSecurityScan.findUnique.mockResolvedValue(null);
      prisma.packageSecurityScan.upsert.mockResolvedValue({ status: 'QUARANTINED' });
      await expect(service.assertDownloadable(hash, PackageSecurityType.SKILL)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps corrupted or missing packages blocked instead of creating a passed record', async () => {
      prisma.packageSecurityScan.findUnique.mockResolvedValue(null);
      packages.read.mockRejectedValue(new BadRequestException('SHA256 不匹配'));
      await expect(service.assertReviewable(hash, PackageSecurityType.SKILL)).rejects.toThrow('SHA256 不匹配');
      expect(prisma.packageSecurityScan.upsert).not.toHaveBeenCalled();
    });

    it('does not refresh RPA records using Skill rules', async () => {
      prisma.packageSecurityScan.findUnique.mockResolvedValue(null);
      await expect(service.assertReviewable(hash, PackageSecurityType.RPA)).rejects.toBeInstanceOf(BadRequestException);
      expect(packages.read).not.toHaveBeenCalled();
    });
  });
});
