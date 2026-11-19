import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodTypeAny } from 'zod';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

function flatten(issues: ZodIssue[]): ZodIssue[] {
  return issues.flatMap(issue => issue.code === 'invalid_union'
    ? issue.unionErrors.flatMap(error => flatten(error.issues)) : [issue]);
}

/** The V3 error envelope deliberately never echoes input or upstream bodies. */
export class MediaSpecValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown) {
    if (!value || typeof value !== 'object' || !('protocolVersion' in value)
      || value.protocolVersion !== 3) return new ZodValidationPipe(this.schema).transform(value);
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issues = flatten(result.error.issues);
    const conflict = issues.find(issue => issue.code === 'custom' && issue.params?.code === 'SPEC_CONFLICT');
    const issue = conflict ?? issues.find(item => item.path[0] === 'requestedSpec') ?? issues[0];
    const field = issue.path.map(String).join('.').slice(0, 128) || '(root)';
    const message = conflict ? '请求规格存在冲突' : '请求参数格式无效';
    throw new BadRequestException({ message, error: {
      code: conflict ? 'SPEC_CONFLICT' : 'INVALID_PARAMETER', message, field,
      reason: issue.message,
      source: 'request', stage: 'validation', retryable: false,
      submissionState: 'not_submitted', billingState: 'not_reserved',
    }, errors: issues.map(item => ({ field: item.path.map(String).join('.'), message: item.message, code: item.code })) });
  }
}
