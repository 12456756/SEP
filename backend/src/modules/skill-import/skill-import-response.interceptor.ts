import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { Request, Response } from 'express';
import { catchError, map, Observable, throwError } from 'rxjs';
import { SkillImportErrorCodeSchema } from 'shared';

@Injectable()
export class SkillImportResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger('SkillImportMetrics');
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();
    const large = request.query.view === 'preview' || request.query.view === 'operation' || /\/connector\/sessions\/[^/]+\/package\/?$/.test(request.path);
    const maxBytes = (large ? 16 : 1) * 1024 * 1024;
    return next.handle().pipe(
      map((value: unknown) => {
        const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
        if (bytes > maxBytes) throw new PayloadTooLargeException({ code: 'REQUEST_BODY_TOO_LARGE', message: '导入响应超过单次传输预算' });
        this.logger.log(JSON.stringify({ metric: 'skill_import_http', result: 'success', status: response.statusCode, elapsedMs: Date.now() - startedAt, responseBytes: bytes }));
        return value;
      }),
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        const body = error instanceof HttpException ? error.getResponse() : null;
        const details = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        const parsed = SkillImportErrorCodeSchema.safeParse(details.code);
        if (status === 429) response.setHeader('Retry-After', typeof details.retryAfterSeconds === 'number' ? Math.max(1, Math.min(300, Math.ceil(details.retryAfterSeconds))) : 2);
        this.logger.warn(JSON.stringify({ metric: 'skill_import_http', result: 'rejected', status, code: parsed.success ? parsed.data : 'HTTP_ERROR', elapsedMs: Date.now() - startedAt }));
        return throwError(() => error);
      }),
    );
  }
}
