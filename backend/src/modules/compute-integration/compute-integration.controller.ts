import { Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ComputeIntegrationIdSchema, ComputeIntegrationListSchema, ComputeIntegrationRecordsQuerySchema, type ComputeIntegrationList, type ComputeIntegrationRecordsQuery } from 'shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ComputeIntegrationService } from './compute-integration.service';

@ApiTags('Compute Integration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/compute-integrations')
export class ComputeIntegrationController {
  constructor(private readonly service: ComputeIntegrationService) {}

  @Get()
  @ApiOperation({ summary: '查看企业算力连接准备状态' })
  @ApiResponse({ status: 200, description: '企业列表，不包含密钥' })
  @ApiResponse({ status: 403, description: '仅平台管理员可查看' })
  list(@Query(new ZodValidationPipe(ComputeIntegrationListSchema)) query: ComputeIntegrationList) { return this.service.list(query); }

  @Get(':enterpriseId')
  @ApiOperation({ summary: '查看企业算力连接详情' })
  @ApiResponse({ status: 200, description: '连接状态及凭证遮罩' })
  @ApiResponse({ status: 404, description: '企业不存在' })
  view(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.service.view(id); }

  @Get(':enterpriseId/records')
  @ApiOperation({ summary: '查看企业开户及账务同步记录' })
  @ApiResponse({ status: 200, description: '最近同步操作和人民币账务记录' })
  records(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string,
    @Query(new ZodValidationPipe(ComputeIntegrationRecordsQuerySchema)) query: ComputeIntegrationRecordsQuery) { return this.service.records(id, query); }

  @Post(':enterpriseId/prepare')
  @ApiOperation({ summary: '创建企业开户任务，开户成功后自动接通企业算力' })
  @ApiResponse({ status: 201, description: '保存准备状态；未接通时不会发送远端请求' })
  @ApiResponse({ status: 409, description: '企业状态不允许操作' })
  prepare(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.service.prepare(id); }

  @Post('jobs/:jobId/retry')
  @ApiOperation({ summary: '恢复原同步操作，接口未接通时拒绝重试' })
  @ApiResponse({ status: 201, description: '原操作进入待处理状态' })
  @ApiResponse({ status: 503, description: '远端接口尚未接通' })
  retry(@Param('jobId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.service.retry(id); }

}

@ApiTags('Enterprise Compute Integration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('enterprise/compute-integration')
export class EnterpriseComputeIntegrationController {
  constructor(private readonly service: ComputeIntegrationService) {}
  @Get()
  @ApiOperation({ summary: '企业管理员查看自己企业的算力连接状态' })
  @ApiResponse({ status: 200, description: '当前企业的连接状态' })
  @ApiResponse({ status: 403, description: '非企业管理员' })
  view(@Request() req: { user: { id: string } }) { return this.service.forEnterpriseAdmin(req.user.id); }
}
