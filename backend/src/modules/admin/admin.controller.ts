import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminService } from './admin.service';
import { AdminAuthService } from './admin-auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { z } from 'zod';
import { UserRole, UserStatus } from '@prisma/client';
import { CapabilityUploadDtoSchema, CnyAmountSchema, DigitalEmployeeCreateDtoSchema, EmployeeAvatarUrlSchema } from 'shared';
import { EmployeeCopyDraftDtoSchema, type EmployeeCopyDraftDto } from '../../shared/employee-copy.dto';
import { EmployeeCopyDraftService } from './employee-copy-draft.service';

const EmployeeDescriptionSchema = z.string().trim().min(1, '描述不能为空')
  .max(DigitalEmployeeCreateDtoSchema.shape.description.maxLength ?? 2000);
const CapabilityDescriptionSchema = z.string().trim().min(1, '描述不能为空')
  .max(CapabilityUploadDtoSchema.shape.description.maxLength ?? 2000);
const CapabilityNameSchema = z.string().trim().pipe(CapabilityUploadDtoSchema.shape.name);
const OptionalEmployeeAvatarSchema = z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  EmployeeAvatarUrlSchema.optional(),
);

const CreditAdjustmentSchema = z.object({
  amount: z.number().positive('金额必须大于0'),
  type: z.enum(['RECHARGE', 'DEDUCT'], {
    errorMap: () => ({ message: '类型必须是 RECHARGE 或 DEDUCT' })
  }),
  note: z.string().min(1, '备注不能为空').max(200, '备注不能超过200字符'),
});

const RefundDepositSchema = z.object({
  amount: z.number().positive('退款金额必须大于0'),
  reason: z.string().max(200, '退款原因不能超过200字符').optional(),
});

const SuspendSchema = z.object({
  reason: z.string().min(1, '原因不能为空').max(500, '原因不能超过500字符'),
});

const ApproveEmployeeSchema = z.object({
  note: z.string().optional(),
});

const RejectEmployeeSchema = z.object({
  reason: z.string().min(1, '拒绝原因不能为空').max(500, '原因不能超过500字符'),
});

const CreateEmployeeSchema = z.object({
  name: z.string().min(1, '员工名称不能为空'),
  description: EmployeeDescriptionSchema.optional(),
  industry: z.string().optional(),
  position: z.string().optional(),
  avatar: OptionalEmployeeAvatarSchema,
  systemPrompt: z.string().optional(),
  modelId: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  price: z.number().nonnegative().optional(),
  /** 年费（元） */
  annualPriceCNY: CnyAmountSchema.optional(),
  /** 订阅赠送算力（元）。null = 用系统默认值，0 = 明确不赠送。 */
  includedComputeCNY: CnyAmountSchema.nullable().optional(),
});

const UpdateEmployeeSchema = z.object({
  name: z.string().min(1, '员工名称不能为空').optional(),
  description: z.string().trim().max(DigitalEmployeeCreateDtoSchema.shape.description.maxLength ?? 2000).optional(),
  industry: z.string().optional(),
  position: z.string().optional(),
  avatar: OptionalEmployeeAvatarSchema,
  systemPrompt: z.string().optional(),
  modelId: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  price: z.number().nonnegative().optional(),
  annualPriceCNY: CnyAmountSchema.optional(),
  includedComputeCNY: CnyAmountSchema.nullable().optional(),
  capabilityIds: z.array(z.string().min(1)).min(1, '至少选择一个能力').optional(),
});

const CreateCapabilitySchema = z.object({
  name: CapabilityNameSchema,
  description: CapabilityDescriptionSchema,
  type: z.enum(['AGENT', 'RPA', 'SKILL', 'AI_APP'], {
    errorMap: () => ({ message: '类型必须是 AGENT、RPA、SKILL 或 AI_APP' })
  }),
  industry: z.array(z.string()).default([]),
  position: z.array(z.string()).default([]),
  inputSchema: z.any().optional(),
  outputSchema: z.any().optional(),
  agentConfig: z.object({
    platform: z.enum(['COZE', 'DIFY', 'N8N', 'OPENCODE']),
    region: z.string().optional(),
    runtimeKind: z.string().optional(),
    botId: z.string().optional(),
    workflowId: z.string().optional(),
    apiKey: z.string().optional(),
    workflowUrl: z.string().optional(),
    webUrl: z.string().optional(),
    skillName: z.string().optional(),
  }).optional(),
  // SKILL 类型必填字段
  zipPath: z.string().optional(), // 从 upload-skill 返回的路径
  sha256: z.string().optional(),
  fileCount: z.number().optional(),
  totalSize: z.number().optional(),
});

