import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import type { Request, Response } from 'express';
import { rm } from 'node:fs/promises';
import { MediaVideoReferenceUploadQuerySchema } from 'shared';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { MediaVideoRealService } from './media-video-real.service';
import { VideoReferenceUploadService, VIDEO_UPLOAD_TIMEOUT_MS, videoUploadError } from './video-reference-upload.service';
import type { InspectedVideoReference } from './video-reference-upload.service';
import { exceptionDetails } from '../../common/errors/error-diagnostics';

export type VideoReferenceUploadRequest = Request & {
  clientEmployment: ClientEmploymentClaims;
  videoReferenceUpload: { file: InspectedVideoReference; context: Awaited<ReturnType<MediaVideoRealService['prepareVideoReference']>>; signal: AbortSignal };
};

@Injectable()
export class VideoReferenceUploadInterceptor implements NestInterceptor {
  private readonly logger = new Logger(VideoReferenceUploadInterceptor.name);
  constructor(private readonly media: MediaVideoRealService, private readonly uploads: VideoReferenceUploadService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<VideoReferenceUploadRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    return defer(async () => {
      const query = MediaVideoReferenceUploadQuerySchema.safeParse(req.query);
      if (!query.success) videoUploadError(400, 'INVALID_PARAMETER', '参考视频 Profile 参数无效', 'validation', query.error);
      const abort = new AbortController();
      const disconnected = () => abort.abort(new Error('Video upload connection closed'));
      req.once('aborted', disconnected); res.once('close', disconnected);
      const timer = setTimeout(() => abort.abort(new Error('Video upload exceeded five minutes')), VIDEO_UPLOAD_TIMEOUT_MS);
      timer.unref();
      let release: (() => Promise<void>) | undefined;
      let directory: string | undefined;
      try {
        const prepared = await this.media.prepareVideoReference(req.clientEmployment, query.data);
        release = await this.uploads.acquire();
        directory = await this.uploads.directory();
        const file = await this.uploads.receive(req, res, directory, prepared.capabilities.maxVideoReferenceBytes, abort.signal);
        if (!prepared.capabilities.videoReferenceMimeTypes.includes(file.mimeType)) videoUploadError(415, 'UNSUPPORTED_VIDEO_REFERENCE_FORMAT', '参考视频格式不在 Profile 允许范围内', 'inspect');
        req.videoReferenceUpload = { file, context: prepared, signal: abort.signal };
        return await lastValueFrom(next.handle());
      } finally {
        clearTimeout(timer); req.off('aborted', disconnected); res.off('close', disconnected);
        try { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
        catch (error) { this.logger.error({ event: 'video_upload_cleanup_failed', details: exceptionDetails(error) }); }
        finally { await release?.(); }
      }
    });
  }
}
