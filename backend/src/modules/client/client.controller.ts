import {
  Controller,
  Post,
  Get,
  Header,
  Body,
  HttpCode,
  HttpStatus,
  Request,
  Param,
  Patch,
  UseGuards,
  BadRequestException,
  Query,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { Request as ExpressRequest } from 'express';
import { ClientService } from './client.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  ClientLoginDto,
  ClientLoginDtoSchema,
  ClientRefreshDto,
  ClientRefreshDtoSchema,
  ClientTokenDto,
  ClientTokenDtoSchema,
  CreateClientTaskMirrorDto,
  CreateClientTaskMirrorDtoSchema,
  UpdateClientTaskMirrorStatusDto,
  UpdateClientTaskMirrorStatusDtoSchema,
  ClientTaskHeartbeatDto,
  ClientTaskHeartbeatDtoSchema,
  ClientTaskEventDto,
  ClientTaskEventDtoSchema,
  ClientTaskMirrorQueryDto,
  ClientTaskMirrorQueryDtoSchema,
  ClientPlatformEmployeeQuery,
  ClientPlatformEmployeeQuerySchema,
  ClientEmployeeAccessRequest,
  ClientEmployeeAccessRequestSchema,
  MediaRuntimeQuery,
  MediaRuntimeQuerySchema,
} from 'shared';

const mirrorResponseSchema: SchemaObject = {
  type: 'object',
  required: ['id', 'clientTaskId', 'clientRunId', 'userId', 'subscriptionId', 'title', 'status', 'progress', 'lastSequence', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' }, clientTaskId: { type: 'string' }, clientRunId: { type: 'string' },
    userId: { type: 'string' }, enterpriseId: { type: 'string', nullable: true },
    subscriptionId: { type: 'string' }, title: { type: 'string' }, taskType: { type: 'string' },
    modelId: { type: 'string', nullable: true }, status: { type: 'string' },
    progress: { type: 'integer' }, lastSequence: { type: 'integer' },
    currentStep: { type: 'string', nullable: true }, activity: { type: 'string', nullable: true },
    errorSummary: { type: 'string', nullable: true }, clientVersion: { type: 'string', nullable: true },
    protocolVersion: { type: 'integer' }, queuedAt: { type: 'string', format: 'date-time', nullable: true },
    lastHeartbeatAt: { type: 'string', format: 'date-time', nullable: true },
    startedAt: { type: 'string', format: 'date-time', nullable: true },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    stateEvidence: { type: 'object', nullable: true, properties: {
      version: { type: 'integer', enum: [1] }, reportedStatus: { type: 'string' },
      source: { type: 'string', enum: ['live', 'local-run', 'snapshot'] },
      observedAt: { type: 'string', format: 'date-time' },
      runEndedAt: { type: 'string', format: 'date-time' }, progress: { type: 'integer' },
    } },
    activityAt: { type: 'string', format: 'date-time', nullable: true },
    activityTimeSource: { type: 'string', enum: ['event', 'started', 'queued', 'received'] },
  },
};
const mirrorSummaryResponseSchema: SchemaObject = {
  ...mirrorResponseSchema,
  required: [...mirrorResponseSchema.required, 'user'],
  properties: {
    ...mirrorResponseSchema.properties,
    user: { type: 'object', required: ['id', 'name'], properties: {
      id: { type: 'string' }, name: { type: 'string', nullable: true },
    } },
    subscriptionSummary: { type: 'object', required: ['coverage', 'subscriptions', 'legacySubscriptionId'], properties: {
      coverage: { type: 'string', enum: ['proven', 'limited'] },
      legacySubscriptionId: { type: 'string', nullable: true },
      subscriptions: { type: 'array', items: { type: 'object', properties: {
        subscriptionId: { type: 'string' }, employeeId: { type: 'string' }, employeeName: { type: 'string' },
        subscriptionName: { type: 'string' }, executionCount: { type: 'integer' },
      } } },
    } },
  },
};
const taskRateLimitResponse = {
  status: 429, description: 'default 桶限流（100 次/分钟）；按 Retry-After 秒数重试',
  headers: { 'Retry-After': { description: '等待秒数', schema: { type: 'integer' as const } } },
};

