import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { SkillImportService } from './skill-import.service';
import { ImportUploadTicket } from './skill-import-state';

export type ImportUploadRequest = Request & { skillImportUpload?: ImportUploadTicket };
export function importBearer(authorization: string | undefined): string {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) throw new UnauthorizedException({ code: 'GRANT_EXPIRED', message: '缺少有效的导入授权' });
  return authorization.slice(7);
}

@Injectable()
export class SkillImportUploadGuard implements CanActivate {
  constructor(private readonly service: SkillImportService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ImportUploadRequest>();
    const operationId = typeof request.query.operationId === 'string' ? request.query.operationId : undefined;
    request.skillImportUpload = await this.service.beginUpload(String(request.params.id), importBearer(request.headers.authorization), operationId);
    return true;
  }
}
