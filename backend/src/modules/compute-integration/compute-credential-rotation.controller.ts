import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ComputeCredentialRotationRequestSchema, ComputeIntegrationIdSchema, type ComputeCredentialRotationRequest } from 'shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ComputeCredentialRotationService } from './compute-credential-rotation.service';

@ApiTags('Enterprise Credential Rotation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('enterprise/compute-integration/credential-rotations')
export class ComputeCredentialRotationController {
  constructor(private readonly service: ComputeCredentialRotationService) {}
  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: '企业管理员一键更换用途凭证，重复操作编号不重复生成' })
  @ApiResponse({ status: 202, description: '原更换任务已保存，后台自动交付、切换并处理旧凭证' })
  @ApiResponse({ status: 403, description: '非本企业管理员' })
  @ApiResponse({ status: 409, description: '版本已变化或已有未完成更换' })
  start(@Req() req: { user: { id: string } }, @Body(new ZodValidationPipe(ComputeCredentialRotationRequestSchema)) body: ComputeCredentialRotationRequest) {
    return this.service.start(req.user.id, body);
  }
  @Get()
  @ApiOperation({ summary: '查看本企业最近凭证更换状态，不返回密文或明文' })
  @ApiResponse({ status: 200, description: '最近更换任务及明确失败原因' })
  @ApiResponse({ status: 403, description: '仅企业管理员' })
  list(@Req() req: { user: { id: string } }) { return this.service.list(req.user.id); }
  @Post(':operationId/retry')
  @HttpCode(202)
  @ApiOperation({ summary: '恢复本企业被暂停的原更换操作，不创建新编号' })
  @ApiResponse({ status: 202, description: '原操作恢复处理' })
  @ApiResponse({ status: 404, description: '原操作不存在或不属于本企业' })
  retry(@Req() req: { user: { id: string } }, @Param('operationId', new ZodValidationPipe(ComputeIntegrationIdSchema)) operation: string) {
    return this.service.retry(req.user.id, operation);
  }
  @Get(':operationId')
  @ApiOperation({ summary: '查询本企业原更换操作' })
  @ApiResponse({ status: 200, description: '原操作状态' })
  @ApiResponse({ status: 404, description: '操作不存在或不属于本企业' })
  get(@Req() req: { user: { id: string } }, @Param('operationId', new ZodValidationPipe(ComputeIntegrationIdSchema)) operation: string) {
    return this.service.get(req.user.id, operation);
  }
}
