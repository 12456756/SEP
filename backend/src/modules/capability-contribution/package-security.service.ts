import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { PackageSecurityScanStatus, PackageSecurityType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CapabilityValidatorService } from './capability-validator.service';
import { SkillPackageService } from '../skill-package/skill-package.service';

/**
 * 上传包安全门禁。
 *
 * 当前内置 provider 只做 ZIP 结构、凭据特征和 Skill 正文静态检查；绝不在服务端
 * 执行包内脚本。当前不接入病毒库或隔离沙箱；扫描状态只代表本地静态规则
 * 检查结果，必须保留 STATIC_ONLY_SCAN 警告，不能包装成恶意软件检测结论。
 */
@Injectable()
export class PackageSecurityService {
  private readonly scannerVersion = 'static-zip-v1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: CapabilityValidatorService,
    @Optional() private readonly packages?: SkillPackageService,
  ) {}

  async scanSkill(input: {
    sha256: string; content: string; fileCount: number; files?: string[];
    warnings?: Array<{ code: string; message: string }>;
  }) {
    const validation = this.validator.validateSkill(input.content);
    const warnings = [...(input.warnings ?? []), ...validation.warnings]
      .map(({ code, message }) => ({ code, message }))
      .filter((warning, index, all) => all.findIndex((item) =>
        item.code === warning.code && item.message === warning.message) === index);
    warnings.push({ code: 'STATIC_ONLY_SCAN', message: '仅完成 Skill 静态规则检查，未运行病毒库或沙箱扫描，需由审核人完成人工安全复核' });
    return this.save({
      packageSha256: input.sha256,
      packageType: PackageSecurityType.SKILL,
      status: validation.valid ? PackageSecurityScanStatus.PASSED : PackageSecurityScanStatus.FAILED,
      issues: validation.issues,
      warnings,
    });
  }

  async scanRpa(input: { sha256: string; files: string[]; fileCount: number }) {
    const warnings = [
      { code: 'STATIC_ONLY_SCAN', message: '仅完成 ZIP 结构与敏感信息静态检查，未运行病毒库或沙箱扫描；RPA 包不得在服务端执行，需人工复核' },
      ...(input.files.some((file) => /\.(?:exe|dll|bat|cmd|ps1|sh|py|js)$/i.test(file))
        ? [{ code: 'EXECUTABLE_CONTENT', message: '包内包含可执行或脚本文件，审核时需确认来源与运行权限' }]
        : []),
    ];
    return this.save({
      packageSha256: input.sha256,
      packageType: PackageSecurityType.RPA,
      status: PackageSecurityScanStatus.PASSED,
      issues: [],
      warnings,
    });
  }

  async getScan(packageSha256: string, packageType: PackageSecurityType) {
    return this.prisma.packageSecurityScan.findUnique({
      where: { packageSha256_packageType: { packageSha256, packageType } },
      select: { status: true, scanner: true, scannerVersion: true, issues: true, warnings: true, scannedAt: true },
    });
  }

  async assertDownloadable(packageSha256: string, packageType: PackageSecurityType) {
    const scan = await this.currentScan(packageSha256, packageType);
    // 安全门禁采用 fail-closed：没有扫描记录或扫描未通过都不能下载。
    if (!scan || scan.status !== PackageSecurityScanStatus.PASSED) {
      throw new BadRequestException('该能力包未通过安全扫描，暂不可下载');
    }
  }

  async assertReviewable(packageSha256: string, packageType: PackageSecurityType) {
    const scan = await this.currentScan(packageSha256, packageType);
    // 安全门禁采用 fail-closed：没有扫描记录或扫描未通过都不能提交审核。
    if (!scan || scan.status !== PackageSecurityScanStatus.PASSED) {
      throw new BadRequestException({
        message: '该能力包未通过安全扫描，暂不能提交审核',
        security: scan,
      });
    }
  }

  private async currentScan(packageSha256: string, packageType: PackageSecurityType) {
    const scan = await this.getScan(packageSha256, packageType);
    const obsoleteIssue = (issue: unknown) => typeof issue === 'object' && issue !== null &&
      'code' in issue && typeof issue.code === 'string' && [
        'SECTION_ROLE', 'SECTION_INPUT', 'SECTION_OUTPUT', 'SECTION_STEPS',
        'SECRET_API_KEY', 'OPENAI_KEY', 'PRIVATE_KEY', 'NO_SENSITIVE_CREDENTIALS',
        'DIRECTORY_NAME_MISMATCH', 'RESOURCE_REFERENCE', 'MULTIPLE_ENTRIES',
      ].includes(issue.code);
    const obsoleteFailure = scan?.status === PackageSecurityScanStatus.FAILED &&
      scan.scanner === 'static' && Array.isArray(scan.issues) && scan.issues.length > 0 &&
      scan.issues.every(obsoleteIssue);
    if (packageType !== PackageSecurityType.SKILL || !this.packages || (scan && !obsoleteFailure)) return scan;

    // Re-read immutable bytes before replacing legacy format failures; quarantine is never eligible.
    const pkg = await this.packages.read(packageSha256);
    const validation = this.validator.validateSkill(pkg.content);
    const data = {
      status: validation.valid ? PackageSecurityScanStatus.PASSED : PackageSecurityScanStatus.FAILED,
      scanner: 'static', scannerVersion: this.scannerVersion, scannedAt: new Date(),
      issues: validation.issues as Prisma.InputJsonValue,
      warnings: [...pkg.warnings, ...validation.warnings, { code: 'STATIC_ONLY_SCAN',
        message: '仅完成 Skill 静态规则检查，未运行病毒库或沙箱扫描，需由审核人完成人工安全复核' }]
        .map(({ code, message }) => ({ code, message })),
    };
    if (!scan) {
      return this.prisma.packageSecurityScan.upsert({
        where: { packageSha256_packageType: { packageSha256, packageType } },
        create: { packageSha256, packageType, ...data }, update: {},
      });
    }
    // A concurrent quarantine or rescan must win over this compatibility refresh.
    await this.prisma.packageSecurityScan.updateMany({
      where: { packageSha256, packageType, status: PackageSecurityScanStatus.FAILED,
        scanner: scan.scanner, scannerVersion: scan.scannerVersion, scannedAt: scan.scannedAt },
      data,
    });
    return this.getScan(packageSha256, packageType);
  }

  async metrics() {
    const [byStatus, recentFailures] = await Promise.all([
      this.prisma.packageSecurityScan.groupBy({ by: ['packageType', 'status'], _count: { _all: true } }),
      this.prisma.packageSecurityScan.findMany({
        where: { status: { in: ['FAILED', 'QUARANTINED'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, packageSha256: true, packageType: true, status: true, issues: true, scannedAt: true },
      }),
    ]);
    return { byStatus, recentFailures };
  }

  private save(input: {
    packageSha256: string;
    packageType: PackageSecurityType;
    status: PackageSecurityScanStatus;
    issues: unknown[];
    warnings: unknown[];
  }) {
    return this.prisma.packageSecurityScan.upsert({
      where: { packageSha256_packageType: { packageSha256: input.packageSha256, packageType: input.packageType } },
      create: {
        packageSha256: input.packageSha256,
        packageType: input.packageType,
        status: input.status,
        scanner: 'static',
        scannerVersion: this.scannerVersion,
        issues: input.issues as Prisma.InputJsonValue,
        warnings: input.warnings as Prisma.InputJsonValue,
        scannedAt: new Date(),
      },
      update: {
        status: input.status,
        scanner: 'static',
        scannerVersion: this.scannerVersion,
        issues: input.issues as Prisma.InputJsonValue,
        warnings: input.warnings as Prisma.InputJsonValue,
        scannedAt: new Date(),
      },
    });
  }
}
