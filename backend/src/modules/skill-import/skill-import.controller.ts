import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Request, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SkillImportService } from './skill-import.service';
import { ImportUser } from './skill-import-state';
import { SkillImportResponseInterceptor } from './skill-import-response.interceptor';
import { SkillImportConfirmDeviceSchema, SkillImportDeviceQuerySchema, SkillImportPreviewSchema, SkillImportQuerySchema, SkillImportSelectionSchema, SkillImportSessionCreateSchema } from 'shared';

type WebRequest = { user: ImportUser };

@ApiTags('skill-import')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: '请求不合法' })
@ApiResponse({ status: 401, description: 'Web 会话失效' })
@ApiResponse({ status: 403, description: '发起者身份或权限失效' })
@ApiResponse({ status: 409, description: '导入状态冲突' })
@ApiResponse({ status: 410, description: '导入会话结束' })
@ApiResponse({ status: 429, description: '导入请求限流' })
@ApiResponse({ status: 503, description: '导入未开放或基础服务不可用' })
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(SkillImportResponseInterceptor)
@Roles(UserRole.ADMIN)
@Controller('skill-import')
export class SkillImportController {
  constructor(private readonly service: SkillImportService) {}

  @Get('config') @ApiOperation({ summary: '查询本机导入开关与协议版本' }) @ApiResponse({ status: 200 })
  config(@Request() req: WebRequest) { return this.service.getConfig(req.user); }

  @Post('sessions') @ApiOperation({ summary: '创建本机 Skill 导入会话' }) @ApiResponse({ status: 201 })
  create(@Request() req: WebRequest, @Body(new ZodValidationPipe(SkillImportSessionCreateSchema)) body: z.infer<typeof SkillImportSessionCreateSchema>) { return this.service.createSession(req.user, body); }

  @Get('sessions/:id') @ApiOperation({ summary: '查询会话状态、候选、预览、文件或操作结果' }) @ApiResponse({ status: 200 })
  get(@Request() req: WebRequest, @Param('id') id: string, @Query(new ZodValidationPipe(SkillImportQuerySchema)) query: z.infer<typeof SkillImportQuerySchema>) { return this.service.getSession(req.user, id, query); }

  @Post('sessions/:id/confirm-device') @HttpCode(200) @ApiOperation({ summary: '核对短码并确认当前设备' }) @ApiResponse({ status: 200 })
  confirm(@Request() req: WebRequest, @Param('id') id: string, @Body(new ZodValidationPipe(SkillImportConfirmDeviceSchema)) body: z.infer<typeof SkillImportConfirmDeviceSchema>) { return this.service.confirmDevice(req.user, id, body); }

  @Post('sessions/:id/preview') @HttpCode(202) @ApiOperation({ summary: '请求异步快照预览' }) @ApiResponse({ status: 202 })
  preview(@Request() req: WebRequest, @Param('id') id: string, @Body(new ZodValidationPipe(SkillImportPreviewSchema)) body: z.infer<typeof SkillImportPreviewSchema>) { return this.service.requestPreview(req.user, id, body); }

  @Post('sessions/:id/selection') @HttpCode(202) @ApiOperation({ summary: '选择完整快照并下发打包命令' }) @ApiResponse({ status: 202 })
  select(@Request() req: WebRequest, @Param('id') id: string, @Body(new ZodValidationPipe(SkillImportSelectionSchema)) body: z.infer<typeof SkillImportSelectionSchema>) { return this.service.select(req.user, id, body); }

  @Delete('sessions/:id') @ApiOperation({ summary: '取消导入并撤销本次所有授权' }) @ApiResponse({ status: 200 })
  cancel(@Request() req: WebRequest, @Param('id') id: string) { return this.service.cancel(req.user, id); }

  @Get('devices') @ApiOperation({ summary: '列出当前管理员记住的导入设备' }) @ApiResponse({ status: 200 })
  devices(@Request() req: WebRequest, @Query(new ZodValidationPipe(SkillImportDeviceQuerySchema)) query: z.infer<typeof SkillImportDeviceQuerySchema>) { return this.service.listDevices(req.user, query); }

  @Delete('devices/:deviceId') @ApiOperation({ summary: '撤销记住的导入设备' }) @ApiResponse({ status: 200 })
  revoke(@Request() req: WebRequest, @Param('deviceId') id: string) { return this.service.revokeDevice(req.user, id); }
}
