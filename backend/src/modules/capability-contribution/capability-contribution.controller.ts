import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  Res,
  NotFoundException,
  UploadedFile,
  Query,
  UseGuards,
  UseInterceptors,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import { memoryStorage } from 'multer';
import {
  ContributionCapabilityCreateDtoSchema,
  ContributionCapabilityUpdateDtoSchema,
  ContributionReviewDecisionSchema,
  ContributionVersionCreateDtoSchema,
  ContributionVersionUpdateDtoSchema,
  type ContributionCapabilityCreateDto,
  type ContributionCapabilityUpdateDto,
  type ContributionReviewDecision,
  type ContributionVersionCreateDto,
  type ContributionVersionUpdateDto,
  type SkillPackageParseResult,
  type RpaPackageParseResult,
} from 'shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  SKILL_PACKAGE_MAX_BYTES,
  SkillPackageService,
} from '../skill-package/skill-package.service';
import { CapabilityContributionService } from './capability-contribution.service';
import { CapabilityValidatorService } from './capability-validator.service';
import { RPA_PACKAGE_MAX_BYTES, RpaPackageService } from '../rpa-package/rpa-package.service';
import { PackageSecurityService } from './package-security.service';

type AuthRequest = {
  user: { id: string; role?: string };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function requestAuditContext(req: AuthRequest) {
  const userAgent = req.headers?.['user-agent'];
  return {
    ip: req.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}

/**
 * memoryStorage 而非 diskStorage：包要先过魔数与结构校验才决定是否落盘，
 * 落盘位置还得由内容哈希决定。上限由 fileSize 兜住，不会长期占内存。
 */
const RPA_PACKAGE_MULTER = {
  storage: memoryStorage(),
  limits: { fileSize: RPA_PACKAGE_MAX_BYTES, files: 1 },
};

const SKILL_PACKAGE_MULTER = {
  storage: memoryStorage(),
  limits: { fileSize: SKILL_PACKAGE_MAX_BYTES, files: 1 },
};

@ApiTags('Capability Contributions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('contributions')
export class CapabilityContributionController {
  constructor(
    private readonly service: CapabilityContributionService,
    private readonly skillPackage: SkillPackageService,
    private readonly validator: CapabilityValidatorService,
    private readonly rpaPackage: RpaPackageService,
    @Optional() private readonly security?: PackageSecurityService,
  ) {}

  @Get('market')
  @ApiOperation({ summary: '检索已发布的能力市场' })
  @ApiResponse({ status: 200, description: '返回已发布 Skill/RPA 列表及安装/下载端点' })
  market(@Query('q') q?: string, @Query('type') type?: string, @Query('industry') industry?: string, @Query('position') position?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.searchMarket({ q, type, industry, position, page: Number(page) || 1, limit: Number(limit) || 20 });
  }

  @Post('rpa-package')
  @ApiOperation({ summary: '上传 RPA ZIP 包' })
  @ApiResponse({ status: 400, description: 'ZIP 结构或安全检查未通过' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 201, description: '解析成功，返回包元数据' })
  @UseInterceptors(FileInterceptor('file', RPA_PACKAGE_MULTER))
  async uploadRpaPackage(@UploadedFile() file: Express.Multer.File): Promise<RpaPackageParseResult> {
    const stored = await this.rpaPackage.store(file);
    await this.security?.scanRpa(stored);
    return stored;
  }

  @Post('skill-package')
  @ApiOperation({
    summary: '上传 SKILL 包（ZIP/TAR/TAR.GZ/TGZ，须含 SKILL.md）',
    description:
      '共享上传供运营首次创建和客户端使用，返回 sha256 与解析结果；上传本身不创建或替换技能版本。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201, description: '解析成功，返回包元数据与自动校验结论' })
  @ApiResponse({ status: 400, description: '不是 zip、缺少 SKILL.md 或包结构非法' })
  @ApiResponse({ status: 413, description: '包超过大小上限' })
  @UseInterceptors(FileInterceptor('file', SKILL_PACKAGE_MULTER))
  async uploadSkillPackage(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<SkillPackageParseResult> {
    const stored = await this.skillPackage.store(file);
    // 上传即校验：提交审核前就把缺段落、含密钥之类的问题暴露出来，
    // 而不是等第三步走完、点提交才报错。
    const { kind: _kind, ...validation } = this.validator.validateSkill(stored.content);
    validation.warnings = [...stored.warnings, ...validation.warnings].filter((warning, index, warnings) =>
      warnings.findIndex((candidate) => candidate.code === warning.code && candidate.message === warning.message) === index,
    );
    await this.security?.scanSkill(stored);
    return {
      sha256: stored.sha256,
      filename: stored.filename,
      fileCount: stored.fileCount,
      totalBytes: stored.totalBytes,
      content: stored.content,
      suggested: stored.suggested,
      validation,
    };
  }

  @Get(':id/rpa-package')
  @ApiOperation({ summary: '下载已审核通过的 RPA 包' })
  @ApiResponse({ status: 200, description: '返回 RPA zip 文件' })
  async downloadRpaPackage(
    @Request() req: AuthRequest,
    @Param('id') id: string,
    @Query('versionId') versionId: string | undefined,
    @Res() res: Response,
  ) {
    const { key, filename, sha256, version } = await this.service.getRpaPackage(
      req.user.id,
      id,
      versionId,
      requestAuditContext(req),
    );
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-SHA256', sha256);
    res.setHeader('X-Version', version);
    if (this.rpaPackage.isSharedStorage?.()) {
      const bytes = await this.rpaPackage.readBytes(key);
      res.setHeader('Content-Length', bytes.length);
      return res.attachment(filename).send(bytes);
    }
    const fullPath = this.rpaPackage.resolveStoredPath(key);
    if (!existsSync(fullPath)) throw new NotFoundException('RPA 包文件不存在');
    res.setHeader('Content-Length', statSync(fullPath).size);
    return res.download(fullPath, filename);
  }

  @Get('versions/:versionId')
  @ApiOperation({
    summary: '作者查看自己某个版本的正文',
    description:
      '与 /enterprise/skill-versions/:id/preview 不同：那条要求成员持有该能力的订阅授权，'
      + '刚贡献的能力没有任何绑定，作者永远拿不到自己的正文。',
  })
  @ApiResponse({ status: 404, description: '版本不存在或不属于当前作者' })
  version(@Request() req: AuthRequest, @Param('versionId') versionId: string) {
    return this.service.getVersionForAuthor(req.user.id, versionId);
  }

  @Get('versions/:versionId/diff')
  @ApiOperation({ summary: '查看 Skill 版本与父版本的差异和审核历史' })
  @ApiResponse({ status: 404, description: '版本不存在或无权访问' })
  versionDiff(@Request() req: AuthRequest, @Param('versionId') versionId: string) {
    return this.service.getVersionDiff(req.user.id, versionId, req.user.role);
  }

  @Post('versions/:versionId/enterprise-review')
  @ApiOperation({ summary: '企业管理员审核 Skill 版本' })
  @ApiResponse({ status: 409, description: '版本当前状态不可审核' })
  enterpriseReviewVersion(
    @Request() req: AuthRequest,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(ContributionReviewDecisionSchema)) dto: ContributionReviewDecision,
  ) {
    return this.service.reviewEnterpriseVersion(req.user.id, versionId, dto);
  }

  @Patch('versions/:versionId')
  @ApiOperation({ summary: '编辑草稿版本正文（已停用）' })
  @ApiResponse({ status: 403, description: 'SKILL Web 正文编辑已停用，请通过客户端提交修改' })
  updateVersion(@Request() req: AuthRequest, @Param('versionId') versionId: string, @Body(new ZodValidationPipe(ContributionVersionUpdateDtoSchema)) dto: ContributionVersionUpdateDto) {
    return this.service.updateVersion(req.user.id, versionId, dto);
  }

  @Post('versions/:versionId/submit')
  @ApiOperation({
    summary: '提交版本审核（已停用）',
    description: '旧 Web 贡献版本提交已停用，请通过客户端提交修改；历史版本仍可读取。',
  })
  @ApiResponse({ status: 403, description: 'SKILL Web 版本提交已停用' })
  submitVersion(@Request() req: AuthRequest, @Param('versionId') versionId: string) {
    return this.service.submitVersion(req.user.id, versionId);
  }

  @Get('versions/:versionId/package')
  @ApiOperation({ summary: '下载某个版本上传的 SKILL 包' })
  @ApiResponse({ status: 200, description: '返回 zip 文件' })
  @ApiResponse({ status: 404, description: '版本不存在、无权访问或该版本没有包' })
  async downloadVersionPackage(
    @Request() req: AuthRequest,
    @Param('versionId') versionId: string,
    @Res() res: Response,
  ) {
    const { filename, sha256, version } = await this.service.getVersionPackage(
      req.user.id,
      versionId,
      req.user.role,
      requestAuditContext(req),
    );
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Version', version);
    const pkg = await this.skillPackage.readInstallablePackage(sha256);
    res.setHeader('X-SHA256', pkg.sha256);
    res.setHeader('X-Skill-Entry-Path', encodeURIComponent(pkg.entryPath));
    res.setHeader('Content-Length', pkg.buffer.length);
    return res.attachment(filename).send(pkg.buffer);
  }

  @Get('overview')
  @ApiOperation({ summary: '贡献中心概览' })
  overview(@Request() req: AuthRequest) { return this.service.overview(req.user.id); }

  @Get('mine')
  @ApiOperation({ summary: '我的能力列表' })
  mine(@Request() req: AuthRequest) { return this.service.listMine(req.user.id); }

  @Get('rewards')
  @ApiOperation({ summary: '我的奖励事件' })
  rewards(@Request() req: AuthRequest) { return this.service.rewards(req.user.id); }

  @Get(':id/usage')
  @ApiOperation({ summary: '能力使用情况与员工生效版本' })
  usage(@Request() req: AuthRequest, @Param('id') id: string) { return this.service.usage(req.user.id, id); }

  @Get(':id')
  @ApiOperation({ summary: '贡献能力详情' })
  detail(@Request() req: AuthRequest, @Param('id') id: string) { return this.service.getOne(req.user.id, id); }

  @Post()
  @ApiOperation({ summary: '创建非 SKILL 能力贡献草稿' })
  @ApiResponse({ status: 403, description: 'SKILL 首次创建仅支持运营后台' })
  @ApiResponse({ status: 201, description: '能力草稿已创建' })
  create(@Request() req: AuthRequest, @Body(new ZodValidationPipe(ContributionCapabilityCreateDtoSchema)) dto: ContributionCapabilityCreateDto) {
    return this.service.create(req.user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '编辑能力草稿' })
  update(@Request() req: AuthRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ContributionCapabilityUpdateDtoSchema)) dto: ContributionCapabilityUpdateDto) {
    return this.service.update(req.user.id, id, dto);
  }

  @Post(':id/submit-enterprise-review')
  @ApiOperation({ summary: '提交企业审核' })
  submitEnterprise(@Request() req: AuthRequest, @Param('id') id: string) { return this.service.submitEnterpriseReview(req.user.id, id); }

  @Post(':id/enterprise-review')
  @ApiOperation({ summary: '企业管理员审核能力' })
  reviewEnterprise(@Request() req: AuthRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ContributionReviewDecisionSchema)) dto: ContributionReviewDecision) {
    return this.service.reviewEnterprise(req.user.id, id, dto);
  }

  @Post(':id/request-platform-review')
  @ApiOperation({ summary: '申请企业管理员授权平台投稿（SKILL 已停用）' })
  @ApiResponse({ status: 403, description: 'SKILL 平台投稿由平台运营独立选审' })
  requestPlatform(@Request() req: AuthRequest, @Param('id') id: string) { return this.service.requestPlatformReview(req.user.id, id); }

  @Post(':id/authorize-platform-submission')
  @ApiOperation({ summary: '企业管理员授权平台投稿（SKILL 已停用）' })
  @ApiResponse({ status: 403, description: 'SKILL 企业授权投稿已停用' })
  authorizePlatform(@Request() req: AuthRequest, @Param('id') id: string) { return this.service.authorizePlatformSubmission(req.user.id, id); }

  @Post(':id/platform-review')
  @ApiOperation({ summary: '平台运营审核投稿' })
  reviewPlatform(@Request() req: AuthRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ContributionReviewDecisionSchema)) dto: ContributionReviewDecision) {
    return this.service.reviewPlatform(req.user.id, id, dto);
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: '发布 Skill 新版本草稿（已停用）',
    description: 'Web 正文和包迭代已停用，请通过客户端提交修改。',
  })
  @ApiResponse({ status: 403, description: 'SKILL Web 版本创建已停用' })
  createVersion(@Request() req: AuthRequest, @Param('id') id: string, @Body(new ZodValidationPipe(ContributionVersionCreateDtoSchema)) dto: ContributionVersionCreateDto) {
    return this.service.createSkillVersion(req.user.id, id, dto);
  }
}
