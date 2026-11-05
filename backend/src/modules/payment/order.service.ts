import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { assertActiveEnterpriseInTx, assertActiveUserInTx } from '../../common/enterprise-write-lock';
import { SubscriptionFulfillmentService } from "../subscription-fulfillment/subscription-fulfillment.service";
import { EmployeeBundleService } from "../employee-bundle/employee-bundle.service";

type FulfillmentOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { employee: true } } };
}>;

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private prisma: PrismaService,
    private fulfillment: SubscriptionFulfillmentService,
    @Optional() private bundles?: EmployeeBundleService,
  ) {}

  /**
   * 从购物车创建订单
   * @param itemIds 可选，仅为指定的购物车项创建订单
   */
  async createFromCart(
    enterpriseId: string,
    createdBy: string,
    itemIds?: string[],
  ) {
    // 1. 获取购物车内容
    const where: any = { enterpriseId };
    if (itemIds && itemIds.length > 0) {
      where.id = { in: itemIds };
    }

    const cartItems = await this.prisma.cartItem.findMany({
      where,
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            annualPriceCNY: true,
            includedComputeCNY: true,
            status: true,
          },
        },
      },
    });

    if (cartItems.length === 0) {
      throw new BadRequestException("购物车为空，无法创建订单");
    }

    // 2. 校验所有员工都是已审核状态
    const unapprovedEmployees = cartItems.filter(
      (item) => item.employee.status !== "APPROVED",
    );
    if (unapprovedEmployees.length > 0) {
      throw new BadRequestException(
        `购物车中存在未审核员工: ${unapprovedEmployees.map((i) => i.employee.name).join(", ")}`,
      );
    }

    // 3. 生成订单号（格式：yyyyMMddHHmmss + 6位随机数）
    const orderNo = this.generateOrderNo();

    // 4. 计算总金额，并把赠送算力的**生效值**固化成订单快照。
    //    快照的意义在于：运营事后改员工配置或系统默认值，都不该改变已成交订单。
    let totalAmount = new Decimal(0);
    const orderItems = await Promise.all(
      cartItems.map(async (cartItem) => {
        const unitPrice = cartItem.employee.annualPriceCNY || new Decimal(0);
        const periodFactor = new Decimal(cartItem.periodMonths).div(12);
        const subtotal = unitPrice.mul(periodFactor);
        totalAmount = totalAmount.add(subtotal);

        return {
          employeeId: cartItem.employeeId,
          employeeName: cartItem.employee.name,
          unitPrice,
          periodMonths: cartItem.periodMonths,
          quantity: 1,
          includedComputeCNY: new Decimal(
            await this.fulfillment.resolveGiftCNY(
              cartItem.employee.includedComputeCNY,
              cartItem.employee.annualPriceCNY,
            ),
          ),
        };
      }),
    );

    // 5. 创建订单
    const order = await this.prisma.$transaction(async (tx) => {
      await assertActiveUserInTx(tx, createdBy);
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      return tx.order.create({
      data: {
        orderNo,
        enterpriseId,
        createdBy,
        status: "PENDING",
        totalAmount,
        items: {
          create: orderItems,
        },
      },
      include: {
        items: {
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                avatar: true,
                description: true,
              },
            },
          },
        },
      },
      });
    });

    this.logger.log(
      `订单 ${orderNo} 已创建，企业 ${enterpriseId}，金额 ${totalAmount} 元`,
    );

    return order;
  }

  /** 从员工市场直接创建订阅订单，不创建购物车项。 */
  async createDirect(
    enterpriseId: string,
    createdBy: string,
    input: { employeeId: string; periodMonths: number },
  ) {
    const employee = await this.prisma.digitalEmployee.findUnique({
      where: { id: input.employeeId },
      select: {
        id: true,
        name: true,
        avatar: true,
        description: true,
        annualPriceCNY: true,
        includedComputeCNY: true,
        status: true,
      },
    });

    if (!employee) throw new NotFoundException("员工不存在");
    if (employee.status !== "APPROVED") {
      throw new BadRequestException("该数字员工尚未审核通过，无法订阅");
    }

    const existingSubscription = await this.prisma.subscription.findUnique({
      where: {
        enterpriseId_employeeId: {
          enterpriseId,
          employeeId: input.employeeId,
        },
      },
      select: { status: true },
    });
    if (existingSubscription?.status === "ACTIVE") {
      throw new BadRequestException("已订阅该硅基员工，无法重复下单");
    }

    const unitPrice = employee.annualPriceCNY ?? new Decimal(0);
    if (unitPrice.lessThanOrEqualTo(0)) {
      throw new BadRequestException("员工未设置有效价格，无法订阅");
    }
    const totalAmount = unitPrice.mul(new Decimal(input.periodMonths).div(12));
    const orderNo = this.generateOrderNo();
    const includedComputeCNY = new Decimal(
      await this.fulfillment.resolveGiftCNY(
        employee.includedComputeCNY,
        employee.annualPriceCNY,
      ),
    );

    return this.prisma.$transaction(async (tx) => {
      await assertActiveUserInTx(tx, createdBy);
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      return tx.order.create({
      data: {
        orderNo,
        enterpriseId,
        createdBy,
        status: "PENDING",
        totalAmount,
        items: {
          create: [
            {
              employeeId: employee.id,
              employeeName: employee.name,
              unitPrice,
              periodMonths: input.periodMonths,
              quantity: 1,
              includedComputeCNY,
            },
          ],
        },
      },
      include: {
        items: {
          include: {
            employee: {
              select: { id: true, name: true, avatar: true, description: true },
            },
          },
        },
      },
      });
    });
  }

  /** 从已发布套餐创建订单。价格、员工和算力均由服务端重新读取并固化快照。 */
  async createBundle(enterpriseId: string, createdBy: string, bundleId: string) {
    if (!this.bundles) throw new BadRequestException('套餐服务不可用');
    const bundle = await this.bundles.getForPurchase(bundleId);
    const employeeIds = bundle.items.map((item) => item.employeeId);
    const subscriptions = await this.prisma.subscription.findMany({
      where: { enterpriseId, employeeId: { in: employeeIds }, status: 'ACTIVE' },
      select: { employeeId: true },
    });
    if (subscriptions.length > 0) {
      throw new BadRequestException(`企业已订阅套餐中的员工：${subscriptions.map((item) => item.employeeId).join('、')}`);
    }

    const orderNo = this.generateOrderNo();
    const rawItems = await Promise.all(bundle.items.map(async (item) => {
      const periodMonths = item.periodMonths || bundle.periodMonths;
      const unitPrice = item.employee.annualPriceCNY ?? new Decimal(0);
      const includedComputeCNY = await this.bundles.resolveGiftCNY(item);
      return {
        employeeId: item.employeeId,
        employeeName: item.employee.name,
        employeeVersion: item.employee.version,
        unitPrice,
        periodMonths,
        quantity: 1,
        includedComputeCNY: new Decimal(includedComputeCNY),
        listedSubtotal: unitPrice.mul(new Decimal(periodMonths).div(12)),
      };
    }));
    const listedTotal = rawItems.reduce((sum, item) => sum.add(item.listedSubtotal), new Decimal(0));
    let allocated = new Decimal(0);
    const items = rawItems.map((item, index) => {
      const remaining = Decimal.max(bundle.priceCNY.sub(allocated), new Decimal(0));
      const proportionalAmount = bundle.priceCNY.mul(item.listedSubtotal)
        .div(listedTotal)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const purchaseAmountCNY = index === rawItems.length - 1
        ? remaining
        : Decimal.min(proportionalAmount, remaining);
      allocated = allocated.add(purchaseAmountCNY);
      const { listedSubtotal: _listedSubtotal, ...snapshot } = item;
      return { ...snapshot, purchaseAmountCNY };
    });

    return this.prisma.$transaction(async (tx) => {
      await assertActiveUserInTx(tx, createdBy);
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      return tx.order.create({
        data: {
          orderNo,
          enterpriseId,
          createdBy,
          orderType: 'BUNDLE',
          bundleId: bundle.id,
          bundleName: bundle.name,
          bundlePriceCNY: bundle.priceCNY,
          bundlePeriodMonths: bundle.periodMonths,
          status: 'PENDING',
          totalAmount: bundle.priceCNY,
          items: { create: items },
        },
        include: { items: { include: { employee: true } } },
      });
    });
  }

  /**
   * 查询订单列表
   */
  async findAll(
    enterpriseId: string,
    query: { page?: number; limit?: number; status?: string; orderType?: 'EMPLOYEE' | 'BUNDLE' },
  ) {
    const { page = 1, limit = 20, status, orderType } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      enterpriseId,
      ...(status && { status }),
      ...(orderType && { orderType }),
    };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          items: {
            include: {
              employee: {
                select: { id: true, name: true, avatar: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 查询单个订单
   */
  async findOne(orderId: string, enterpriseId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                avatar: true,
                description: true,
              },
            },
          },
        },
      },
    });

    if (!order || order.enterpriseId !== enterpriseId) {
      throw new NotFoundException("订单不存在");
    }

    return order;
  }

  /**
   * 按订单号查询订单
   */
  async findByOrderNo(orderNo: string) {
    return this.prisma.order.findUnique({
      where: { orderNo },
      include: {
        items: {
          include: {
            employee: true,
          },
        },
      },
    });
  }

  /**
   * 订单履约（支付成功后调用）
   * 必须在一个事务中完成：订阅生效 + 算力充值 + 清空购物车
   */
  async fulfill(
    orderId: string,
    payTradeNo: string,
    payChannel: "ALIPAY" | "BALANCE" = "ALIPAY",
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { employee: true } } },
    });

    if (!order) {
      throw new NotFoundException("订单不存在");
    }

    if (order.status === "PAID") {
      this.logger.warn(`订单 ${order.orderNo} 已履约，跳过重复处理`);
      return order;
    }

    if (order.status !== "PENDING") {
      throw new BadRequestException(`订单状态为 ${order.status}，无法履约`);
    }

    const result = await this.prisma.$transaction((tx) =>
      this.executeFulfillment(tx, order, payTradeNo, payChannel),
    );

    this.logger.log(
      `订单 ${order.orderNo} 履约完成，企业 ${order.enterpriseId}`,
    );

    return result;
  }

  /** 在调用方事务内履约，供余额扣款与订单生效保持原子性。 */
  async fulfillInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
    payTradeNo: string,
    payChannel: "ALIPAY" | "BALANCE" = "ALIPAY",
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { employee: true } } },
    });

    if (!order) {
      throw new NotFoundException("订单不存在");
    }
    if (order.status === "PAID") {
      this.logger.warn(`订单 ${order.orderNo} 已履约，跳过重复处理`);
      return order;
    }
    if (order.status !== "PENDING") {
      throw new BadRequestException(`订单状态为 ${order.status}，无法履约`);
    }

    return this.executeFulfillment(tx, order, payTradeNo, payChannel);
  }

  private async executeFulfillment(
    tx: Prisma.TransactionClient,
    order: FulfillmentOrder,
    payTradeNo: string,
    payChannel: "ALIPAY" | "BALANCE",
  ) {
    await assertActiveUserInTx(tx, order.createdBy);
    await assertActiveEnterpriseInTx(tx, order.enterpriseId);
    const current = await tx.order.findUnique({ where: { id: order.id } });
    if (current?.status === 'PAID') return current;
    if (!current || current.status !== 'PENDING') throw new BadRequestException('订单当前不可履约');
    // 市场订单只能由企业管理员创建。下单到支付回调之间可能已过数天，
    // 操作人可能被降权或移出企业，所以履约时必须复核而不是信任下单时的判断。
    const purchaser = await this.fulfillment.assertEnterpriseAdmin(
      tx,
      order.createdBy,
      order.enterpriseId,
    );

    // 1. 更新订单状态
    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAID",
        payTradeNo,
        payChannel,
        paidAt: new Date(),
      },
    });

    // 2. 处理每个订单项。履约细节（建订阅、锁模板版本、自动授权、发赠送额度）
    //    统一收敛到 SubscriptionFulfillmentService —— 与直接订阅走同一份实现，
    //    否则两条链路的授权与账务结果会再次分叉。
    const now = new Date();
    for (const item of order.items) {
      const endDate = new Date(now);
      endDate.setMonth(endDate.getMonth() + item.periodMonths);

      // 赠送金额用**下单时的快照**，不是当前员工配置：订单已经成交，
      // 运营事后改默认值不该改变已付款订单的赠送金额。
      const result = await this.fulfillment.fulfill(tx, {
        enterpriseId: order.enterpriseId,
        employeeId: item.employeeId,
        purchaserMemberId: purchaser.id,
        displayName: item.employeeName,
        startDate: now,
        endDate,
        sourceType: "order",
        sourceId: order.id,
        purchaseAmountCNY: item.purchaseAmountCNY?.toNumber() ?? new Decimal(item.unitPrice ?? item.employee?.annualPriceCNY ?? 0)
          .mul(new Decimal(item.periodMonths).div(12)).toNumber(),
        purchasePeriodMonths: item.periodMonths,
        templateVersion: item.employeeVersion ?? undefined,
        grantedCNY: item.includedComputeCNY.toNumber(),
      });
      // 历史测试替身可能没有 orderItem delegate；真实 Prisma 事务始终具备它。
      if (tx.orderItem) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { fulfilledSubscriptionId: result.subscriptionId },
        });
      }
    }

    // 3. 仅清理本订单对应员工的购物车项，避免直接订阅误清空其他商品
    const deletedCart = await tx.cartItem.deleteMany({
      where: {
        enterpriseId: order.enterpriseId,
        employeeId: { in: order.items.map((item) => item.employeeId) },
      },
    });

    this.logger.log(`购物车已清空，删除 ${deletedCart.count} 项`);

    return updatedOrder;
  }

  /**
   * 关闭订单（超时/取消）
   */
  async close(orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException("订单不存在");
    }

    if (order.status !== "PENDING") {
      throw new BadRequestException(`订单状态为 ${order.status}，无法关闭`);
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });
  }

  /**
   * 生成订单号：yyyyMMddHHmmss + 6位随机数
   */
  private generateOrderNo(): string {
    const now = new Date();
    const dateStr = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const random = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0");
    return `${dateStr}${random}`;
  }
}
