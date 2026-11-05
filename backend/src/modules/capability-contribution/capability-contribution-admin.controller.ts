import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ContributionPlatformStatus, UserRole } from '@prisma/client';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ContributionEmployeeBindSchema, ContributionReviewDecisionSchema } from 'shared';
import { CapabilityContributionService } from './capability-contribution.service';

const PLATFORM_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;
const REVIEW_KINDS = ['ALL', 'CAPABILITY', 'SKILL_VERSION'] as const;

type AuthRequest = { user: { id: string } };

@ApiTags('Admin Capability Contributions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/contributions')
export class CapabilityContributionAdminController {
  constructor(private readonly service: CapabilityContributionService) {}

  @Get()
  @ApiOperation({ summary: '平台贡献投稿队列' })
  @ApiQuery({ name: 'status', required: false, enum: PLATFORM_STATUSES, description: '默认 PENDING_REVIEW' })
  @ApiQuery({ name: 'keyword', required: false, type: String, description: '按投稿名称、描述或企业名称搜索' })
  list(
    @Query('status') status?: (typeof PLATFORM_STATUSES)[number],
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
  ) {
    const parsed = status && z.enum(PLATFORM_STATUSES).safeParse(status);
    const queueStatus = parsed?.success ? parsed.data : 'PENDING_REVIEW';
    return this.service.listPlatformQueue(
      queueStatus as ContributionPlatformStatus,
      page ? Math.max(1, Number(page)) : 1,
      pageSize ? Math.min(100, Math.max(1, Number(pageSize))) : 20,
      keyword,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: '平台贡献投稿详情' })
  detail(@Param('id') id: string) {
    return this.service.getPlatformSubmission(id);
  }

  @Post(':id/review')
  @ApiOperation({ summary: '平台审核贡献投稿' })
  review(@Request() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.reviewPlatform(req.user.id, id, ContributionReviewDecisionSchema.parse(body));
  }
}

@ApiTags('Admin Capability Review')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/capability-review')
export class CapabilityReviewAdminController {
  constructor(private readonly service: CapabilityContributionService) {}

  @Get()
  @ApiOperation({ summary: '统一能力与 Skill 版本审核队列' })
  list(@Query('kind') kind?: 'ALL' | 'CAPABILITY' | 'SKILL_VERSION') {
    const parsed = kind && z.enum(REVIEW_KINDS).safeParse(kind);
    return this.service.listUnifiedReviewQueue(parsed?.success ? parsed.data : 'ALL');
  }

  @Get('metrics')
  @ApiOperation({ summary: '能力贡献生产运营指标' })
  @ApiResponse({ status: 200, description: '返回统计窗口内的下载授权请求、审核驳回与扫描分布' })
  metrics(@Query('days') days?: string) {
    return this.service.productionMetrics(Number(days) || 30);
  }

  @Get('rpa-versions/:versionId/preview')
  @ApiOperation({ summary: '查看 RPA 包文件清单与安全扫描结果' })
  @ApiResponse({ status: 200, description: '返回 RPA 包元数据、文件清单和静态检查结果' })
  @ApiResponse({ status: 404, description: 'RPA 版本不存在或包不可读' })
  previewRpa(@Param('versionId') versionId: string) {
    return this.service.getRpaVersionPreview(versionId);
  }

  @Get('versions/:versionId/diff')
  @ApiOperation({ summary: '平台审核人查看 Skill 版本差异与审核历史' })
  versionDiff(@Request() req: AuthRequest, @Param('versionId') versionId: string) {
    return this.service.getVersionDiff(req.user.id, versionId, 'ADMIN');
  }

  @Post('versions/:versionId/review')
  @ApiOperation({ summary: '平台管理员审核 Skill 版本' })
  @ApiResponse({ status: 409, description: '版本当前状态不可审核' })
  reviewVersion(
    @Request() req: AuthRequest,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
  ) {
    return this.service.reviewPlatformVersion(
      req.user.id,
      versionId,
      ContributionReviewDecisionSchema.parse(body),
    );
  }

  @Post('capabilities/:capabilityId/bind')
  @ApiOperation({ summary: '将已发布能力快捷绑定到已有数字员工' })
  @ApiResponse({ status: 201, description: '能力绑定成功' })
  @ApiResponse({ status: 404, description: '已发布能力或数字员工不存在' })
  bindPublished(@Request() req: AuthRequest, @Param('capabilityId') capabilityId: string, @Body() body: unknown) {
    const dto = ContributionEmployeeBindSchema.parse(body);
    return this.service.bindPublishedCapability(req.user.id, capabilityId, dto.employeeId, dto.priority);
  }
}
