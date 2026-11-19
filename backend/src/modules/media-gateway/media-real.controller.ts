import {
  Body, Controller, Get, Header, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { z } from 'zod';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { ClientEmployment } from '../client/client-employment.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  IMAGE_REFERENCE_MAX_BYTES, MediaGatewayIdSchema, MediaRealAnyQuoteRequestSchema, MediaRealAnyRequestSchema,
} from 'shared';
import type { MediaRealAnyQuoteRequest, MediaRealAnyRequest } from 'shared';
import { MediaRealService } from './media-real.service';
import { MediaRealGuard } from './media-real.guard';
import { MediaSpecValidationPipe } from './media-spec-validation.pipe';

@ApiTags('media-gateway-real')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: '字段、JPEG/PNG/WebP 参考图片或参数无效' })
@ApiResponse({ status: 401, description: 'employment token 无效' })
@ApiResponse({ status: 403, description: '订阅授权失效或真实媒体预算不足' })
@ApiResponse({ status: 404, description: '当前作用域内不存在资源' })
@ApiResponse({ status: 409, description: '幂等冲突、报价/配置失效或不支持取消' })
@ApiResponse({ status: 410, description: '参考或结果已过期' })
@ApiResponse({ status: 429, description: '默认业务限流' })
@ApiResponse({ status: 503, description: '真实媒体未启用、连接不可用或存储暂不可用；查原 ID，不重发生成' })
@SkipThrottle({ auth: true, chat: true })
@UseGuards(ClientEmploymentGuard, MediaRealGuard)
@Controller('gateway/v1/media/real')
export class MediaRealController {
  constructor(private readonly media: MediaRealService) {}

  @Get('profiles')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '获取当前企业允许的真实图片 Profile' })
  @ApiResponse({ status: 200, description: '真实执行能力与企业策略相交后的 Profile' })
  profiles(@ClientEmployment() claims: ClientEmploymentClaims, @Query('protocolVersion') version?: string) {
    return this.media.profiles(claims, version === '3' ? 3 : 1);
  }

  @Post('references')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '上传 JPEG、PNG 或 WebP 原始参考图并保存作用域隔离的元数据' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiResponse({ status: 201, description: '真实参考图描述' })
  @ApiResponse({ status: 413, description: '超过 5 MiB 文件大小限制' })
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    // Busboy emits partsLimit when the threshold is reached, not exceeded.
    limits: { fileSize: IMAGE_REFERENCE_MAX_BYTES + 1, files: 1, fields: 0, parts: 2 },
  }))
  reference(@ClientEmployment() claims: ClientEmploymentClaims, @UploadedFile() file: Express.Multer.File, @Body() fields: unknown) {
    return this.media.uploadReference(claims, file, fields);
  }

  @Post('quotes')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '生成真实图片报价，不在报价阶段执行上游' })
  @ApiResponse({ status: 201, description: '真实报价与资金状态' })
  @ApiResponse({ status: 422, description: '不支持的 Profile 或规格' })
  quote(
    @ClientEmployment() claims: ClientEmploymentClaims,
    @Body(new MediaSpecValidationPipe(MediaRealAnyQuoteRequestSchema)) dto: MediaRealAnyQuoteRequest,
  ) { return this.media.quote(claims, dto); }

  @Post('requests')
  @ApiOperation({ summary: '按幂等键提交一次真实图片执行' })
  @ApiResponse({ status: 200, description: '同步或终态真实回执' })
  @ApiResponse({ status: 202, description: '已受理或提交结果不明的真实回执' })
  async submit(
    @ClientEmployment() claims: ClientEmploymentClaims,
    @Body(new MediaSpecValidationPipe(MediaRealAnyRequestSchema)) dto: MediaRealAnyRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const receipt = await this.media.submit(claims, dto);
    res.status(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(receipt.status) ? 202 : 200);
    res.setHeader('Cache-Control', 'no-store');
    return receipt;
  }

  @Get('requests/by-client-id/:requestId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '查找原真实回执，不重新提交生成' })
  @ApiResponse({ status: 200, description: '当前成员/订阅所属真实回执' })
  byClientId(@ClientEmployment() claims: ClientEmploymentClaims, @Param('requestId', new ZodValidationPipe(MediaGatewayIdSchema)) id: string) {
    return this.media.findByClientId(claims, id);
  }

  @Get('requests/:receiptId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '查询原真实回执' })
  @ApiResponse({ status: 200, description: '真实回执与执行状态' })
  receipt(@ClientEmployment() claims: ClientEmploymentClaims, @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) id: string) {
    return this.media.receipt(claims, id);
  }

  @Get('requests/:receiptId/outputs/:outputId/content')
  @ApiOperation({ summary: '授权后下载真实 PNG 输出' })
  @ApiResponse({ status: 200, description: '裸 PNG 字节及 SHA256 响应头' })
  async content(
    @ClientEmployment() claims: ClientEmploymentClaims,
    @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) receiptId: string,
    @Param('outputId', new ZodValidationPipe(MediaGatewayIdSchema)) outputId: string,
    @Res() res: Response,
  ) {
    const { output, bytes } = await this.media.content(claims, receiptId, outputId);
    res.set({
      'Content-Type': output.mimeType, 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${output.outputId}.png"`,
      'X-SHA256': output.sha256, 'X-SEP-Media-Mock': 'false',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.send(bytes);
  }

  @Post('requests/:receiptId/cancel')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '检查真实同步执行的取消能力；当前不支持取消' })
  @ApiResponse({ status: 409, description: 'CANCEL_UNSUPPORTED，不改变原请求或账务' })
  cancel(
    @ClientEmployment() claims: ClientEmploymentClaims,
    @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) id: string,
    @Body(new ZodValidationPipe(z.object({}).strict().default({}))) _body: Record<string, never>,
  ) { return this.media.cancel(claims, id); }
}
