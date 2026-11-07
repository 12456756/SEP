import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma, WalletTransactionType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { assertActiveEnterpriseInTx } from '../../common/enterprise-write-lock';
import { depositRefundableAmount } from './deposit-refund';

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取企业钱包余额
   */
  async getBalance(enterpriseId: string) {
    const wallet = await this.ensureWallet(enterpriseId);
    return {
      balance: wallet.balance,
      frozenAmount: wallet.frozenAmount,
      /// 已划入算力专款的部分（是 balance 的子集，不是额外的钱）
      computeReservedCNY: wallet.computeReservedCNY,
      /// 订阅等非算力支出可动用的部分 = balance - computeReservedCNY
      spendableCNY: wallet.balance.sub(wallet.computeReservedCNY),
      totalDeposit: wallet.totalDeposit,
      totalConsume: wallet.totalConsume,
      totalRefund: wallet.totalRefund,
    };
  }

  /**
   * 充值（支付宝回调时调用）
   */
  async deposit(
    enterpriseId: string,
    amount: number,
    paymentOrderId: string,
    description?: string,
    transaction?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) {
      throw new BadRequestException("充值金额必须大于 0");
    }

    const deposit = async (tx: Prisma.TransactionClient) => {
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      // 1. 获取钱包（行锁）
      const wallet = await tx.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);
      const balanceAfter = balanceBefore.add(amountDecimal);

      // 2. 更新余额（乐观锁）
      const updated = await tx.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version, // 乐观锁：只有版本号匹配才更新
        },
        data: {
          balance: balanceAfter,
          totalDeposit: { increment: amountDecimal },
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 3. 记录交易
      return tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.DEPOSIT,
          amount: amountDecimal,
          balanceBefore,
          balanceAfter,
          paymentMethod: "alipay",
          paymentOrderId,
          description: description || `充值 ¥${amount}`,
        },
      });
    };
    return transaction ? deposit(transaction) : this.prisma.$transaction(deposit);
  }

  /**
   * 消费（订阅员工、算力消耗）
   */
  async consume(
    enterpriseId: string,
    amount: number,
    relatedType: "subscription" | "compute",
    relatedId: string | null,
    description?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) {
      throw new BadRequestException("消费金额必须大于 0");
    }

    const consume = async (client: Prisma.TransactionClient) => {
      await assertActiveEnterpriseInTx(client, enterpriseId);
      // 1. 获取钱包
      const wallet = await client.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);

      // 2. 检查余额。
      //    订阅这类非算力支出只能动「自由余额」= 余额 - 算力专款。
      //    专款的全部意义就是不被订阅费吃掉，所以这里不能只看 balance。
      const reserved =
        relatedType === "compute" ? new Decimal(0) : wallet.computeReservedCNY;
      const spendable = balanceBefore.sub(reserved);

      if (spendable.lessThan(amountDecimal)) {
        throw new BadRequestException(
          reserved.greaterThan(0)
            ? `可用余额不足。钱包余额 ¥${balanceBefore}，其中 ¥${reserved} 已划入算力专款不可挪用，本次可用 ¥${spendable}，需要 ¥${amount}`
            : `余额不足。当前余额: ¥${balanceBefore}，需要: ¥${amount}`,
        );
      }

      const balanceAfter = balanceBefore.sub(amountDecimal);

      // 3. 更新余额（乐观锁）
      const updated = await client.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version,
        },
        data: {
          balance: balanceAfter,
          totalConsume: { increment: amountDecimal },
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 4. 记录交易（负数表示扣款）
      return client.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.CONSUME,
          amount: amountDecimal.neg(), // 负数
          balanceBefore,
          balanceAfter,
          relatedType,
          relatedId,
          description,
        },
      });
    };

    return tx ? consume(tx) : this.prisma.$transaction(consume);
  }

  /**
   * 退款（解雇员工、取消订阅）
   */
  async refund(
    enterpriseId: string,
    amount: number,
    relatedType: "subscription" | "compute",
    relatedId: string,
    description?: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) {
      throw new BadRequestException("退款金额必须大于 0");
    }

    const refund = async (client: Prisma.TransactionClient) => {
      await assertActiveEnterpriseInTx(client, enterpriseId);
      // 1. 获取钱包
      const wallet = await client.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);
      const balanceAfter = balanceBefore.add(amountDecimal);

      // 2. 更新余额（乐观锁）
      const updated = await client.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version,
        },
        data: {
          balance: balanceAfter,
          totalRefund: { increment: amountDecimal },
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 3. 记录交易
      return client.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.REFUND,
          amount: amountDecimal, // 正数
          balanceBefore,
          balanceAfter,
          relatedType,
          relatedId,
          description,
        },
      });
    };

    return tx ? refund(tx) : this.prisma.$transaction(refund);
  }

  /** Record a deposit refund in the wallet ledger. */
  async refundDeposit(params: {
    enterpriseId: string;
    depositTransactionId: string;
    amount: number;
    reason?: string;
    operatorId: string;
  }) {
    const { enterpriseId, depositTransactionId, amount, reason, operatorId } = params;
    if (!Number.isFinite(amount) || amount <= 0 || new Decimal(amount).decimalPlaces() > 2) {
      throw new BadRequestException('退款金额必须大于 0 且最多保留两位小数');
    }

    return this.prisma.$transaction(async (tx) => {
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      const wallet = await tx.enterpriseWallet.findUnique({ where: { enterpriseId } });
      if (!wallet) throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);

      const deposit = await tx.walletTransaction.findFirst({
        where: { id: depositTransactionId, walletId: wallet.id, type: WalletTransactionType.DEPOSIT },
      });
      if (!deposit) throw new NotFoundException('充值记录不存在');

      const priorRefunds = await tx.walletTransaction.findMany({
        where: {
          walletId: wallet.id,
          type: WalletTransactionType.REFUND,
          metadata: { path: ['sourceTransactionId'], equals: depositTransactionId },
        },
        select: { amount: true },
      });
      const refundedAmount = priorRefunds.reduce(
        (sum, refund) => sum.add(refund.amount.abs()),
        new Decimal(0),
      );
      const sourceRemaining = Decimal.max(new Decimal(deposit.amount).abs().sub(refundedAmount), 0);
      const refundableAmount = depositRefundableAmount(sourceRemaining, wallet);
      const refundAmount = new Decimal(amount);

      if (refundAmount.greaterThan(refundableAmount)) {
        throw new BadRequestException(`退款金额超过当前可退金额 ¥${refundableAmount.toFixed(2)}`);
      }

      const balanceAfter = wallet.balance.sub(refundAmount);
      const updated = await tx.enterpriseWallet.updateMany({
        where: { enterpriseId, version: wallet.version },
        data: {
          balance: balanceAfter,
          totalRefund: { increment: refundAmount },
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new ConflictException('余额已发生变化，请刷新后重试');

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.REFUND,
          amount: refundAmount.neg(),
          balanceBefore: wallet.balance,
          balanceAfter,
          relatedType: 'deposit_refund',
          relatedId: depositTransactionId,
          description: reason?.trim() || '充值退款',
          metadata: { sourceTransactionId: depositTransactionId, refundKind: 'DEPOSIT_REFUND' },
          createdBy: operatorId,
        },
      });

      return {
        transaction,
        balance: balanceAfter.toNumber(),
        refundAmount: refundAmount.toNumber(),
        remainingRefundableAmount: depositRefundableAmount(
          sourceRemaining.sub(refundAmount), { ...wallet, balance: balanceAfter },
        ).toNumber(),
      };
    });
  }

  /**
   * 获取交易记录
   */
  async getTransactions(
    enterpriseId: string,
    options: {
      type?: WalletTransactionType;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const { type, page = 1, limit = 20 } = options;

    const wallet = await this.ensureWallet(enterpriseId);

    const where: Prisma.WalletTransactionWhereInput = {
      walletId: wallet.id,
      ...(type && { type }),
    };

    const [items, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 管理员手动调整余额（补偿、赠送等）
   */
  async adjust(
    enterpriseId: string,
    amount: number,
    reason: string,
    operatorId: string,
  ) {
    if (amount === 0) {
      throw new BadRequestException("调整金额不能为 0");
    }

    return this.prisma.$transaction(async (tx) => {
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      const wallet = await tx.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);
      const balanceAfter = balanceBefore.add(amountDecimal);

      if (balanceAfter.lessThan(0)) {
        throw new BadRequestException(
          `调整后余额不能为负数。当前: ¥${balanceBefore}，调整: ¥${amount}`,
        );
      }

      // 更新余额
      const updated = await tx.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version,
        },
        data: {
          balance: balanceAfter,
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 记录交易
      return tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.ADJUSTMENT,
          amount: amountDecimal,
          balanceBefore,
          balanceAfter,
          description: reason,
          createdBy: operatorId,
        },
      });
    });
  }

  /**
   * 管理员充值（后台运营充值）
   */
  async adminDeposit(
    enterpriseId: string,
    amount: number,
    reason: string,
    operatorId: string,
  ) {
    if (amount <= 0) {
      throw new BadRequestException("充值金额必须大于 0");
    }

    // 历史企业可能没有对应的钱包记录；后台充值应自动补齐，避免运营端只能看到“钱包不存在”。
    await this.ensureWalletExists(enterpriseId);

    return this.prisma.$transaction(async (tx) => {
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      const wallet = await tx.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);
      const balanceAfter = balanceBefore.add(amountDecimal);

      // 更新余额
      const updated = await tx.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version,
        },
        data: {
          balance: balanceAfter,
          totalDeposit: { increment: amountDecimal },
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 记录交易
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.DEPOSIT,
          amount: amountDecimal,
          balanceBefore,
          balanceAfter,
          paymentMethod: "admin",
          description: reason,
          createdBy: operatorId,
        },
      });

      return {
        ...transaction,
        balance: balanceAfter.toNumber(),
      };
    });
  }

  /**
   * 管理员扣减（后台运营扣款）
   */
  async adminDeduct(
    enterpriseId: string,
    amount: number,
    reason: string,
    operatorId: string,
  ) {
    if (amount <= 0) {
      throw new BadRequestException("扣减金额必须大于 0");
    }

    // 与充值保持一致：先确保钱包存在，再在事务内进行余额校验和更新。
    await this.ensureWalletExists(enterpriseId);

    return this.prisma.$transaction(async (tx) => {
      await assertActiveEnterpriseInTx(tx, enterpriseId);
      const wallet = await tx.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });

      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const balanceBefore = wallet.balance;
      const amountDecimal = new Decimal(amount);

      // 检查余额
      if (balanceBefore.lessThan(amountDecimal)) {
        throw new BadRequestException(
          `余额不足。当前余额: ¥${balanceBefore}，需要扣减: ¥${amount}`,
        );
      }

      const balanceAfter = balanceBefore.sub(amountDecimal);

      // 更新余额
      const updated = await tx.enterpriseWallet.updateMany({
        where: {
          enterpriseId,
          version: wallet.version,
        },
        data: {
          balance: balanceAfter,
          totalConsume: { increment: amountDecimal },
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        throw new ConflictException("余额更新冲突，请重试");
      }

      // 记录交易（负数）
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.CONSUME,
          amount: amountDecimal.neg(),
          balanceBefore,
          balanceAfter,
          relatedType: "compute",
          description: reason,
          createdBy: operatorId,
        },
      });

      return {
        ...transaction,
        balance: balanceAfter.toNumber(),
      };
    });
  }

  /**
   * 算力消费扣款：「有多少扣多少」，不足的差额如实返回给调用方。
   *
   * 与 consume() 的区别是刻意的 —— consume() 面向订阅付费这类「付不起就不该成交」
   * 的场景，余额不足直接抛错；本方法面向**已经发生**的模型调用：对话已经产生了
   * 真实成本，抛错会连事实一起回滚。所以这里扣到 0 为止，把差额交给
   * ComputeUsageRecord.unpaidCNY 记账，由对话前的余额检查负责拦下后续调用。
   *
   * 必须在调用方事务内执行：赠送余额扣减与钱包扣减要么同时成立，要么同时失败。
   */
  async consumeComputeUpTo(
    client: Prisma.TransactionClient,
    enterpriseId: string,
    amount: Decimal,
    meta: {
      relatedId?: string | null;
      relatedType?: string;
      createdBy?: string | null;
      description: string;
    },
  ): Promise<{
    transactionId: string | null;
    paid: Decimal;
    unpaid: Decimal;
  }> {
    if (amount.lessThanOrEqualTo(0)) {
      return { transactionId: null, paid: new Decimal(0), unpaid: new Decimal(0) };
    }

    await assertActiveEnterpriseInTx(client, enterpriseId);
    const wallet = await client.enterpriseWallet.findUnique({
      where: { enterpriseId },
    });
    if (!wallet) {
      throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
    }

    const balanceBefore = wallet.balance;
    const paid = Decimal.min(balanceBefore, amount);
    const unpaid = amount.sub(paid);

    if (paid.lessThanOrEqualTo(0)) {
      return { transactionId: null, paid: new Decimal(0), unpaid: amount };
    }

    const balanceAfter = balanceBefore.sub(paid);

    // 专款先花 —— 这笔钱本来就是为对话预留的。专款用尽后继续动自由余额，
    // 对话不会因为「专款见底」而中断（能不能继续由总余额决定，与标签无关）。
    const fromReserved = Decimal.min(wallet.computeReservedCNY, paid);

    const updated = await client.enterpriseWallet.updateMany({
      where: { enterpriseId, version: wallet.version },
      data: {
        balance: balanceAfter,
        computeReservedCNY: wallet.computeReservedCNY.sub(fromReserved),
        totalConsume: { increment: paid },
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      // 让调用方重试整笔扣费；幂等键保证重试不会重复入账
      throw new ConflictException("余额更新冲突，请重试");
    }

    const transaction = await client.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: WalletTransactionType.CONSUME,
        amount: paid.neg(),
        balanceBefore,
        balanceAfter,
        relatedType: meta.relatedType ?? "compute",
        relatedId: meta.relatedId ?? null,
        createdBy: meta.createdBy ?? null,
        description: meta.description,
      },
    });

    return { transactionId: transaction.id, paid, unpaid };
  }

  /** 足额扣除企业算力专款，用于给成员充值；不能自动绕到普通企业余额。 */
  async consumeForMemberTopUp(
    client: Prisma.TransactionClient,
    enterpriseId: string,
    amount: Decimal,
    meta: { relatedId?: string | null; relatedType?: string; createdBy?: string | null; description: string },
  ): Promise<{ transactionId: string }> {
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException("充值金额必须大于 0");
    await assertActiveEnterpriseInTx(client, enterpriseId);
    const wallet = await client.enterpriseWallet.findUnique({ where: { enterpriseId } });
    if (!wallet) throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
    if (wallet.computeReservedCNY.lessThan(amount)) {
      throw new BadRequestException(
        `企业算力余额不足。当前可用 ¥${wallet.computeReservedCNY.toFixed(2)}，需要 ¥${amount.toFixed(2)}；请先给企业钱包充值并划入算力余额`,
      );
    }
    const balanceAfter = wallet.balance.sub(amount);
    const computeReservedAfter = wallet.computeReservedCNY.sub(amount);
    const updated = await client.enterpriseWallet.updateMany({
      where: { enterpriseId, version: wallet.version },
      data: {
        balance: balanceAfter,
        computeReservedCNY: computeReservedAfter,
        totalConsume: { increment: amount },
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) throw new ConflictException("余额更新冲突，请重试");
    const transaction = await client.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: WalletTransactionType.CONSUME,
        amount: amount.neg(),
        balanceBefore: wallet.balance,
        balanceAfter,
        relatedType: meta.relatedType ?? "member_compute_top_up",
        relatedId: meta.relatedId ?? null,
        createdBy: meta.createdBy ?? null,
        description: meta.description,
      },
    });
    return { transactionId: transaction.id };
  }

  // ── 算力专款（钱包内的用途标签，不是第二本账）────────────────────────────

  /**
   * 钱包自由余额 → 算力专款。
   *
   * 刻意不新开一张账户表：企业的钱只有一处（EnterpriseWallet.balance），
   * 划入只是给其中一部分贴上「只能用于与硅基员工对话」的标签。
   * 这样就不必回答「转入失败怎么回滚」「退订的钱退到哪一边」这类
   * 双账本才有的问题，而企业要的效果（订阅费吃不掉算力的钱）已经拿到。
   */
  async reserveForCompute(
    enterpriseId: string,
    amount: number,
    operatorId?: string,
  ) {
    return this.moveComputeReserve(enterpriseId, amount, "RESERVE", operatorId);
  }

  /** 算力专款 → 钱包自由余额（划多了要能划回来，否则没人敢划）。 */
  async releaseFromCompute(
    enterpriseId: string,
    amount: number,
    operatorId?: string,
  ) {
    return this.moveComputeReserve(enterpriseId, amount, "RELEASE", operatorId);
  }

  private async moveComputeReserve(
    enterpriseId: string,
    amount: number,
    direction: "RESERVE" | "RELEASE",
    operatorId?: string,
  ) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("划转金额必须大于 0");
    }
    const delta = new Decimal(amount);

    return this.prisma.$transaction(async (client) => {
      await assertActiveEnterpriseInTx(client, enterpriseId);
      const wallet = await client.enterpriseWallet.findUnique({
        where: { enterpriseId },
      });
      if (!wallet) {
        throw new NotFoundException(`企业钱包不存在: ${enterpriseId}`);
      }

      const reservedBefore = wallet.computeReservedCNY;
      const spendable = wallet.balance.sub(reservedBefore);

      if (direction === "RESERVE" && spendable.lessThan(delta)) {
        throw new BadRequestException(
          `可划入金额不足。钱包余额 ¥${wallet.balance}，已划入专款 ¥${reservedBefore}，本次最多可划入 ¥${spendable}`,
        );
      }
      if (direction === "RELEASE" && reservedBefore.lessThan(delta)) {
        throw new BadRequestException(
          `可划回金额不足。算力专款余额 ¥${reservedBefore}，本次请求 ¥${amount}`,
        );
      }

      const reservedAfter =
        direction === "RESERVE"
          ? reservedBefore.add(delta)
          : reservedBefore.sub(delta);

      const updated = await client.enterpriseWallet.updateMany({
        where: { enterpriseId, version: wallet.version },
        data: {
          computeReservedCNY: reservedAfter,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException("算力专款更新冲突，请重试");
      }

      // 余额没变，动的是用途标签 —— 所以 before == after，
      // amount 记的是标签的增减（正数划入、负数划回），便于对账时区分。
      await client.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type:
            direction === "RESERVE"
              ? WalletTransactionType.COMPUTE_RESERVE
              : WalletTransactionType.COMPUTE_RELEASE,
          amount: direction === "RESERVE" ? delta : delta.neg(),
          balanceBefore: wallet.balance,
          balanceAfter: wallet.balance,
          relatedType: "compute",
          description:
            direction === "RESERVE"
              ? `划入算力专款 ¥${amount}`
              : `算力专款划回钱包 ¥${amount}`,
          createdBy: operatorId ?? null,
        },
      });

      return {
        balance: wallet.balance,
        computeReservedCNY: reservedAfter,
        spendableCNY: wallet.balance.sub(reservedAfter),
      };
    });
  }

  /**
   * 确保企业钱包存在（不存在则创建）。
   * 公开是因为扣费链路必须在进入事务前保证钱包存在 ——
   * 事务内再建钱包会和乐观锁的版本比对纠缠在一起。
   */
  async ensureWalletExists(enterpriseId: string) {
    return this.ensureWallet(enterpriseId);
  }

  /**
   * 确保企业钱包存在（不存在则创建）
   */
  private async ensureWallet(enterpriseId: string) {
    let wallet = await this.prisma.enterpriseWallet.findUnique({
      where: { enterpriseId },
    });

    if (!wallet) {
      wallet = await this.prisma.$transaction(async (tx) => {
        await assertActiveEnterpriseInTx(tx, enterpriseId);
        const existing = await tx.enterpriseWallet.findUnique({ where: { enterpriseId } });
        return existing ?? tx.enterpriseWallet.create({ data: { enterpriseId } });
      });
    }

    return wallet;
  }
}
