import { Body, Controller, Get, Header, Logger, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { z } from 'zod';
import { pipeline } from 'node:stream/promises';
import { MediaGatewayIdSchema, MediaVideoRealQuoteRequestSchema, MediaVideoRealRequestSchema, VIDEO_REFERENCE_MAX_BYTES } from 'shared';
import type { MediaVideoRealQuoteRequest, MediaVideoRealRequest } from 'shared';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { ClientEmployment } from '../client/client-employment.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MediaSpecValidationPipe } from './media-spec-validation.pipe';
import { MediaVideoRealGuard } from './media-video-real.guard';
import { MediaVideoRealService } from './media-video-real.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

@ApiTags('media-video-real')
@ApiBearerAuth()
@ApiResponse({ status: 200, description: 'Original video receipt or verified content' })
@ApiResponse({ status: 201, description: 'Reference or frozen quote saved' })
@ApiResponse({ status: 202, description: 'Original asynchronous request is pending' })
@ApiResponse({ status: 400, description: 'Invalid parameters or PNG' })
@ApiResponse({ status: 401, description: 'Invalid employment token' })
@ApiResponse({ status: 402, description: 'Insufficient funds' })
@ApiResponse({ status: 403, description: 'Membership, subscription or video grant revoked' })
@ApiResponse({ status: 404, description: 'Resource not found in current scope' })
@ApiResponse({ status: 409, description: 'Configuration, concurrency or idempotency conflict; cancellation unsupported' })
@ApiResponse({ status: 410, description: 'Reference or original result expired' })
@ApiResponse({ status: 413, description: 'Reference exceeds 10MiB' })
@ApiResponse({ status: 429, description: 'Rate limited' })
@ApiResponse({ status: 502, description: 'Upstream response or media integrity failure' })
@ApiResponse({ status: 503, description: 'Execution disabled, storage or verified pricing unavailable' })
@SkipThrottle({ auth: true, chat: true })
@UseGuards(ClientEmploymentGuard, MediaVideoRealGuard)
@Controller('gateway/v1/media/video-real')
export class MediaVideoRealController {
  private readonly logger = new Logger(MediaVideoRealController.name);
  constructor(private readonly media: MediaVideoRealService) {}

  @Get('profiles')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List authorized real video profiles' })
  profiles(@ClientEmployment() claims: ClientEmploymentClaims, @Query('protocolVersion') protocolVersion?: string) {
    return this.media.profiles(claims, protocolVersion === '3' ? 3 : 1);
  }

  @Post('references')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Upload a validated PNG reference' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: VIDEO_REFERENCE_MAX_BYTES, files: 1, fields: 0, parts: 2 } }))
  reference(@ClientEmployment() claims: ClientEmploymentClaims, @UploadedFile() file: Express.Multer.File, @Body() fields: unknown) {
    return this.media.reference(claims, file, fields);
  }

  @Post('quotes')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Freeze customer video price, input hash and connection revision' })
  quote(@ClientEmployment() claims: ClientEmploymentClaims, @Body(new MediaSpecValidationPipe(MediaVideoRealQuoteRequestSchema)) input: MediaVideoRealQuoteRequest) {
    return this.media.quote(claims, input);
  }

  @Post('requests')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Submit once or recover the original real video request' })
  async submit(@ClientEmployment() claims: ClientEmploymentClaims, @Body(new MediaSpecValidationPipe(MediaVideoRealRequestSchema)) input: MediaVideoRealRequest,
    @Res({ passthrough: true }) response: Response) {
    const receipt = await this.media.submit(claims, input);
    response.status(['SUBMITTING', 'SUBMISSION_UNKNOWN', 'QUEUED', 'RUNNING'].includes(receipt.status) ? 202 : 200);
    return receipt;
  }

  @Get('requests/by-client-id/:requestId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Find the original video receipt by clientRequestId' })
  byClientId(@ClientEmployment() claims: ClientEmploymentClaims, @Param('requestId', new ZodValidationPipe(MediaGatewayIdSchema)) requestId: string) {
    return this.media.findByClientId(claims, requestId);
  }

  @Get('requests/:receiptId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Query original task, validate result and reconcile billing evidence' })
  receipt(@ClientEmployment() claims: ClientEmploymentClaims, @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) receiptId: string) {
    return this.media.receipt(claims, receiptId);
  }

  @Get('requests/:receiptId/outputs/:outputId/content')
  @ApiOperation({ summary: 'Download scope-authorized verified original video bytes' })
  async content(@ClientEmployment() claims: ClientEmploymentClaims, @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) receiptId: string,
    @Param('outputId', new ZodValidationPipe(MediaGatewayIdSchema)) outputId: string, @Res() response: Response) {
    const { output, stream } = await this.media.content(claims, receiptId, outputId);
    response.set({ 'Content-Type': output.mimeType, 'Content-Length': String(output.byteLength), 'X-SHA256': output.sha256,
      'X-SEP-Media-Mock': 'false', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    try { await pipeline(stream, response); }
    catch (error) {
      this.logger.error({ event: 'video_download_failed', receiptId, outputId, diagnostic: exceptionDetails(error) });
      stream.destroy(); response.destroy();
    }
  }

  @Post('requests/:receiptId/cancel')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cancellation is unsupported; never promises a refund' })
  cancel(@ClientEmployment() claims: ClientEmploymentClaims, @Param('receiptId', new ZodValidationPipe(MediaGatewayIdSchema)) receiptId: string,
    @Body(new ZodValidationPipe(z.object({}).strict().default({}))) _input: Record<string, never>) {
    return this.media.cancel(claims, receiptId);
  }
}
