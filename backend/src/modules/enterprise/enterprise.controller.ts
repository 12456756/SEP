import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  AssignDeptMembersDto,
  AssignDeptMembersDtoSchema,
  DepartmentCreateDto,
  DepartmentCreateDtoSchema,
  DepartmentUpdateDto,
  DepartmentUpdateDtoSchema,
  MemberCreateDto,
  MemberCreateDtoSchema,
  MemberUpdateDto,
  MemberUpdateDtoSchema,
  InvitationCreateDto,
  InvitationCreateDtoSchema,
  InvitationStatusValue,
  SetDeptLeaderDto,
  SetDeptLeaderDtoSchema,
  GrantCreateDto,
  GrantCreateDtoSchema,
  GrantBatchCreateDto,
  GrantBatchCreateDtoSchema,
  MemberGrantBatchCreateDto,
  MemberGrantBatchCreateDtoSchema,
  MemberGrantCandidateQuery,
  MemberGrantCandidateQuerySchema,
} from "shared";
import { EnterpriseService } from "./enterprise.service";
import { DepartmentService } from "./department.service";
import { MemberService } from "./member.service";
import { KnowledgeGrantCandidateQuerySchema } from 'shared';
import { BadRequestException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InvitationService } from "./invitation.service";
import { GrantService } from "./grant.service";
import { EnterpriseContextService } from "./enterprise-context.service";

type AuthedRequest = { user: { id: string } };

