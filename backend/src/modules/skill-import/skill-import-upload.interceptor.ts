import { BadRequestException, CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { Response } from 'express';
import multer, { memoryStorage, MulterError } from 'multer';
import { catchError, concatMap, finalize, from, map, Observable, throwError } from 'rxjs';
import { SKILL_PACKAGE_MAX_BYTES } from 'shared';
import { ImportUploadRequest } from './skill-import-upload.guard';
import { SkillImportService } from './skill-import.service';

@Injectable()
export class SkillImportUploadInterceptor implements NestInterceptor {
  private readonly parser = multer({ storage: memoryStorage(), limits: { fileSize: SKILL_PACKAGE_MAX_BYTES, files: 1, fields: 0, parts: 2, fieldNameSize: 64 } }).single('file');
  constructor(private readonly service: SkillImportService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<ImportUploadRequest>();
    const ticket = request.skillImportUpload!;
    if (ticket.replay) return from(this.service.replayUpload(ticket));
    const timeout = setTimeout(() => request.destroy(new Error('IMPORT_UPLOAD_TIMEOUT')), Math.max(1, ticket.deadline - Date.now()));
    timeout.unref();
    try {
      // Use the workspace's Multer directly so aborted streams are handled by its current implementation.
      await new Promise<void>((resolve, reject) => this.parser(request, context.switchToHttp().getResponse<Response>(), (error: unknown) => {
        if (error) reject(error); else resolve();
      }));
      const response = next.handle();
      return response.pipe(
        concatMap((value) => from(this.service.finishUpload(ticket)).pipe(map(() => value))),
        catchError((error: unknown) => from(this.service.finishUpload(ticket, true)).pipe(concatMap(() => throwError(() => error)))),
        finalize(() => clearTimeout(timeout)),
      );
    } catch (error) {
      clearTimeout(timeout);
      await this.service.finishUpload(ticket, true);
      if (error instanceof HttpException) throw error;
      if (error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE') throw new PayloadTooLargeException({ code: 'PACKAGE_REJECTED', message: 'Skill ZIP 不能超过 100MiB' });
      throw new BadRequestException({ code: 'PACKAGE_REJECTED', message: 'Skill ZIP 上传中断或 multipart 格式不合法' });
    }
  }
}
