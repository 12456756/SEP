import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs/operators';

/** Keep persisted billing metadata out of the strict legacy desktop JSON contract. */
@Injectable()
export class MediaPaymentModeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { paymentMode, ...body } = value;
      const fundingMode = body.funding?.paymentMode;
      if (!paymentMode && !fundingMode) return value;
      context.switchToHttp().getResponse<Response>().setHeader('X-SEP-Payment-Mode', paymentMode ?? fundingMode);
      if (fundingMode) {
        const { paymentMode: _mode, ...funding } = body.funding;
        body.funding = funding;
      }
      return body;
    }));
  }
}