@ApiTags('Client')
@Controller('client')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  /**
   * P4.1 客户端登录
   * 验证用户身份 + 注册/更新设备 → 返回 accessToken + refreshToken（在 body 中，非 cookie）
   */
  @Post('auth/login')
  @Throttle({ auth: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '客户端登录（桌面端专用）',
    description:
      '用邮箱 + 密码登录并注册设备指纹。' +
      '与 Web 登录不同，refresh token 直接返回 body 而非 httpOnly cookie，' +
      '供桌面应用安全存储。',
  })
  @ApiResponse({ status: 200, description: '登录成功，返回 accessToken + refreshToken' })
  @ApiResponse({ status: 400, description: '参数校验失败' })
  @ApiResponse({ status: 401, description: '邮箱或密码错误，或设备已被吊销' })
  async login(
    @Body(new ZodValidationPipe(ClientLoginDtoSchema)) dto: ClientLoginDto,
    @Request() req: ExpressRequest,
  ) {
    return this.clientService.login(dto, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
  }

  @Get('platform-employees')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询平台公开员工目录' })
  @ApiResponse({ status: 200, description: '返回已上架且可申请的平台员工能力摘要' })
  async listPlatformEmployees(
    @Query(new ZodValidationPipe(ClientPlatformEmployeeQuerySchema)) query: ClientPlatformEmployeeQuery,
  ) {
    return this.clientService.listPlatformEmployees(query);
  }

  @Post('employee-access-requests')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '提交员工授权/使用申请' })
  @ApiResponse({ status: 201, description: '申请提交成功' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 409, description: '幂等键冲突或存在未结束的重复申请' })
  async createEmployeeAccessRequest(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(ClientEmployeeAccessRequestSchema)) body: ClientEmployeeAccessRequest,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('缺少 Idempotency-Key 请求头');
    }
    return this.clientService.createEmployeeAccessRequest(req.user.id, body, idempotencyKey.trim());
  }

  @Get('employee-access-requests/:requestId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询当前用户的员工申请状态' })
  @ApiResponse({ status: 200, description: '申请状态' })
  @ApiResponse({ status: 404, description: '申请不存在或无权查看' })
  async getEmployeeAccessRequest(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('requestId') requestId: string,
  ) {
    return this.clientService.getEmployeeAccessRequest(req.user.id, requestId);
  }

  @Get('compute-balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '获取客户端当前用户的算力余额',
    description:
      '一次返回企业承担的本周期个人额度和用户个人钱包余额。' +
      '两部分账本口径不同，客户端应分别展示，不要直接把企业额度当作个人钱包余额。',
  })
  @ApiResponse({ status: 200, description: '企业额度与个人钱包余额' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async getComputeBalance(@Request() req: ExpressRequest & { user: { id: string } }) {
    return this.clientService.getComputeBalance(req.user.id);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '获取客户端当前用户与企业展示资料',
    description:
      '返回当前账号的头像和所属企业 Logo。图片字段是稳定的 API 路径；' +
      '无头像或无企业归属时返回 null。',
  })
  @ApiResponse({ status: 200, description: '当前用户与企业展示资料' })
  @ApiResponse({ status: 401, description: '未认证或 access token 已失效' })
  async getProfile(@Request() req: ExpressRequest & { user: { id: string } }) {
    return this.clientService.getProfile(req.user.id);
  }

  @Post('auth/refresh')
  @Throttle({ auth: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新客户端普通访问令牌' })
  @ApiResponse({ status: 200, description: '刷新成功' })
  @ApiResponse({ status: 401, description: 'refresh token 无效或设备已吊销' })
  async refreshAccessToken(
    @Body(new ZodValidationPipe(ClientRefreshDtoSchema)) dto: ClientRefreshDto,
  ) {
    return this.clientService.refreshAccessToken(dto);
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '退出当前桌面会话' })
  @ApiResponse({ status: 204, description: '已退出当前设备' })
  async logout(
    @Body(new ZodValidationPipe(ClientRefreshDtoSchema)) dto: ClientRefreshDto,
  ) {
    await this.clientService.logout(dto);
  }

  /**
   * P4.2 换取雇佣令牌
   * 验证 client-refresh token + 检查订阅授权 → 签发短期 client-employment JWT
   */
  @Post('auth/token')
  @Throttle({ auth: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取订阅 employment token',
    description:
      '用 refreshToken + subscriptionId 换取短期 client-employment JWT。' +
      '有效期由系统配置 CLIENT_TOKEN_TTL_MINUTES 控制（默认 15 分钟）。' +
      '员工包执行时用此令牌作为身份凭据。',
  })
  @ApiResponse({ status: 200, description: '订阅 employment token 签发成功' })
  @ApiResponse({ status: 400, description: '参数校验失败或实例不可用' })
  @ApiResponse({ status: 401, description: 'refresh token 无效或设备已被吊销' })
  @ApiResponse({ status: 404, description: '订阅不存在或当前不可用' })
  async refreshInstanceToken(
    @Body(new ZodValidationPipe(ClientTokenDtoSchema)) dto: ClientTokenDto,
  ) {
    return this.clientService.refreshInstanceToken(dto);
  }

  /**
   * P4.4 客户端订阅清单
   * 只列出当前成员有有效 EmployeeGrant 的 ACTIVE 订阅。
   */
  @Get('subscriptions')
  @Get('instances')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '获取可用实例列表',
    description:
      '返回当前成员有直接或部门授权的 ACTIVE 订阅。' +
      'template.avatar 为完整主图 URL；template.avatarAsset 提供统一人物 ID、素材版本、portraitUrl 和 faceUrl。' +
      'instances 路径仅为迁移兼容，客户端应使用 subscriptions。',
  })
  @ApiResponse({ status: 200, description: '实例列表' })
  @ApiResponse({ status: 401, description: '未认证' })
  async listSubscriptions(@Request() req: ExpressRequest & { user: { id: string } }) {
    return this.clientService.listSubscriptions(req.user.id);
  }

  @Get('subscriptions/:subscriptionId/runtime')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取员工运行清单与企业已授权多媒体配置' })
  @ApiQuery({ name: 'mediaProtocolVersion', required: false, enum: [3], description: '省略默认 3；仅返回包含模型、参数和参考图规则的 V3 图片配置' })
  @ApiQuery({ name: 'skillArtifactProtocolVersion', required: false, type: Number, description: '传 1 协商批准 Skill 安装产物；与媒体协议独立' })
  @ApiQuery({ name: 'videoProtocolVersion', required: false, enum: [3], description: '省略默认 3；仅返回包含模型、参数和参考图规则的 V3 视频配置' })
  @ApiResponse({ status: 200, description: '员工配置与已审核技能正文；employee.avatarAsset 与订阅清单同源，图片版本独立于 templateVersion' })
  @ApiResponse({ status: 400, description: '媒体协议协商参数无效' })
  @ApiResponse({ status: 401, description: '认证失败或企业被冻结，保留来源错误详情' })
  @ApiResponse({ status: 403, description: '当前用户无有效企业身份' })
  @ApiResponse({ status: 404, description: '订阅不存在或当前不可用' })
  @ApiResponse({ status: 429, description: '请求被限流，保留来源等待信息与 Retry-After' })
  @ApiResponse({ status: 500, description: '运行配置或服务异常，保留来源诊断信息' })
  @ApiResponse({ status: 503, description: '运行配置暂不可读取，保留来源错误详情' })
  async getRuntime(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('subscriptionId') subscriptionId: string,
    @Query(new ZodValidationPipe(MediaRuntimeQuerySchema)) query: MediaRuntimeQuery,
  ) {
    return this.clientService.getRuntime(req.user.id, subscriptionId, query.mediaProtocolVersion, query.skillArtifactProtocolVersion, query.videoProtocolVersion);
  }

  @Post('tasks')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '幂等创建客户端任务云端镜像', description: 'protocolVersion 可选，仅支持 2；queuedAt 为 ISO 时间。v2 首次准入验证订阅并保存不可变快照；已验证 run 重放不重新准入、不切回历史 run、不重置状态。旧协议保留授权验证；禁止跨企业复用任务 ID。' })
  @ApiResponse({ status: 201, description: '创建或更新后的镜像（相同任务保持 id）', schema: mirrorResponseSchema })
  @ApiResponse({ status: 400, description: 'Body 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业、无有效订阅授权或跨企业复用任务 ID' })
  @ApiResponse({ status: 409, description: '并发同步冲突，请重试' })
  @ApiResponse(taskRateLimitResponse)
  async createTaskMirror(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Body(new ZodValidationPipe(CreateClientTaskMirrorDtoSchema)) body: CreateClientTaskMirrorDto,
  ) {
    return this.clientService.createTaskMirror(req.user.id, body);
  }

  @Patch('tasks/:id/status')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新本人客户端任务状态', description: 'clientRunId 可选；省略时更新当前 run。已验证 v2 历史 run 可更新自身状态但不影响当前镜像；旧协议历史 run 返回 409。同一 run 的终态不可改变，重跑需新 clientRunId；终态重试不能清除 completedAt，非终态不能指定完成时间。' })
  @ApiResponse({ status: 200, description: '更新后的镜像', schema: mirrorResponseSchema })
  @ApiResponse({ status: 400, description: 'Body 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业权限' })
  @ApiResponse({ status: 404, description: '本企业本人任务不存在' })
  @ApiResponse({ status: 409, description: '陈旧 run、终态转换或并发同步冲突' })
  @ApiResponse(taskRateLimitResponse)
  async updateTaskMirror(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateClientTaskMirrorStatusDtoSchema)) body: UpdateClientTaskMirrorStatusDto,
  ) {
    return this.clientService.updateTaskMirror(req.user.id, id, body);
  }

  @Post('tasks/:id/heartbeat')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '上报本人客户端任务心跳', description: 'clientRunId 可选；显式非当前 run 返回 409，不更新镜像。' })
  @ApiResponse({ status: 201, description: '更新后的镜像', schema: mirrorResponseSchema })
  @ApiResponse({ status: 400, description: 'Body 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业权限' })
  @ApiResponse({ status: 404, description: '本企业本人任务不存在' })
  @ApiResponse({ status: 409, description: '并发同步冲突，请重试' })
  @ApiResponse(taskRateLimitResponse)
  async heartbeatTaskMirror(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ClientTaskHeartbeatDtoSchema)) body: ClientTaskHeartbeatDto,
  ) {
    return this.clientService.heartbeatTaskMirror(req.user.id, id, body);
  }

  @Post('tasks/:id/events')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '幂等上报本人客户端任务事件', description: '按 mirrorId/clientRunId/sequence 去重，一致重放返回 duplicate:true，载荷冲突返回 409。迟到事件保存但不回退进度。v2 事件可含 participation={executionId,subscriptionId,nodeId?,title?,modelId?,status?,startedAt?,completedAt?}；首次准入验证授权并冻结归属，后续复用快照。节点内容片段使用相同归属，聚合内容不传 participation。message 每片最多 1000 字符，保留空白；stepKey=content:v1:<messageId>:<index>:<total>。' })
  @ApiResponse({ status: 201, description: '镜像；已确认的 sequence 返回 duplicate:true', schema: {
    ...mirrorResponseSchema, properties: { ...mirrorResponseSchema.properties, duplicate: { type: 'boolean' } },
  } })
  @ApiResponse({ status: 400, description: 'Body 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业权限' })
  @ApiResponse({ status: 404, description: '本企业本人任务不存在' })
  @ApiResponse({ status: 409, description: '并发同步冲突，请重试' })
  @ApiResponse(taskRateLimitResponse)
  async eventTaskMirror(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ClientTaskEventDtoSchema)) body: ClientTaskEventDto,
  ) {
    return this.clientService.eventTaskMirror(req.user.id, id, body);
  }

  @Get('tasks')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询有权查看的客户端任务镜像', description: '管理员默认本企业全员；普通成员/部门负责人默认本人。无 page/limit 返回最多 100 条数组，否则分页对象。默认 queuedAt_desc，id 同向稳定排序，空时间排最后。subscriptionSummary 仅含验证过的参与归属，旧数据标为 limited。' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '正整数；分页时默认 1' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1–100；分页时默认 50' })
  @ApiQuery({ name: 'scope', required: false, enum: ['mine', 'enterprise'], description: 'mine 强制本人；enterprise 仅企业管理员；省略沿用角色范围' })
  @ApiQuery({ name: 'subscriptionId', required: false, type: String })
  @ApiQuery({ name: 'userId', required: false, type: String, description: '普通成员只能指定本人' })
  @ApiQuery({ name: 'statuses', required: false, type: String, description: '监控状态枚举，逗号分隔' })
  @ApiQuery({ name: 'view', required: false, enum: ['active', 'attention', 'history'] })
  @ApiQuery({ name: 'taskType', required: false, type: String })
  @ApiQuery({ name: 'from', required: false, type: String, description: '包含边界；ISO 带时区或 YYYY-MM-DD（UTC+8 零点）' })
  @ApiQuery({ name: 'to', required: false, type: String, description: '不包含边界；业务执行/排队时间，不使用心跳时间' })
  @ApiQuery({ name: 'q', required: false, type: String, description: '标题，不区分大小写' })
  @ApiQuery({ name: 'scopeSubscriptionId', required: false, type: String, description: '员工入口的固定订阅范围，与可变筛选取交集' })
  @ApiQuery({ name: 'sort', required: false, enum: ['activityAt_desc', 'queuedAt_desc', 'queuedAt_asc', 'startedAt_desc', 'startedAt_asc', 'updatedAt_desc', 'updatedAt_asc'] })
  @ApiResponse({ status: 200, description: '兼容数组或分页对象，user 仅含 id/name', schema: { oneOf: [
    { type: 'array', items: mirrorSummaryResponseSchema },
    { type: 'object', required: ['items', 'total', 'page', 'limit', 'hasNextPage'], properties: {
      items: { type: 'array', items: mirrorSummaryResponseSchema },
      total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, hasNextPage: { type: 'boolean' },
    } },
  ] } })
  @ApiResponse({ status: 400, description: 'Query 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业或非管理员指定 enterprise scope' })
  @ApiResponse(taskRateLimitResponse)
  async listTaskMirrors(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Query(new ZodValidationPipe(ClientTaskMirrorQueryDtoSchema)) query: ClientTaskMirrorQueryDto,
  ) {
    return this.clientService.listTaskMirrors(req.user.id, query);
  }

  @Get('tasks/filter-options')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询客户端监控筛选项与计数', description: '与列表同权限；各候选忽略自身可变筛选，保留固定 scopeSubscriptionId。计数忽略 view/statuses/page/limit/sort；attention 包含审批、暂停、中断和失败。订阅包括已验证参与快照及标记 legacy 的 v1 根订阅。' })
  @ApiResponse({ status: 200, description: '{users:[{id,name}],subscriptions:[{subscriptionId,employeeId,employeeName,subscriptionName}],taskTypes:string[],scopeTotal:number,counts:{active,attention,history,byStatus}}' })
  @ApiResponse({ status: 400, description: 'Query 校验失败' })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业或超出本人范围' })
  @ApiResponse(taskRateLimitResponse)
  async getTaskMirrorFilterOptions(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Query(new ZodValidationPipe(ClientTaskMirrorQueryDtoSchema)) query: ClientTaskMirrorQueryDto,
  ) {
    return this.clientService.getTaskMirrorFilterOptions(req.user.id, query);
  }

  @Get('tasks/:id')
  @SkipThrottle({ auth: true, chat: true })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询客户端任务镜像详情', description: '与列表角色范围一致；返回镜像、user、完整 events 和 runs；每个 run 包含 participations，每个 participation 包含 events。旧事件保留顶层但不推断员工归属。' })
  @ApiResponse({ status: 200, description: '{...mirror,user:{id,name},events}', schema: {
    ...mirrorResponseSchema, required: [...mirrorResponseSchema.required, 'user', 'events', 'runs'],
    properties: { ...mirrorResponseSchema.properties, user: mirrorSummaryResponseSchema.properties.user,
      runs: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, clientRunId: { type: 'string' }, subscriptionId: { type: 'string' },
        employeeId: { type: 'string' }, employeeName: { type: 'string' }, subscriptionName: { type: 'string' },
        participations: { type: 'array', items: { type: 'object', properties: {
          executionId: { type: 'string' }, events: { type: 'array', items: { type: 'object' } },
        } } },
      } } }, events: { type: 'array', items: {
      type: 'object', properties: {
        id: { type: 'string' }, mirrorId: { type: 'string' }, clientRunId: { type: 'string' },
        sequence: { type: 'integer' }, type: { type: 'string' },
        stepKey: { type: 'string', nullable: true }, message: { type: 'string', nullable: true },
        progress: { type: 'integer', nullable: true }, occurredAt: { type: 'string', format: 'date-time', nullable: true },
        participationId: { type: 'string', nullable: true }, participationMetadata: { type: 'object', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    } } },
  } })
  @ApiResponse({ status: 401, description: '未认证' })
  @ApiResponse({ status: 403, description: '无企业权限' })
  @ApiResponse({ status: 404, description: '不存在或不在可见范围的任务' })
  @ApiResponse(taskRateLimitResponse)
  async getTaskMirror(@Request() req: ExpressRequest & { user: { id: string } }, @Param('id') id: string) {
    return this.clientService.getTaskMirror(req.user.id, id);
  }
}
