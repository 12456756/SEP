import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { EnterpriseContextService } from "../enterprise/enterprise-context.service";
import { ComputeCreditService } from "./compute-credit.service";
import { MemberAllowanceService } from "./member-allowance.service";
import { MemberAllowanceQueryService } from "./member-allowance-query.service";
import { UsageAnalyticsService } from "./usage-analytics.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  MemberAllowanceSetDtoSchema,
  MemberAllowanceTopUpDtoSchema,
  type MemberAllowanceSetDto,
  type MemberAllowanceTopUpDto,
  PaymentPreferenceSchema,
  type PaymentPreference,
} from "shared";

/**
 * 企业算力（人民币口径）查询接口。
 *
 * 这里只读不写：额度发放由订阅履约负责，扣费由对话链路负责。
 * 所有金额一律返回「元」的字符串（Decimal 序列化），前端只做展示格式化。
 */
@ApiTags("compute-credit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("compute-credit")
export class ComputeCreditController {
  constructor(
    private readonly creditService: ComputeCreditService,
    private readonly memberAllowance: MemberAllowanceService,
    private readonly allowanceQuery: MemberAllowanceQueryService,
    private readonly usageAnalytics: UsageAnalyticsService,
    private readonly enterpriseContext: EnterpriseContextService,
  ) {}

  @Get('payment-preference')
  @ApiOperation({ summary: '读取本人在当前企业的付款方式' })
  @ApiResponse({ status: 200, description: 'AUTO、ENTERPRISE_ONLY 或 PERSONAL_ONLY' })
  @ApiResponse({ status: 401, description: '未登录' })
  @ApiResponse({ status: 403, description: '无当前企业成员身份' })
  async getPaymentPreference(@Request() req) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    return this.creditService.getPaymentPreference(ctx.enterpriseId, req.user.id);
  }

  @Patch('payment-preference')
  @ApiOperation({ summary: '修改本人付款方式，仅影响新请求' })
  @ApiResponse({ status: 200, description: '返回已保存的付款方式' })
  @ApiResponse({ status: 400, description: '付款方式无效' })
  @ApiResponse({ status: 401, description: '未登录' })
  @ApiResponse({ status: 403, description: '无当前企业成员身份' })
  async setPaymentPreference(@Request() req, @Body(new ZodValidationPipe(PaymentPreferenceSchema)) dto: PaymentPreference) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    return this.creditService.setPaymentPreference(ctx.enterpriseId, req.user.id, dto.paymentMode);
  }

  @Get("overview")
  @ApiOperation({ summary: "企业算力总览（钱包余额 + 赠送余额，单位：元）" })
  @ApiResponse({ status: 200, description: "返回人民币口径的余额与消费汇总" })
  @ApiResponse({ status: 403, description: "仅企业管理员可查看企业余额" })
  async getOverview(@Request() req) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    // 企业钱包余额、全公司当月消费 —— 这是财务信息，成员看不得。
    // 成员想知道「我还能花多少」看 my-allowance + 个人钱包。
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.creditService.getOverview(ctx.enterpriseId);
  }

  @Get("subscription-credits")
  @ApiOperation({ summary: "各硅基员工的剩余赠送算力余额（元）" })
  @ApiResponse({
    status: 200,
    description: "按订阅返回赠送额度、已用与剩余金额",
  })
  @ApiResponse({ status: 403, description: "仅企业管理员可查看全部赠送余额" })
  async listCredits(@Request() req) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.creditService.listSubscriptionCredits(ctx.enterpriseId);
  }

  @Get("usage-records")
  @ApiOperation({
    summary: "算力用量账单（人民币金额 + Token 明细）",
    description:
      "管理员看全公司逐笔账单；普通成员看**自己**的那些行。" +
      "成员的作用域由 JWT 推出并覆盖 memberId 参数，改地址栏翻不到同事的账。",
  })
  @ApiResponse({
    status: 200,
    description: "分页返回每次模型调用的成本与扣费来源",
  })
  async listUsage(
    @Request() req,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("employeeId") employeeId?: string,
    @Query("memberId") memberId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    /*
      这里曾经是 `assertEnterpriseAdmin` —— 成员连自己花在哪都看不到，
      只有一个「本月已用 ¥0.12」的汇总数字，问不出这 ¥0.12 是哪几次对话。
      账其实一直都记着（ComputeUsageRecord 逐笔带 userId），只是没人给他看。

      放开的是**范围**，不是权限：成员的 scopeUserId 由 JWT 推出，
      在 service 里写在 where 的最后一位，覆盖 memberId 参数。
      管理员照旧 undefined —— 他要的就是全公司。
    */
    const scopeUserId =
      ctx.role === "ENTERPRISE_ADMIN" ? undefined : req.user.id;
    return this.creditService.listUsageRecords(
      ctx.enterpriseId,
      {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        employeeId,
        memberId,
        startDate,
        endDate,
      },
      scopeUserId,
    );
  }

  @Get("usage-breakdown")
  @ApiOperation({
    summary: "用量分析：花费在模型 / 部门 / 碳基员工 / 硅基员工间的分布",
    description:
      "一次返回四个维度 + 趋势 + 环比，因为它们读的是同一张表的同一个区间。" +
      "这里没有余额也没有逐笔账单 —— 那两样在「算力余额」页。",
  })
  @ApiResponse({
    status: 200,
    description:
      "管理员返回全企业四个维度；普通成员只返回自己的花费，" +
      "且 byMember / byDepartment 为空数组",
  })
  async getUsageBreakdown(@Request() req, @Query("days") days?: string) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    /*
      这一页两种人都能进，看到的范围不同：
        · 企业管理员 —— 全企业，四个维度都有
        · 普通成员   —— 只有自己的花费，且没有「按部门 / 按碳基员工」

      作用域在这里定死，不给 query 参数：一旦能传 userId，
      成员改一下地址栏就能看同事的账。前端只是不画那两块，
      真正的隔离靠这一行。
    */
    const scopeUserId =
      ctx.role === "ENTERPRISE_ADMIN" ? undefined : req.user.id;
    return this.usageAnalytics.getBreakdown(
      ctx.enterpriseId,
      days ? Number(days) : undefined,
      scopeUserId,
    );
  }

  @Get("allowances")
  @ApiOperation({
    summary: "算力分配：全体碳基员工的本月额度与已用金额",
    description:
      "额度是闸门不是钱包 —— 分配不会从企业算力余额里预先划走钱，" +
      "只在成员本周期已花到上限时把这次对话改道到他的个人余额。未分配 = 不限额。" +
      "周期可选 日/周/月/季/年，未用完的额度可结转（封顶 1 个周期）。",
  })
  @ApiResponse({
    status: 200,
    description: "按成员返回上限、已用、剩余与重置时间",
  })
  @ApiResponse({ status: 403, description: "仅企业管理员可查看全员额度" })
  async listAllowances(@Request() req) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    // 全员额度是管理信息：谁被限到 ¥50、谁不限额，普通成员看不得。
    // 成员看自己的走 my-allowance。
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.allowanceQuery.listAllowances(ctx.enterpriseId);
  }

  @Get("my-allowance")
  @ApiOperation({
    summary: "我自己的算力额度（本周期已用 / 上限 / 重置时间）",
    description:
      "成员端自查用。额度用尽**不等于**不能对话 —— 个人余额有钱就自费继续，" +
      "所以这个接口只回答「公司这个周期还愿意为我付多少」，" +
      "能不能对话由个人钱包余额一起决定。",
  })
  @ApiResponse({
    status: 200,
    description: "不限额时 limitCNY 为 null，其余字段照常返回",
  })
  async getMyAllowance(@Request() req) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    return this.allowanceQuery.getOne(ctx.enterpriseId, req.user.id);
  }

  @Put("allowances/:userId")
  @ApiOperation({
    summary: "给某位碳基员工分配算力额度（仅企业管理员）",
    description: "limitCNY 传 null 表示取消额度限制（不限额）。",
  })
  @ApiResponse({ status: 200, description: "返回该成员分配后的额度视图" })
  @ApiResponse({ status: 403, description: "仅企业管理员可分配" })
  @ApiResponse({ status: 404, description: "该成员不属于当前企业" })
  async setAllowance(
    @Request() req,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(MemberAllowanceSetDtoSchema))
    dto: MemberAllowanceSetDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.memberAllowance.setAllowance(
      ctx.enterpriseId,
      userId,
      dto,
      req.user.id,
    );
  }

  @Post("allowances/:userId/top-up")
  @ApiOperation({
    summary: "给某位碳基员工充值企业算力余额（仅企业管理员）",
    description:
      "充值立即扣企业钱包并进入成员企业算力余额；月度额度仍独立限制每周期消费。",
  })
  @ApiResponse({ status: 201, description: "返回该成员追加后的额度视图" })
  @ApiResponse({ status: 400, description: "企业钱包余额不足或充值金额非法" })
  @ApiResponse({ status: 403, description: "仅企业管理员可追加" })
  async topUpAllowance(
    @Request() req,
    @Param("userId") userId: string,
    @Body(new ZodValidationPipe(MemberAllowanceTopUpDtoSchema))
    dto: MemberAllowanceTopUpDto,
  ) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.memberAllowance.topUp(
      ctx.enterpriseId,
      userId,
      dto,
      req.user.id,
    );
  }

  @Get("allowance-top-ups")
  @ApiOperation({
    summary: "成员企业充值记录（最近 50 条）",
    description: "传 userId 只看某位成员的充值记录。",
  })
  @ApiResponse({
    status: 200,
    description: "返回充值金额、已消耗、剩余与操作人",
  })
  async listAllowanceTopUps(@Request() req, @Query("userId") userId?: string) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.allowanceQuery.listTopUps(ctx.enterpriseId, userId);
  }

  @Get("allowance-changes")
  @ApiOperation({
    summary: "额度变更留痕（最近 50 条）",
    description:
      "每次改上限 / 改周期 / 开关结转都会留一条，含变更时的已用金额 —— " +
      "「为什么这个月他只花了 ¥200 就被拦了」要靠它回答。",
  })
  @ApiResponse({
    status: 200,
    description: "返回变更前后的上限、周期、结转与操作人",
  })
  async listAllowanceChanges(@Request() req, @Query("userId") userId?: string) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    this.enterpriseContext.assertEnterpriseAdmin(ctx);
    return this.allowanceQuery.listChanges(ctx.enterpriseId, userId);
  }

  @Get("subscription-credits/:subscriptionId")
  @ApiOperation({ summary: "单个订阅的剩余赠送算力余额（元）" })
  @ApiResponse({ status: 404, description: "赠送余额不存在或不属于当前企业" })
  async getCredit(
    @Request() req,
    @Param("subscriptionId") subscriptionId: string,
  ) {
    const ctx = await this.enterpriseContext.resolve(req.user.id);
    return this.creditService.getSubscriptionCredit(
      ctx.enterpriseId,
      subscriptionId,
    );
  }
}
