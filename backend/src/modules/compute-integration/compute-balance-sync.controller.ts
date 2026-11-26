import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ComputeBalanceBaselineSchema, ComputeBalanceEventSchema, ComputeIntegrationIdSchema,
  type ComputeBalanceBaseline, type ComputeBalanceEventPayload } from 'shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ComputeBalanceSignatureGuard } from './compute-balance-signature.guard';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';
import { ComputeSpendingPolicyService } from './compute-spending-policy.service';

@ApiTags('Compute Balance Events')
@Controller('compute-integration/balance-events')
export class ComputeBalanceWebhookController {
  constructor(private readonly service: ComputeBalanceSyncService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ComputeBalanceSignatureGuard)
  @ApiOperation({ summary: '接收算力平台签名余额事件，事务入账后确认' })
  @ApiResponse({ status: 200, description: '同一事件已入账，重复通知不重复加减' })
  @ApiResponse({ status: 401, description: '签名、时间窗口或 nonce 无效' })
  @ApiResponse({ status: 409, description: '事件归属、顺序或原账务不一致，未确认入账' })
  receive(@Body(new ZodValidationPipe(ComputeBalanceEventSchema)) body: ComputeBalanceEventPayload, @Req() req: Request) {
    if (req.get('Idempotency-Key') !== body.event_id) throw new BadRequestException({ code: 'COMPUTE_EVENT_ID_MISMATCH', message: 'Idempotency-Key 必须等于余额事件编号' });
    return this.service.receive(body);
  }
}

@ApiTags('Compute Balance Sync Administration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/compute-integrations/:enterpriseId/balance-sync')
export class ComputeBalanceSyncController {
  constructor(private readonly service: ComputeBalanceSyncService, private readonly spending: ComputeSpendingPolicyService) {}

  @Get('funds')
  @ApiOperation({ summary: '查看企业算力总额、成员分配、同步缺口和待结算资金' })
  @ApiResponse({ status: 200, description: '人民币六位小数字符串，远端余额对应返回的同步水位' })
  @ApiResponse({ status: 403, description: '仅平台管理员可查看' })
  funds(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.spending.summary(id); }

  @Get()
  @ApiOperation({ summary: '查看企业余额同步水位、失败原因及最近事件' })
  @ApiResponse({ status: 200, description: '余额事件状态，不含密钥' })
  @ApiResponse({ status: 403, description: '仅平台管理员可查看' })
  status(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.service.status(id); }

  @Post('pull')
  @ApiOperation({ summary: '补拉原余额事件并确认，不重新执行算力账务' })
  @ApiResponse({ status: 201, description: '补拉及确认完成' })
  @ApiResponse({ status: 409, description: '原事件未满足入账条件' })
  pull(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string) { return this.service.sync(id); }

  @Post('baseline')
  @ApiOperation({ summary: '按已核对历史快照设置首次迁移起点，不允许跳过同步事件' })
  @ApiResponse({ status: 201, description: '迁移起点已保存' })
  @ApiResponse({ status: 409, description: '历史未核对、存在被跳过事件或同步水位已推进' })
  baseline(@Param('enterpriseId', new ZodValidationPipe(ComputeIntegrationIdSchema)) id: string,
    @Body(new ZodValidationPipe(ComputeBalanceBaselineSchema)) body: ComputeBalanceBaseline) {
    return this.service.initializeBaseline(id, body.afterSequence);
  }
}
