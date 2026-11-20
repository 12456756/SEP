import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { OrderService } from "./order.service";
import { AlipayProvider } from "./alipay.provider";
import { ComputeService } from "../compute/compute.service";
import { WalletService } from "../wallet/wallet.service";
import { PersonalWalletService } from "../personal-wallet/personal-wallet.service";
import { assertActiveEnterpriseInTx, assertActiveUserInTx } from '../../common/enterprise-write-lock';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private orderService: OrderService,
    private alipayProvider: AlipayProvider,
    private computeService: ComputeService,
    private walletService: WalletService,
    // 个人钱包没有反向依赖（它只 import PrismaModule），这条边是单向的，
    // 不需要 forwardRef —— 加了反而会掩盖将来真的成环
    private personalWalletService: PersonalWalletService,
  ) {}

  /**
   * 初始化支付宝配置（从 SystemSetting 读取）
   */
  async initializeAlipay() {
    const settings = await this.prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            "alipay.appId",
            "alipay.privateKey",
            "alipay.publicKey",
            "alipay.gateway",
          ],
        },
      },
    });

    const config = settings.reduce(
      (acc, item) => {
        if (item.key === "alipay.appId") acc.appId = item.value;
        if (item.key === "alipay.privateKey") acc.privateKey = item.value;
        if (item.key === "alipay.publicKey") acc.alipayPublicKey = item.value;
        if (item.key === "alipay.gateway") acc.gateway = item.value;
        return acc;
      },
      {} as {
        appId: string;
        privateKey: string;
        alipayPublicKey: string;
        gateway?: string;
      },
    );

    if (!config.appId || !config.privateKey || !config.alipayPublicKey) {
      throw new Error("支付宝配置不完整，请在系统设置中配置支付参数");
    }

    await this.alipayProvider.initialize(config);
  }

  /**
   * 发起支付宝支付（员工订阅订单）
   */
  async createAlipayPayment(orderId: string, returnUrl?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            employee: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException("订单不存在");
    }

    if (order.status !== "PENDING") {
      throw new BadRequestException(`订单状态为 ${order.status}，无法支付`);
    }

    if (order.totalAmount.isZero()) {
      throw new BadRequestException('免费订单无需支付宝支付，请直接确认开通');
    }
    if (!order.totalAmount.isFinite() || order.totalAmount.lessThan(0)) {
      throw new BadRequestException('订单金额无效');
    }

    // 确保支付宝 SDK 已初始化
    await this.prisma.$transaction(async (tx) => {
      await assertActiveUserInTx(tx, order.createdBy);
      await assertActiveEnterpriseInTx(tx, order.enterpriseId);
    });
    await this.initializeAlipay();

    // 生成支付表单
    const subject = `硅基员工订阅 - ${order.items.map((i) => i.employeeName).join(", ")}`;
    const body = `订单号: ${order.orderNo}`;

    const paymentForm = await this.alipayProvider.pagePayment({
      outTradeNo: order.orderNo,
      totalAmount: order.totalAmount.toString(),
      subject,
      body,
      // 同充值订单：支付宝回跳不会带 orderId，结果页依赖它定位订单，
      // 必须在此显式拼入，否则回跳后页面查不到订单。
      returnUrl: returnUrl ?? this.buildOrderReturnUrl(order.id),
    });

    this.logger.log(`订单 ${order.orderNo} 支付请求已生成`);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      paymentForm,
    };
  }

  /** 使用企业余额支付订单，并履约订阅。 */
  async payOrderWithBalance(orderId: string, enterpriseId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.enterpriseId !== enterpriseId) {
        throw new NotFoundException("订单不存在");
      }
      if (order.status !== "PENDING") {
        throw new BadRequestException(`订单状态为 ${order.status}，无法支付`);
      }

      await assertActiveUserInTx(tx, order.createdBy);
      await assertActiveEnterpriseInTx(tx, order.enterpriseId);
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current || current.status !== 'PENDING') {
        throw new BadRequestException('订单当前不可支付');
      }
      if (!order.totalAmount.isFinite() || order.totalAmount.lessThan(0)) {
        throw new BadRequestException('订单金额无效');
      }
      const isFree = order.totalAmount.isZero();
      if (!isFree) {
        await this.walletService.consume(
          enterpriseId,
          order.totalAmount.toNumber(),
          "subscription",
          order.id,
          `余额支付订单 ${order.orderNo}`,
          tx,
        );
      }

      return this.orderService.fulfillInTransaction(
        tx,
        order.id,
        `${isFree ? 'FREE' : 'BALANCE'}:${order.orderNo}`,
        "BALANCE",
      );
    });
  }

  /**
   * 发起支付宝支付（充值订单）
   */
  async createRechargeAlipayPayment(orderNo: string, returnUrl?: string) {
    const order = await this.prisma.rechargeOrder.findUnique({
      where: { orderNo },
    });

    if (!order) {
      throw new NotFoundException("充值订单不存在");
    }

    if (order.status !== "PENDING") {
      throw new BadRequestException(`订单状态为 ${order.status}，无法支付`);
    }

    await this.prisma.$transaction(async (tx) => {
      const account = await tx.computeAccount.findUnique({ where: { id: order.accountId } });
      if (!account) throw new NotFoundException('算力账户不存在');
      await assertActiveEnterpriseInTx(tx, account.enterpriseId);
    });
    await this.initializeAlipay();

    // 生成支付表单
    const subject = "算力充值";
    const body = `充值金额: ¥${order.amount}`;

    const paymentForm = await this.alipayProvider.pagePayment({
      outTradeNo: order.orderNo,
      totalAmount: order.amount.toString(),
      subject,
      body,
      // 支付宝同步回跳只会附加它自己的参数（out_trade_no/trade_no/sign 等），
      // 不会凭空产生 orderNo。结果页依赖 orderNo 定位订单，故必须在此显式拼入，
      // 否则回跳后页面拿不到订单号，只能显示「缺少订单号」。
      returnUrl: returnUrl ?? this.buildRechargeReturnUrl(order.orderNo),
    });

    this.logger.log(`充值订单 ${order.orderNo} 支付请求已生成`);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      paymentForm,
    };
  }

  /**
   * 构造充值结果页回跳地址（带订单号）
   */
  private buildRechargeReturnUrl(orderNo: string): string {
    const webUrl = this.configService.get<string>("WEB_BASE_URL");
    return `${webUrl}/payment/recharge/result?orderNo=${encodeURIComponent(orderNo)}`;
  }

  /**
   * 发起支付宝支付（个人充值订单）
   *
   * 与企业充值同一条支付链路，但收款主体与入账目标不同：
   * 这笔钱进的是**成员自己的**个人钱包，企业账上看不到它 ——
   * 所以 subject 必须写清「个人」，否则用户在支付宝账单里分不出是替公司充的还是自费。
   */
  async createPersonalRechargeAlipayPayment(orderNo: string, returnUrl?: string) {
    const existing = await this.prisma.personalRechargeOrder.findUnique({
      where: { orderNo },
    });

    if (!existing) {
      throw new NotFoundException("充值订单不存在");
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${existing.userId} FOR UPDATE
      `;
      if (users[0]?.status !== "ACTIVE") {
        throw new ConflictException("账号当前不可发起个人充值");
      }
      const current = await tx.personalRechargeOrder.findUnique({ where: { orderNo } });
      if (!current) throw new NotFoundException("充值订单不存在");
      if (current.status !== "PENDING") {
        throw new BadRequestException(`订单状态为 ${current.status}，无法支付`);
      }
      return current;
    });

    await this.initializeAlipay();

    const paymentForm = await this.alipayProvider.pagePayment({
      outTradeNo: order.orderNo,
      totalAmount: order.amount.toString(),
      subject: "个人算力余额充值",
      body: `充值金额: ¥${order.amount}`,
      // 同企业充值：支付宝回跳不带 orderNo，结果页靠它定位订单，必须显式拼入
      returnUrl: returnUrl ?? this.buildPersonalRechargeReturnUrl(order.orderNo),
    });

    this.logger.log(`个人充值订单 ${order.orderNo} 支付请求已生成`);

    return {
      orderId: order.id,
      orderNo: order.orderNo,
      paymentForm,
    };
  }

  /** 个人充值结果页回跳地址（带订单号）。与企业充值是两个页面，返回按钮的去处不同。 */
  private buildPersonalRechargeReturnUrl(orderNo: string): string {
    const webUrl = this.configService.get<string>("WEB_BASE_URL");
    return `${webUrl}/payment/personal-recharge/result?orderNo=${encodeURIComponent(orderNo)}`;
  }

  /**
   * 主动查单兜底（个人充值对账）
   *
   * 与企业充值同理：异步通知可能丢失，用户已付款却始终看不到余额。
   * 结果页轮询调用它，把「支付宝已收钱、平台没入账」的窗口收敛掉。
   */
  async reconcilePersonalRechargeOrder(orderNo: string) {
    const order = await this.prisma.personalRechargeOrder.findUnique({
      where: { orderNo },
    });

    if (!order) {
      throw new NotFoundException("充值订单不存在");
    }

    if (order.status !== "PENDING") {
      return { status: order.status, reconciled: false };
    }

    await this.initializeAlipay();

    const trade = await this.queryAlipayTrade(orderNo);
    if (!trade.paid) {
      return { status: order.status, reconciled: false };
    }

    // fulfillRechargeOrder 自身幂等，与通知撞车也只会入账一次
    this.logger.warn(
      `个人充值订单 ${orderNo} 支付宝显示已支付但本地为 PENDING，触发主动履约（tradeNo=${trade.tradeNo}）`,
    );
    await this.personalWalletService.fulfillRechargeOrder(
      orderNo,
      trade.tradeNo!,
      "ALIPAY",
    );

    return { status: "PAID", reconciled: true };
  }

  /**
   * 构造订阅订单结果页回跳地址（带订单 ID）
   *
   * 注意结果页用的是 orderId（非 orderNo），与充值页不同。
   */
  private buildOrderReturnUrl(orderId: string): string {
    const webUrl = this.configService.get<string>("WEB_BASE_URL");
    return `${webUrl}/payment/result?orderId=${encodeURIComponent(orderId)}`;
  }

  /**
   * 处理支付宝异步通知（幂等）- 支持订单支付和充值支付
   */
  async handleAlipayNotify(postData: Record<string, any>) {
    // 0. 确保 SDK 已初始化：异步通知可能先于任何下单请求到达（如后端重启后），
    //    否则 verifyNotify 会因 SDK 未初始化抛异常导致 500，回调永远失败。
    try {
      await this.initializeAlipay();
    } catch (error) {
      this.logger.error("支付宝 SDK 初始化失败，无法校验通知", error);
      return { success: false, message: "支付宝配置初始化失败" };
    }

    // 1. 验证签名
    const isValid = this.alipayProvider.verifyNotify(postData);
    if (!isValid) {
      this.logger.warn("支付宝通知签名验证失败", postData);
      return { success: false, message: "签名验证失败" };
    }

    const {
      out_trade_no: outTradeNo,
      trade_no: tradeNo,
      trade_status: tradeStatus,
    } = postData;

    // 2. 幂等检查：插入通知记录（唯一约束防止重复处理）
    //
    // 注意：这里只把「已成功履约」的通知视为可跳过。早期实现一律跳过，
    // 导致履约失败（如回调早于订单落库）的记录留在表里且 processed=false，
    // 后续支付宝重试全部被误判为「已处理」并返回 success —— 支付宝随即停止重试，
    // 钱扣了却永远不入账。故此处需区分 processed 真伪。
    const existingNotify = await this.prisma.paymentNotify.findFirst({
      where: { channel: "ALIPAY", tradeNo },
    });

    if (existingNotify?.processed) {
      this.logger.warn(`支付宝通知 ${tradeNo} 已成功处理过，跳过`);
      return { success: true, message: "通知已处理" };
    }

    if (existingNotify) {
      // 之前收到过但未履约成功：放行本次重试，不再重复插入记录。
      this.logger.warn(
        `支付宝通知 ${tradeNo} 曾处理失败（processed=false），本次重试将重新履约`,
      );
    } else {
      try {
        await this.prisma.paymentNotify.create({
          data: {
            channel: "ALIPAY",
            outTradeNo,
            tradeNo,
            rawBody: JSON.stringify(postData),
            verified: true,
            processed: false,
          },
        });
      } catch (error) {
        // 并发下的唯一约束冲突：另一请求正在处理同一通知，本次直接让支付宝重试。
        this.logger.warn(`支付宝通知 ${tradeNo} 并发写入冲突，交由重试处理`);
        return { success: false, message: "并发处理中，请重试" };
      }
    }

    // 3. 仅处理支付成功状态
    if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "TRADE_FINISHED") {
      this.logger.log(`订单 ${outTradeNo} 状态为 ${tradeStatus}，暂不处理`);
      return { success: true, message: "状态不需要处理" };
    }

    // 4. 根据订单号前缀区分订单类型
    try {
      if (outTradeNo.startsWith("RCH")) {
        // 充值订单
        await this.computeService.fulfillRechargeOrder(
          outTradeNo,
          tradeNo,
          "ALIPAY",
        );
        this.logger.log(`充值订单 ${outTradeNo} 支付成功，履约完成`);
      } else if (outTradeNo.startsWith("PRC")) {
        // 个人充值订单 —— 钱进成员自己的个人钱包，不进企业账
        await this.personalWalletService.fulfillRechargeOrder(
          outTradeNo,
          tradeNo,
          "ALIPAY",
        );
        this.logger.log(`个人充值订单 ${outTradeNo} 支付成功，履约完成`);
      } else if (outTradeNo.startsWith("ORD")) {
        // 员工订阅订单
        const order = await this.orderService.findByOrderNo(outTradeNo);
        if (!order) {
          this.logger.error(`订单 ${outTradeNo} 不存在`);
          return { success: false, message: "订单不存在" };
        }
        await this.orderService.fulfill(order.id, tradeNo);
        this.logger.log(`订单 ${outTradeNo} 支付成功，履约完成`);
      } else {
        this.logger.error(`未知订单类型: ${outTradeNo}`);
        return { success: false, message: "未知订单类型" };
      }

      // 标记通知已处理
      await this.prisma.paymentNotify.updateMany({
        where: { channel: "ALIPAY", tradeNo },
        data: { processed: true },
      });

      return { success: true, message: "处理成功" };
    } catch (error) {
      this.logger.error(`订单 ${outTradeNo} 履约失败`, error);
      return { success: false, message: "履约失败" };
    }
  }

  /**
   * 查询支付状态
   */
  async queryPaymentStatus(orderNo: string) {
    await this.initializeAlipay();

    const result = await this.alipayProvider.queryTrade({
      outTradeNo: orderNo,
    });

    return result;
  }

  /**
   * 主动查单兜底（对账）
   *
   * 异步通知并非绝对可靠：可能因网络、回调地址配错、服务重启而丢失，
   * 同步回跳也可能因用户提前关闭页面而不发生。此方法直接向支付宝核对
   * 真实交易状态，若已支付但本地仍为 PENDING，则补执行履约。
   *
   * 结果页轮询会调用它，把「支付宝已收钱、平台没入账」的窗口收敛掉。
   */
  async reconcileRechargeOrder(orderNo: string) {
    const order = await this.prisma.rechargeOrder.findUnique({
      where: { orderNo },
    });

    if (!order) {
      throw new NotFoundException("充值订单不存在");
    }

    // 已是终态，无需对账
    if (order.status !== "PENDING") {
      return { status: order.status, reconciled: false };
    }

    await this.initializeAlipay();

    const trade = await this.queryAlipayTrade(orderNo);
    if (!trade.paid) {
      return { status: order.status, reconciled: false };
    }

    // 支付宝确认已收款，但本地仍 PENDING —— 补履约。
    // fulfillRechargeOrder 自身对已履约订单幂等，重复调用安全。
    this.logger.warn(
      `充值订单 ${orderNo} 支付宝显示已支付但本地为 PENDING，触发主动履约（tradeNo=${trade.tradeNo}）`,
    );
    await this.computeService.fulfillRechargeOrder(
      orderNo,
      trade.tradeNo,
      "ALIPAY",
    );

    return { status: "PAID", reconciled: true };
  }

  /**
   * 主动查单兜底（订阅订单对账）
   *
   * 与充值订单同理：异步通知可能丢失，导致用户已付款但订阅始终未生效。
   * 此方法向支付宝核对真实状态，确认已收款则补执行 orderService.fulfill。
   */
  async reconcileOrder(orderNo: string) {
    const order = await this.orderService.findByOrderNo(orderNo);

    if (!order) {
      throw new NotFoundException("订单不存在");
    }

    // 已是终态，无需对账
    if (order.status !== "PENDING") {
      return { status: order.status, reconciled: false };
    }

    await this.initializeAlipay();

    const trade = await this.queryAlipayTrade(orderNo);
    if (!trade.paid) {
      return { status: order.status, reconciled: false };
    }

    // fulfill 对已履约订单幂等（status === 'PAID' 时直接返回），重复调用安全。
    this.logger.warn(
      `订阅订单 ${orderNo} 支付宝显示已支付但本地为 PENDING，触发主动履约（tradeNo=${trade.tradeNo}）`,
    );
    await this.orderService.fulfill(order.id, trade.tradeNo);

    return { status: "PAID", reconciled: true };
  }

  /**
   * 向支付宝查询交易真实状态。
   *
   * 查不到交易（ACQ.TRADE_NOT_EXIST）是正常情况——用户可能尚未付款，
   * 故吞掉异常并返回未支付，让调用方继续等待而非报错。
   */
  private async queryAlipayTrade(
    outTradeNo: string,
  ): Promise<{ paid: boolean; tradeNo?: string }> {
    let trade: any;
    try {
      trade = await this.alipayProvider.queryTrade({ outTradeNo });
    } catch (error) {
      this.logger.warn(`订单 ${outTradeNo} 查单失败或交易不存在`);
      return { paid: false };
    }

    const tradeStatus = trade?.tradeStatus ?? trade?.trade_status;
    const tradeNo = trade?.tradeNo ?? trade?.trade_no;
    const paid =
      tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED";

    return { paid, tradeNo };
  }
}
