import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SkillImportChallengeSchema, SkillImportCommandCursorSchema, SkillImportDeviceRevokeSchema, SkillImportEvent, SkillImportEventSchema, SkillImportGrantSchema, SkillImportPairingSchema, SkillImportUploadGrantSchema } from 'shared';
import { SkillImportService } from './skill-import.service';
import { ImportUploadRequest, importBearer, SkillImportUploadGuard } from './skill-import-upload.guard';
import { SkillImportUploadInterceptor } from './skill-import-upload.interceptor';
import { SkillImportResponseInterceptor } from './skill-import-response.interceptor';

@ApiTags('skill-import/connector')
@ApiResponse({ status: 400, description: '请求或包不合法' })
@ApiResponse({ status: 401, description: '挑战或受限 grant 无效' })
@ApiResponse({ status: 403, description: 'owner 或设备授权已撤销' })
@ApiResponse({ status: 409, description: '状态、序号或快照冲突' })
@ApiResponse({ status: 410, description: '导入已结束' })
@ApiResponse({ status: 413, description: '请求超过预算' })
@ApiResponse({ status: 429, description: '请求限流或并发上传已满' })
@ApiResponse({ status: 503, description: '基础服务暂不可用' })
@Controller('skill-import/connector')
@UseInterceptors(SkillImportResponseInterceptor)
export class SkillImportConnectorController {
  constructor(private readonly service: SkillImportService) {}

  @Post('pairings') @HttpCode(200) @ApiOperation({ summary: '创建独立客户端配对请求' }) @ApiResponse({ status: 200 })
  pairing(@Body(new ZodValidationPipe(SkillImportPairingSchema)) body: z.infer<typeof SkillImportPairingSchema>) { return this.service.createPairing(body); }

  @Post('challenges') @HttpCode(200) @ApiOperation({ summary: '申请本次会话证明或离线设备撤销挑战' }) @ApiResponse({ status: 200 })
  challenge(@Body(new ZodValidationPipe(SkillImportChallengeSchema)) body: z.infer<typeof SkillImportChallengeSchema>) { return this.service.createChallenge(body); }

  @Post('grants') @ApiOperation({ summary: '提交签名与本机 consent，换取仅限本次会话的 grant' }) @ApiResponse({ status: 200 }) @ApiResponse({ status: 202, description: '等待 Web 确认，同签名有界重试' })
  async grant(@Body(new ZodValidationPipe(SkillImportGrantSchema)) body: z.infer<typeof SkillImportGrantSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.grant(body);
    response.status(result.status === 'pending-web-confirmation' ? 202 : 200);
    return result;
  }

  @Get('sessions/:id/commands') @ApiBearerAuth('skill-import-grant') @ApiOperation({ summary: '领取固定类型命令，未确认命令至少一次投递' }) @ApiResponse({ status: 200 })
  commands(@Param('id') id: string, @Query('cursor', new ZodValidationPipe(SkillImportCommandCursorSchema)) cursor: number, @Headers('authorization') authorization: string | undefined) { return this.service.commands(id, importBearer(authorization), cursor); }

  @Post('sessions/:id/events') @ApiBearerAuth('skill-import-grant') @HttpCode(200) @ApiOperation({ summary: '按顺序提交受控类型事件并取得 ack' }) @ApiResponse({ status: 200 })
  event(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Body(new ZodValidationPipe(SkillImportEventSchema)) body: SkillImportEvent) { return this.service.event(id, importBearer(authorization), body); }

  @Get('sessions/:id/operations/:operationId') @ApiBearerAuth('skill-import-grant') @ApiOperation({ summary: '查询上传操作安全摘要' }) @ApiResponse({ status: 200 })
  operation(@Param('id') id: string, @Param('operationId') operationId: string, @Headers('authorization') authorization: string | undefined) { return this.service.operation(id, importBearer(authorization), operationId); }

  @Post('sessions/:id/operations/:operationId/upload-grant') @ApiBearerAuth('skill-import-grant') @HttpCode(200) @ApiOperation({ summary: 'ZIP 已就绪后绑定摘要并申请短期上传授权' }) @ApiResponse({ status: 200 })
  uploadGrant(@Param('id') id: string, @Param('operationId') operationId: string, @Headers('authorization') authorization: string | undefined, @Body(new ZodValidationPipe(SkillImportUploadGrantSchema)) body: z.infer<typeof SkillImportUploadGrantSchema>) { return this.service.uploadGrant(id, importBearer(authorization), operationId, body); }

  @Post('sessions/:id/package') @ApiBearerAuth('skill-import-grant') @HttpCode(200) @ApiConsumes('multipart/form-data') @ApiOperation({ summary: '先鉴权并取得并发槽，再解析和校验 Skill ZIP' }) @ApiResponse({ status: 200 })
  @UseGuards(SkillImportUploadGuard) @UseInterceptors(SkillImportUploadInterceptor)
  package(@Req() request: ImportUploadRequest, @UploadedFile() file: Express.Multer.File) { return this.service.upload(request.skillImportUpload!, file); }

  @Delete('sessions/:id') @ApiBearerAuth('skill-import-grant') @ApiOperation({ summary: '客户端取消本次会话' }) @ApiResponse({ status: 200 })
  cancel(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) { return this.service.connectorCancel(id, importBearer(authorization)); }

  @Post('devices/:deviceId/revoke') @HttpCode(200) @ApiOperation({ summary: '无需活动导入会话，通过专用签名撤销本机设备' }) @ApiResponse({ status: 200 })
  revoke(@Param('deviceId') deviceId: string, @Body(new ZodValidationPipe(SkillImportDeviceRevokeSchema)) body: z.infer<typeof SkillImportDeviceRevokeSchema>) { return this.service.revokeConnectorDevice(deviceId, body); }
}