const UpdateCapabilitySchema = z.object({
  name: CapabilityNameSchema.optional(),
  description: CapabilityDescriptionSchema.optional(),
  type: z.enum(['AGENT', 'RPA', 'SKILL', 'AI_APP']).optional(),
  industry: z.array(z.string()).optional(),
  position: z.array(z.string()).optional(),
  inputSchema: z.any().optional(),
  outputSchema: z.any().optional(),
});

const ApproveCapabilitySchema = z.object({
  note: z.string().optional(),
});

const AdminDisableUserSchema = z.object({
  reason: z.string().min(1, '禁用原因不能为空').max(500, '禁用原因不能超过500字符'),
});

const RejectCapabilitySchema = z.object({
  reason: z.string().min(1, '拒绝原因不能为空').max(500, '原因不能超过500字符'),
});

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly adminAuthService: AdminAuthService,
    private readonly employeeCopyDraftService: EmployeeCopyDraftService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: '获取运营仪表盘统计数据' })
  @ApiResponse({
    status: 200,
    description: '返回 KPI、近 30 天趋势、Top 10 企业与员工排行',
  })
  getStats() {
    return this.adminService.getStats();
  }

  @Get('auth/users')
  @ApiOperation({ summary: '查询用户认证状态（平台管理员）' })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: UserStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  listAuthUsers(
    @Query('keyword') keyword?: string,
    @Query('status') status?: UserStatus,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const normalizedStatus = status && Object.values(UserStatus).includes(status) ? status : undefined;
    return this.adminAuthService.listUsers({
      keyword,
      status: normalizedStatus,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('auth/users/:id')
  @ApiOperation({ summary: '查看用户认证详情、第三方身份和有效会话' })
  getAuthUser(@Param('id') id: string) {
    return this.adminAuthService.getUserDetail(id);
  }

  @Get('auth/users/:id/events')
  @ApiOperation({ summary: '查看指定用户认证事件' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getAuthUserEvents(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.adminAuthService.listUserEvents(id, limit ? Number(limit) : undefined);
  }

  @Get('auth/metrics')
  @ApiOperation({ summary: '查看认证安全指标' })
  @ApiQuery({ name: 'hours', required: false, type: Number, description: '统计窗口，1-168小时，默认24小时' })
  getAuthMetrics(@Query('hours') hours?: string) {
    return this.adminAuthService.getSecurityMetrics(hours ? Number(hours) : 24);
  }

  @Patch('auth/users/:id/disable')
  @ApiOperation({ summary: '禁用用户账号并退出全部设备' })
  disableAuthUser(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AdminDisableUserSchema)) dto: z.infer<typeof AdminDisableUserSchema>,
    @Request() req: any,
  ) {
    return this.adminAuthService.disableUser(id, req.user.id, dto.reason);
  }

  @Patch('auth/users/:id/enable')
  @ApiOperation({ summary: '解禁用户账号' })
  enableAuthUser(@Param('id') id: string, @Request() req: any) {
    return this.adminAuthService.enableUser(id, req.user.id);
  }

  @Post('auth/users/:id/logout-all')
  @ApiOperation({ summary: '强制用户退出全部设备' })
  forceLogoutAuthUser(@Param('id') id: string, @Request() req: any) {
    return this.adminAuthService.revokeAllSessions(id, req.user.id);
  }

  @Post('auth/users/:id/require-email-verification')
  @ApiOperation({ summary: '强制用户重新验证邮箱' })
  forceEmailVerification(@Param('id') id: string, @Request() req: any) {
    return this.adminAuthService.forceEmailVerification(id, req.user.id);
  }

  @Post('auth/users/:id/force-password-reset')
  @ApiOperation({ summary: '强制用户重置密码并退出全部设备' })
  forcePasswordReset(@Param('id') id: string, @Request() req: any) {
    return this.adminAuthService.forcePasswordReset(id, req.user.id);
  }

  @Get('enterprises')
  @ApiOperation({ summary: '获取企业列表（运营端）' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '每页数量，默认20' })
  @ApiQuery({ name: 'keyword', required: false, type: String, description: '搜索关键词' })
  @ApiQuery({ name: 'suspended', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: '返回企业列表' })
  listEnterprises(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('suspended') suspended?: string,
  ) {
    return this.adminService.listEnterprises({
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      keyword,
      suspended: suspended === undefined ? undefined : suspended === 'true',
    });
  }

  @Get('enterprises/:id')
  @ApiOperation({ summary: '获取企业详情（运营端）' })
  @ApiResponse({ status: 200, description: '返回企业详情，包含成员、实例、交易记录' })
  @ApiResponse({ status: 404, description: '企业不存在' })
  getEnterpriseDetail(@Param('id') id: string) {
    return this.adminService.getEnterpriseDetail(id);
  }

  @Post('enterprises/:id/credit')
  @ApiOperation({ summary: '充值或扣减算力' })
  @ApiResponse({ status: 200, description: '操作成功，返回新余额' })
  @ApiResponse({ status: 400, description: '金额无效或余额不足' })
  @ApiResponse({ status: 404, description: '企业不存在' })
  creditAdjustment(
    @Param('id') enterpriseId: string,
    @Body(new ZodValidationPipe(CreditAdjustmentSchema)) dto: z.infer<typeof CreditAdjustmentSchema>,
    @Request() req: any,
  ) {
    return this.adminService.creditAdjustment({
      enterpriseId,
      amount: dto.amount,
      type: dto.type,
      note: dto.note,
      operatorId: req.user.id,
    });
  }

  @Post('enterprises/:enterpriseId/transactions/:transactionId/refund')
  @ApiOperation({ summary: '退还企业充值记录的未使用余额' })
  @ApiResponse({ status: 200, description: '退款成功，返回新余额和剩余可退款金额' })
  @ApiResponse({ status: 400, description: '金额无效、余额不足或记录不可退款' })
  @ApiResponse({ status: 404, description: '企业或充值记录不存在' })
  refundDeposit(
    @Param('enterpriseId') enterpriseId: string,
    @Param('transactionId') transactionId: string,
    @Body(new ZodValidationPipe(RefundDepositSchema)) dto: z.infer<typeof RefundDepositSchema>,
    @Request() req: any,
  ) {
    return this.adminService.refundDeposit({
      enterpriseId,
      depositTransactionId: transactionId,
      amount: dto.amount,
      reason: dto.reason,
      operatorId: req.user.id,
    });
  }

  @Post('enterprises/:id/suspend')
  @ApiOperation({ summary: '冻结企业' })
  @ApiResponse({ status: 200, description: '冻结成功' })
  @ApiResponse({ status: 400, description: '企业已被冻结' })
  @ApiResponse({ status: 404, description: '企业不存在' })
  suspendEnterprise(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SuspendSchema)) dto: z.infer<typeof SuspendSchema>,
    @Request() req: any,
  ) {
    return this.adminService.suspendEnterprise(id, dto.reason, req.user.id);
  }

  @Post('enterprises/:id/resume')
  @ApiOperation({ summary: '解冻企业' })
  @ApiResponse({ status: 200, description: '解冻成功' })
  @ApiResponse({ status: 400, description: '企业未被冻结' })
  @ApiResponse({ status: 404, description: '企业不存在' })
  resumeEnterprise(@Param('id') id: string, @Request() req: any) {
    return this.adminService.resumeEnterprise(id, req.user.id);
  }

  @Get('employees')
  @ApiOperation({ summary: '获取员工列表（运营端）' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'DRAFT', 'ARCHIVED'], description: '员工状态' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '每页数量，默认20' })
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'industry', required: false, type: String })
  @ApiQuery({ name: 'position', required: false, type: String })
  @ApiQuery({ name: 'capabilityKeyword', required: false, type: String })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'name', 'annualPriceCNY'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: '返回员工列表' })
  listEmployees(
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT' | 'ARCHIVED',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('industry') industry?: string,
    @Query('position') position?: string,
    @Query('capabilityKeyword') capabilityKeyword?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.adminService.listEmployees({
      status,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      keyword,
      industry,
      position,
      capabilityKeyword,
      sortBy: ['createdAt', 'name', 'annualPriceCNY'].includes(sortBy ?? '') ? sortBy as 'createdAt' | 'name' | 'annualPriceCNY' : undefined,
      sortOrder: sortOrder === 'asc' ? 'asc' : sortOrder === 'desc' ? 'desc' : undefined,
    });
  }

  @Post('employees/:id/approve')
  @ApiOperation({ summary: '审核通过员工模板' })
  @ApiResponse({ status: 200, description: '审核通过' })
  @ApiResponse({ status: 400, description: '只能审核待审核状态的员工' })
  @ApiResponse({ status: 404, description: '员工模板不存在' })
  approveEmployee(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApproveEmployeeSchema)) dto: z.infer<typeof ApproveEmployeeSchema>,
    @Request() req: any,
  ) {
    return this.adminService.approveEmployee(id, req.user.id, dto.note);
  }

  @Post('employees/:id/reject')
  @ApiOperation({ summary: '拒绝员工模板' })
  @ApiResponse({ status: 200, description: '拒绝成功' })
  @ApiResponse({ status: 400, description: '只能审核待审核状态的员工' })
  @ApiResponse({ status: 404, description: '员工模板不存在' })
  rejectEmployee(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectEmployeeSchema)) dto: z.infer<typeof RejectEmployeeSchema>,
    @Request() req: any,
  ) {
    return this.adminService.rejectEmployee(id, req.user.id, dto.reason);
  }

  @Get('compute/summary')
  @ApiOperation({
    summary: '平台资金合计',
    description:
      '累计充值 / 累计消费 / 当前总余额（元）。合计在服务端算，前端不再拉全量流水自行求和。',
  })
  @ApiResponse({ status: 200, description: '返回平台级资金合计' })
  getComputeSummary() {
    return this.adminService.getComputeSummary();
  }

  @Get('compute/transactions')
  @ApiOperation({ summary: '获取平台级算力交易记录' })
  @ApiQuery({ name: 'type', required: false, enum: ['RECHARGE', 'CONSUME', 'REFUND'], description: '交易类型' })
  @ApiQuery({ name: 'enterpriseId', required: false, type: String, description: '企业ID' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: '开始日期 (ISO 8601)' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: '结束日期 (ISO 8601)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '每页数量，默认20' })
  @ApiResponse({ status: 200, description: '返回交易记录列表' })
  getComputeTransactions(
    @Query('type') type?: 'RECHARGE' | 'CONSUME' | 'REFUND',
    @Query('enterpriseId') enterpriseId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.adminService.getComputeTransactions({
      type,
      enterpriseId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Post('employees')
  @ApiOperation({ summary: '创建员工（运营）' })
  @ApiResponse({ status: 201, description: '员工创建成功' })
  @ApiResponse({ status: 400, description: '输入参数无效' })
  createEmployee(
    @Body(new ZodValidationPipe(CreateEmployeeSchema)) dto: z.infer<typeof CreateEmployeeSchema>,
    @Request() req: any,
  ) {
    return this.adminService.createEmployee({
      name: dto.name,
      description: dto.description,
      industry: dto.industry,
      position: dto.position,
      avatar: dto.avatar,
      systemPrompt: dto.systemPrompt,
      modelId: dto.modelId,
      maxSteps: dto.maxSteps,
      price: dto.price,
      annualPriceCNY: dto.annualPriceCNY,
      includedComputeCNY: dto.includedComputeCNY,
      operatorId: req.user.id,
    });
  }

  @Post('employees/copy-draft')
  @Throttle({ chat: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: '根据员工信息生成简介或系统提示词草稿' })
  @ApiResponse({ status: 201, description: '返回可编辑文案及使用的平台模型来源' })
  @ApiResponse({ status: 400, description: '员工信息无效或超出输入限制' })
  @ApiResponse({ status: 502, description: '文案模型暂时不可用' })
  generateEmployeeCopyDraft(
    @Body(new ZodValidationPipe(EmployeeCopyDraftDtoSchema)) dto: EmployeeCopyDraftDto,
  ) {
    return this.employeeCopyDraftService.generate(dto);
  }

  @Get('employees/avatar-styles')
  @ApiOperation({ summary: '获取所有可用的头像风格列表' })
  @ApiResponse({ status: 200, description: '返回按来源分类的头像风格、授权信息与员工覆盖情况' })
  getAvatarStyles() {
    return this.adminService.getAvatarStyles();
  }

  @Get('employees/:id')
  @ApiOperation({ summary: '获取员工详情（运营端）' })
  @ApiResponse({ status: 200, description: '返回员工详情' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  getEmployeeDetail(@Param('id') id: string) {
    return this.adminService.getEmployeeDetail(id);
  }

  @Put('employees/:id')
  @ApiOperation({ summary: '更新员工' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  @ApiResponse({ status: 400, description: '输入参数无效' })
  updateEmployee(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEmployeeSchema)) dto: z.infer<typeof UpdateEmployeeSchema>,
    @Request() req: any,
  ) {
    // includedComputeCNY 的 null 语义（清除覆盖值 → 回落系统默认）由 service 层保留，
    // 不要在这里 `?? 0` —— 那会把「未配置」变成「明确不赠送」
    return this.adminService.updateEmployee(id, dto, req.user.id);
  }

  @Post('employees/:id/submit')
  @ApiOperation({ summary: '提交员工审核' })
  @ApiResponse({ status: 200, description: '提交成功' })
  @ApiResponse({ status: 400, description: '只能提交草稿状态的员工' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  submitEmployeeForReview(@Param('id') id: string, @Request() req: any) {
    return this.adminService.submitEmployeeForReview(id, req.user.id);
  }

  @Post('employees/:id/publish')
  @ApiOperation({ summary: '发布员工（运营直接上架，跳过审核）' })
  @ApiResponse({ status: 200, description: '发布成功' })
  @ApiResponse({ status: 400, description: '只能发布草稿状态的员工' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  publishEmployee(@Param('id') id: string, @Request() req: any) {
    return this.adminService.publishEmployee(id, req.user.id);
  }

  @Post('employees/:id/archive')
  @ApiOperation({ summary: '下架员工' })
  @ApiResponse({ status: 200, description: '下架成功' })
  @ApiResponse({ status: 400, description: '只能下架已发布的员工' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  archiveEmployee(@Param('id') id: string, @Request() req: any) {
    return this.adminService.archiveEmployee(id, req.user.id);
  }

  @Delete('employees/:id')
  @ApiOperation({ summary: '删除员工（仅草稿）' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 400, description: '只能删除草稿状态的员工' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  deleteEmployee(@Param('id') id: string) {
    return this.adminService.deleteEmployee(id);
  }

  @Get('employees/:id/bindings')
  @ApiOperation({ summary: '获取员工的能力绑定' })
  @ApiResponse({ status: 200, description: '返回能力绑定列表' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  getEmployeeBindings(@Param('id') id: string) {
    return this.adminService.getEmployeeBindings(id);
  }

  @Post('employees/:id/bindings')
  @ApiOperation({ summary: '批量绑定能力到员工' })
  @ApiResponse({ status: 200, description: '绑定成功' })
  @ApiResponse({ status: 400, description: '部分能力不存在' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  bindCapabilities(
    @Param('id') employeeId: string,
    @Body(new ZodValidationPipe(z.object({ capabilityIds: z.array(z.string()).min(1, '至少选择一个能力') })))
    dto: { capabilityIds: string[] },
    @Request() req: any,
  ) {
    return this.adminService.bindCapabilities(employeeId, dto.capabilityIds, req.user.id);
  }

  @Patch('bindings/:id')
  @ApiOperation({ summary: '更新绑定配置' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '绑定不存在' })
  updateBinding(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(z.object({
      priority: z.number().int().min(0).max(100).optional(),
      enabled: z.boolean().optional(),
      config: z.any().optional(),
    })))
    dto: { priority?: number; enabled?: boolean; config?: any },
  ) {
    return this.adminService.updateBinding(id, dto);
  }

  @Delete('bindings/:id')
  @ApiOperation({ summary: '删除绑定' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '绑定不存在' })
  removeBinding(@Param('id') id: string) {
    return this.adminService.removeBinding(id);
  }

  @Patch('employees/batch-update-avatar-style')
  @ApiOperation({ summary: '设置平台默认头像风格并更新员工' })
  @ApiResponse({ status: 200, description: '更新成功，返回更新数量' })
  @ApiResponse({ status: 400, description: '头像风格不存在' })
  batchUpdateAvatarStyle(
    @Body(new ZodValidationPipe(z.object({
      styleId: z.string().min(1, '风格ID不能为空'),
      applyToAll: z.boolean().optional(),
    })))
    dto: { styleId: string; applyToAll?: boolean },
    @Request() req: any,
  ) {
    return this.adminService.batchUpdateAvatarStyle(dto.styleId, req.user.id, dto.applyToAll === true);
  }

  @Patch('employees/:id/avatar-style')
  @ApiOperation({ summary: '更新单个员工的头像风格' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 400, description: '头像风格不存在' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  updateEmployeeAvatarStyle(
    @Param('id') employeeId: string,
    @Body(new ZodValidationPipe(z.object({ styleId: z.string().min(1, '风格ID不能为空') })))
    dto: { styleId: string },
    @Request() req: any,
  ) {
    return this.adminService.updateEmployeeAvatarStyle(employeeId, dto.styleId, req.user.id);
  }

  @Post('employees/avatar-styles')
  @ApiOperation({ summary: '注册平台头像风格元数据' })
  @ApiResponse({ status: 201, description: '风格已注册' })
  @ApiResponse({ status: 400, description: '无效或重复的风格标识' })
  registerAvatarStyle(
    @Body(new ZodValidationPipe(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
      name: z.string().min(1).max(100),
      description: z.string().min(1).max(1000),
      category: z.string().min(1).max(50),

      examples: z.array(z.string().min(1)).optional(),
      recommended: z.boolean().optional(),
      totalAssets: z.number().int().nonnegative().optional(),
    }))) dto: { id: string; name: string; description: string; category: string; examples?: string[]; recommended?: boolean; totalAssets?: number },
  ) {
    return this.adminService.registerAvatarStyle(dto);
  }

  @Post('employees/:id/avatar-bindings')
  @ApiOperation({ summary: '保存员工指定头像风格绑定' })
  @ApiResponse({ status: 201, description: '绑定已保存' })
  @ApiResponse({ status: 400, description: '无效素材或风格' })
  @ApiResponse({ status: 404, description: '员工不存在' })
  bindEmployeeAvatar(
    @Param('id') employeeId: string,
    @Body(new ZodValidationPipe(z.object({
      styleId: z.string().min(1),
      portraitUrl: z.string().min(1),
      faceUrl: z.string().min(1).optional(),
      version: z.string().max(100).optional(),
    }))) dto: { styleId: string; portraitUrl: string; faceUrl?: string; version?: string },
  ) {
    return this.adminService.bindEmployeeAvatar(employeeId, dto.styleId, dto);
  }

  @Get('capabilities')
  @ApiOperation({ summary: '获取能力列表（运营端）' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED'], description: '能力状态；PENDING 仅返回平台待审投稿和历史平台草稿' })
  @ApiQuery({ name: 'type', required: false, enum: ['AGENT', 'RPA', 'SKILL', 'AI_APP'], description: '能力类型' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认1' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: '每页数量，默认20' })
  @ApiQuery({ name: 'keyword', required: false, type: String, description: '按能力名称、描述或来源企业搜索' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'name', 'usageCount'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: '返回能力列表' })
  listCapabilitiesAdmin(
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED',
    @Query('type') type?: 'AGENT' | 'RPA' | 'SKILL' | 'AI_APP',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.adminService.listCapabilities({
      status,
      type,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      keyword,
      sortBy: ['createdAt', 'name', 'usageCount'].includes(sortBy ?? '') ? sortBy as 'createdAt' | 'name' | 'usageCount' : undefined,
      sortOrder: sortOrder === 'asc' ? 'asc' : sortOrder === 'desc' ? 'desc' : undefined,
    });
  }

  @Post('capabilities')
  @ApiOperation({ summary: '创建能力（运营）' })
  @ApiResponse({ status: 201, description: '能力创建成功' })
  @ApiResponse({ status: 400, description: '输入参数无效' })
  createCapabilityAdmin(
    @Body(new ZodValidationPipe(CreateCapabilitySchema)) dto: z.infer<typeof CreateCapabilitySchema>,
    @Request() req: any,
  ) {
    return this.adminService.createCapability({
      name: dto.name,
      description: dto.description,
      type: dto.type,
      industry: dto.industry,
      position: dto.position,
      inputSchema: dto.inputSchema || {},
      outputSchema: dto.outputSchema || {},
      agentConfig: dto.agentConfig as any,
      zipPath: dto.zipPath,
      sha256: dto.sha256,
      fileCount: dto.fileCount,
      totalSize: dto.totalSize,
      operatorId: req.user.id,
    });
  }

  @Get('capabilities/:id')
  @ApiOperation({ summary: '获取能力详情（运营端）' })
  @ApiResponse({ status: 200, description: '返回能力详情' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  getCapabilityDetailAdmin(@Param('id') id: string) {
    return this.adminService.getCapabilityDetail(id);
  }

  @Put('capabilities/:id')
  @ApiOperation({ summary: '更新能力' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  @ApiResponse({ status: 400, description: '输入参数无效' })
  updateCapabilityAdmin(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCapabilitySchema)) dto: z.infer<typeof UpdateCapabilitySchema>,
    @Request() req: any,
  ) {
    return this.adminService.updateCapability(id, dto, req.user.id);
  }

  @Post('capabilities/:id/submit')
  @ApiOperation({ summary: '提交能力审核' })
  @ApiResponse({ status: 200, description: '提交成功' })
  @ApiResponse({ status: 400, description: '已审核通过的能力无需重新提交' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  submitCapabilityForReview(@Param('id') id: string, @Request() req: any) {
    return this.adminService.submitCapabilityForReview(id, req.user.id);
  }

  @Post('capabilities/:id/approve')
  @ApiOperation({ summary: '审核通过能力' })
  @ApiResponse({ status: 200, description: '审核通过' })
  @ApiResponse({ status: 400, description: '只能审核待审核状态的能力' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  approveCapabilityAdmin(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ApproveCapabilitySchema)) dto: z.infer<typeof ApproveCapabilitySchema>,
    @Request() req: any,
  ) {
    return this.adminService.approveCapability(id, req.user.id, dto.note);
  }

  @Post('capabilities/:id/reject')
  @ApiOperation({ summary: '拒绝能力' })
  @ApiResponse({ status: 200, description: '拒绝成功' })
  @ApiResponse({ status: 400, description: '只能审核待审核状态的能力' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  rejectCapabilityAdmin(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RejectCapabilitySchema)) dto: z.infer<typeof RejectCapabilitySchema>,
    @Request() req: any,
  ) {
    return this.adminService.rejectCapability(id, req.user.id, dto.reason);
  }

  @Post('capabilities/:id/archive')
  @ApiOperation({ summary: '下架能力并停用员工绑定' })
  @ApiResponse({ status: 200, description: '下架成功；员工不再展示或调用该能力，员工本身不受影响' })
  @ApiResponse({ status: 400, description: '只能下架已发布的能力' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  archiveCapabilityAdmin(@Param('id') id: string) {
    return this.adminService.archiveCapability(id);
  }

  @Delete('capabilities/:id')
  @ApiOperation({ summary: '删除能力（待审核、已拒绝或已下架）' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 400, description: '已发布、仍被员工绑定或存在关联使用记录的能力不能删除' })
  @ApiResponse({ status: 404, description: '能力不存在' })
  deleteCapabilityAdmin(@Param('id') id: string) {
    return this.adminService.deleteCapability(id);
  }
}