@ApiTags("Enterprise Organization")
@Controller("enterprise")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class EnterpriseController {
  constructor(
    private readonly enterprise: EnterpriseService,
    private readonly departments: DepartmentService,
    private readonly members: MemberService,
    private readonly invitations: InvitationService,
    private readonly grants: GrantService,
    private readonly enterpriseCtx: EnterpriseContextService,
  ) {}

  // ── 部门 ──────────────────────────────────────────────────────────────────

  @Get("departments")
  @ApiOperation({ summary: "本企业部门树（含各部门成员数）" })
  @ApiResponse({ status: 200, description: "树形结构，children 嵌套" })
  @ApiResponse({ status: 403, description: "调用者不属于任何企业" })
  async departmentTree(@Request() req: AuthedRequest) {
    return this.departments.tree(req.user.id);
  }

  @Post("departments")
  @ApiOperation({ summary: "创建部门（仅企业管理员）" })
  @ApiResponse({ status: 201, description: "已创建" })
  @ApiResponse({ status: 403, description: "非企业管理员" })
  @ApiResponse({ status: 404, description: "父部门不存在或不属于本企业" })
  async createDepartment(
    @Request() req: AuthedRequest,
    @Body(new ZodValidationPipe(DepartmentCreateDtoSchema))
    dto: DepartmentCreateDto,
  ) {
    return this.departments.create(req.user.id, dto);
  }

  @Patch("departments/:id")
  @ApiOperation({ summary: "重命名 / 移动部门（仅企业管理员）" })
  @ApiResponse({ status: 200, description: "已更新" })
  @ApiResponse({ status: 400, description: "移动会形成环" })
  @ApiResponse({ status: 404, description: "部门不存在或不属于本企业" })
  async updateDepartment(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DepartmentUpdateDtoSchema))
    dto: DepartmentUpdateDto,
  ) {
    return this.departments.update(req.user.id, id, dto);
  }

  @Delete("departments/:id")
  @ApiOperation({
    summary: "删除部门（仅企业管理员）",
    description: "有子部门或成员时拒绝，需先清空 —— 不做级联删除。",
  })
  @ApiResponse({ status: 200, description: "已删除" })
  @ApiResponse({ status: 409, description: "仍有子部门或成员" })
  async removeDepartment(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
  ) {
    return this.departments.remove(req.user.id, id);
  }

  // ── 部门成员管理 ───────────────────────────────────────────────────────────

  @Get("departments/:id/members")
  @ApiOperation({ summary: "列出部门成员（支持搜索/分页）" })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiResponse({ status: 200, description: "成员列表 + 当前 leaderId" })
  async listDeptMembers(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.departments.listMembers(req.user.id, id, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post("departments/:id/members")
  @ApiOperation({ summary: "批量将成员分配到部门（管理员或部门主管）" })
  @ApiResponse({ status: 201, description: "已分配" })
  @ApiResponse({ status: 400, description: "部分 memberIds 无效" })
  @ApiResponse({ status: 403, description: "权限不足" })
  async assignDeptMembers(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AssignDeptMembersDtoSchema))
    dto: AssignDeptMembersDto,
  ) {
    return this.departments.assignMembers(req.user.id, id, dto);
  }

  @Delete("departments/:id/members/:memberId")
  @ApiOperation({ summary: "将成员从部门移除（管理员或部门主管）" })
  @ApiResponse({ status: 200, description: "已移除" })
  @ApiResponse({ status: 400, description: "成员不在此部门" })
  async removeDeptMember(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Param("memberId") memberId: string,
  ) {
    return this.departments.removeMember(req.user.id, id, memberId);
  }

  @Put("departments/:id/leader")
  @ApiOperation({ summary: "设置/清除部门主管（仅企业管理员）" })
  @ApiResponse({ status: 200, description: "已更新" })
  @ApiResponse({ status: 400, description: "新主管不在此部门或其子部门中" })
  async setDeptLeader(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDeptLeaderDtoSchema)) dto: SetDeptLeaderDto,
  ) {
    return this.departments.setLeader(req.user.id, id, dto);
  }

  // ── 成员 ──────────────────────────────────────────────────────────────────

  @Get("members")
  @ApiOperation({ summary: "本企业成员列表" })
  @ApiQuery({ name: "departmentId", required: false })
  @ApiQuery({ name: "search", required: false, description: "按姓名、邮箱或职位搜索" })
  @ApiQuery({ name: "role", required: false, enum: ['ENTERPRISE_ADMIN', 'DEPT_MANAGER', 'MEMBER'] })
  @ApiQuery({ name: "page", required: false, type: Number, description: "页码，默认1" })
  @ApiQuery({ name: "pageSize", required: false, type: Number, description: "每页数量，默认20，最大100" })
  @ApiResponse({ status: 200, description: "成员分页列表" })
  async listMembers(
    @Request() req: AuthedRequest,
    @Query("departmentId") departmentId?: string,
    @Query() query?: Record<string, unknown>,
    @Res({ passthrough: true }) response?: Response,
  ) {
    if (query?.view !== undefined) {
      if (query.view !== 'knowledge-grant') throw new BadRequestException('未知成员视图');
      response?.setHeader('Cache-Control', 'no-store');
      const parsed = new ZodValidationPipe(KnowledgeGrantCandidateQuerySchema).transform(query);
      return this.members.listKnowledgeGrantCandidates(req.user.id, parsed);
    }
    const hasPagination = query?.page !== undefined || query?.pageSize !== undefined || query?.search !== undefined || query?.role !== undefined;
    const role = query?.role;
    if (role !== undefined && !['ENTERPRISE_ADMIN', 'DEPT_MANAGER', 'MEMBER'].includes(String(role))) {
      throw new BadRequestException('无效成员角色');
    }
    return this.members.list(req.user.id, departmentId, hasPagination ? {
      page: Number(query?.page),
      pageSize: Number(query?.pageSize),
      search: typeof query?.search === 'string' ? query.search : undefined,
      role: role as 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER' | undefined,
    } : undefined);
  }

  @Post("members")
  @ApiOperation({
    summary: "创建成员邀请（仅企业管理员）",
    description: "兼容旧前端路径，但不再由管理员代设密码；服务端只创建邀请并发送设置密码邮件。",
  })
  @ApiResponse({ status: 201, description: "邀请已创建，响应含一次性 token" })
  @ApiResponse({ status: 409, description: "邮箱已是本企业成员" })
  async createMember(
    @Request() req: AuthedRequest,
    @Body(new ZodValidationPipe(MemberCreateDtoSchema)) dto: MemberCreateDto,
  ) {
    return this.invitations.create(req.user.id, {
      email: dto.email,
      role: dto.role,
      departmentId: dto.departmentId,
      position: dto.position,
    });
  }

  @Patch("members/:id")
  @ApiOperation({ summary: "改角色 / 调岗（仅企业管理员）" })
  @ApiResponse({ status: 200, description: "已更新" })
  @ApiResponse({ status: 400, description: "不能降低自己的角色" })
  @ApiResponse({ status: 409, description: "企业需保留至少一名管理员" })
  async updateMember(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(MemberUpdateDtoSchema)) dto: MemberUpdateDto,
  ) {
    return this.members.update(req.user.id, id, dto);
  }

  @Delete("members/:id")
  @ApiOperation({
    summary: "移出企业（仅企业管理员）",
    description: [
      "**回收**：本人名下的 EmployeeGrant 席位、待审批的越权申请（置为 CANCELED）、",
      "其所主管部门的 leader 归属。",
      "",
      "**保留**：已审批的申请及审批结论（申请人身份转为快照字段）、知识库、",
      "文档、会话与工作记录 —— 员工离职，企业侧沉淀不动。",
      "",
      "**User 账号保留**，该用户变为「无企业归属」，可凭原账号接受新邀请。",
      "",
      "响应中 `vacatedDepartments` 非空时，这些部门已无主管，需管理员重新指派。",
    ].join("\n"),
  })
  @ApiResponse({
    status: 200,
    description: "已移出，返回回收数量与待重新指派的部门",
  })
  @ApiResponse({ status: 400, description: "不能移除自己" })
  @ApiResponse({ status: 409, description: "企业需保留至少一名管理员" })
  async removeMember(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.members.remove(req.user.id, id);
  }

  // ── 企业邀请 ──────────────────────────────────────────────────────────────

  @Get("invitations")
  @ApiOperation({
    summary: "本企业邀请列表（仅企业管理员）",
    description: "顺带把已过期的 PENDING 收敛为 EXPIRED。不返回 token。",
  })
  @ApiQuery({ name: "status", required: false, enum: ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'] })
  @ApiQuery({ name: "search", required: false, description: "按邮箱或职位搜索" })
  @ApiQuery({ name: "role", required: false, enum: ['ENTERPRISE_ADMIN', 'DEPT_MANAGER', 'MEMBER'] })
  @ApiQuery({ name: "departmentId", required: false })
  @ApiQuery({ name: "page", required: false, type: Number, description: "页码，默认1" })
  @ApiQuery({ name: "pageSize", required: false, type: Number, description: "每页数量，默认20，最大100" })
  @ApiResponse({ status: 200, description: "邀请分页列表" })
  async listInvitations(
    @Request() req: AuthedRequest,
    @Query("status") status?: InvitationStatusValue,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("search") search?: string,
    @Query("role") role?: string,
    @Query("departmentId") departmentId?: string,
  ) {
    const hasPagination = page !== undefined || pageSize !== undefined || search !== undefined || role !== undefined || departmentId !== undefined;
    if (role !== undefined && !['ENTERPRISE_ADMIN', 'DEPT_MANAGER', 'MEMBER'].includes(role)) {
      throw new BadRequestException('无效邀请角色');
    }
    return this.invitations.list(req.user.id, status, hasPagination ? {
      page: Number(page),
      pageSize: Number(pageSize),
      search,
      role: role as 'ENTERPRISE_ADMIN' | 'DEPT_MANAGER' | 'MEMBER' | undefined,
      departmentId,
    } : undefined);
  }

  @Post("invitations")
  @ApiOperation({
    summary: "创建邀请（仅企业管理员）",
    description:
      "尝试向受邀邮箱发送邀请邮件；响应返回一次性明文 token、服务端邀请链接和邮件发送状态。" +
      "邮件发送失败不回滚邀请，管理员仍可复制链接备用。",
  })
  @ApiResponse({ status: 201, description: "已创建，响应含邮件状态和一次性邀请链接" })
  @ApiResponse({ status: 409, description: "该邮箱已是本企业成员" })
  async createInvitation(
    @Request() req: AuthedRequest,
    @Body(new ZodValidationPipe(InvitationCreateDtoSchema))
    dto: InvitationCreateDto,
  ) {
    return this.invitations.create(req.user.id, dto);
  }

  @Post("invitations/:id/resend")
  @ApiOperation({
    summary: "重新发送邀请邮件（仅企业管理员）",
    description: "轮换邀请 token 并将有效期重置为 7 天；旧链接立即失效。",
  })
  @ApiResponse({ status: 201, description: "已重发或返回明确的邮件发送状态" })
  @ApiResponse({ status: 404, description: "邀请不存在或不属于当前企业" })
  @ApiResponse({ status: 409, description: "邀请已接受、状态冲突或处于发送冷却期" })
  async resendInvitation(@Request() req: AuthedRequest, @Param("id") id: string) {
    return this.invitations.resend(req.user.id, id);
  }

  @Delete("invitations/:id")
  @ApiOperation({
    summary: "撤回邀请（仅企业管理员）",
    description: "撤回后链接立即失效。已接受的邀请不可撤回，应走移出企业。",
  })
  @ApiResponse({ status: 200, description: "已撤回" })
  @ApiResponse({ status: 409, description: "邀请已被接受或已失效" })
  async revokeInvitation(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
  ) {
    return this.invitations.revoke(req.user.id, id);
  }

  // ── 员工授权 ──────────────────────────────────────────────────────────────

  @Get("members/:memberId/employee-grants")
  @ApiOperation({ summary: "查询成员可授权的硅基员工（仅企业管理员）" })
  @ApiQuery({ name: "keyword", required: false })
  @ApiQuery({ name: "status", required: false, enum: ["all", "grantable", "granted", "history"] })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiResponse({ status: 200, description: "硅基员工授权候选列表" })
  @ApiResponse({ status: 403, description: "仅企业管理员可查看" })
  @ApiResponse({ status: 404, description: "成员不存在或不属于本企业" })
  async listMemberEmployeeGrants(
    @Request() req: AuthedRequest,
    @Param("memberId") memberId: string,
    @Query(new ZodValidationPipe(MemberGrantCandidateQuerySchema))
    query: MemberGrantCandidateQuery,
  ) {
    return this.grants.listForMember(req.user.id, memberId, query);
  }

  @Post("members/:memberId/employee-grants/batch")
  @HttpCode(200)
  @ApiOperation({ summary: "批量给成员授权硅基员工（仅企业管理员）" })
  @ApiResponse({ status: 200, description: "返回新增、续期和跳过的授权结果" })
  @ApiResponse({ status: 400, description: "雇佣关系无效或请求参数错误" })
  @ApiResponse({ status: 403, description: "仅企业管理员可操作" })
  @ApiResponse({ status: 404, description: "成员或雇佣关系不存在" })
  async createMemberEmployeeGrants(
    @Request() req: AuthedRequest,
    @Param("memberId") memberId: string,
    @Body(new ZodValidationPipe(MemberGrantBatchCreateDtoSchema))
    dto: MemberGrantBatchCreateDto,
  ) {
    return this.grants.createBatchForMember(req.user.id, memberId, dto);
  }

  @Get("my-employees")
  @ApiOperation({
    summary: "我可以使用的员工（使用者视角）",
    description:
      "合并直接授权给我 + 授权给我所在部门的雇佣关系，非 ACTIVE 或已过期的不返回。" +
      "同一雇佣关系两条路径都命中时只返回一条，直接授权优先。",
  })
  @ApiResponse({ status: 200, description: "可用员工列表" })
  async myEmployees(@Request() req: AuthedRequest) {
    return this.grants.myEmployees(req.user.id);
  }

  @Get("employee-status")
  @ApiOperation({ summary: "本企业员工实时状态" })
  async employeeStatus(@Request() req: AuthedRequest) {
    return this.enterprise.getEmployeeStatuses(req.user.id);
  }

  @Get("subscriptions/:id/grants")
  @ApiOperation({ summary: "某雇佣关系的授权列表（管理员视角）" })
  @ApiResponse({ status: 200, description: "授权列表，expired=true 的已标灰" })
  @ApiResponse({ status: 404, description: "雇佣关系不存在或不属于本企业" })
  async listGrants(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
  ) {
    return this.grants.listForSubscription(req.user.id, id);
  }

  @Post("subscriptions/:id/grants")
  @ApiOperation({
    summary: "开通授权（仅企业管理员）",
    description: "授权对象二选一：departmentId 或 memberId，不能同时填或都不填。",
  })
  @ApiResponse({ status: 201, description: "已开通" })
  @ApiResponse({ status: 400, description: "雇佣关系已失效 / 授权对象不在本企业" })
  @ApiResponse({ status: 409, description: "该授权已存在" })
  async createGrant(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(GrantCreateDtoSchema)) dto: GrantCreateDto,
  ) {
    return this.grants.create(req.user.id, id, dto);
  }

  @Post("subscriptions/:id/grants/batch")
  @HttpCode(200)
  @ApiOperation({
    summary: "批量开通雇佣授权（仅企业管理员）",
    description: "一次为单个雇佣关系授权给多个本企业成员或部门；每批最多 100 个，整批校验后事务写入。",
  })
  @ApiResponse({ status: 200, description: "返回新建、重新开通及跳过的目标 ID" })
  @ApiResponse({ status: 400, description: "雇佣关系无效、目标不属于本企业或请求无效" })
  @ApiResponse({ status: 403, description: "仅企业管理员可批量授权" })
  @ApiResponse({ status: 404, description: "雇佣关系不存在或不属于本企业" })
  async createGrantBatch(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(GrantBatchCreateDtoSchema)) dto: GrantBatchCreateDto,
  ) {
    return this.grants.createBatch(req.user.id, id, dto);
  }

  @Delete("grants/:id")
  @ApiOperation({
    summary: "收回授权（仅企业管理员）",
    description: "只删除该授权记录，不影响雇佣关系状态。",
  })
  @ApiResponse({ status: 200, description: "已收回" })
  @ApiResponse({ status: 404, description: "授权记录不存在或不属于本企业" })
  async removeGrant(
    @Request() req: AuthedRequest,
    @Param("id") id: string,
  ) {
    return this.grants.remove(req.user.id, id);
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  @Get("info")
  @ApiOperation({ summary: "获取当前企业详细信息" })
  @ApiResponse({
    status: 200,
    description: "企业基本信息 + 统计数据",
  })
  async getEnterpriseInfo(@Request() req: AuthedRequest) {
    return this.enterprise.getEnterpriseInfo(req.user.id);
  }

  @Get("dashboard-stats")
  @ApiOperation({ summary: "获取 Dashboard 统计数据" })
  @ApiResponse({
    status: 200,
    description: "关键指标、消费趋势、热门员工、最近活动",
  })
  async getDashboardStats(@Request() req: AuthedRequest) {
    return this.enterprise.getDashboardStats(req.user.id);
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  @Post("onboarding/complete")
  @ApiOperation({ summary: "标记新手引导已完成" })
  @ApiResponse({
    status: 200,
    description: "已标记完成",
  })
  async markOnboardingCompleted(@Request() req: AuthedRequest) {
    return this.enterprise.markOnboardingCompleted(req.user.id);
  }
}
