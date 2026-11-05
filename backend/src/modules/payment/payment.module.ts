import { Module } from "@nestjs/common";
import { OrderController } from "./order.controller";
import { PaymentController } from "./payment.controller";
import { PersonalRechargeController } from "./personal-recharge.controller";
import { WalletController } from "../wallet/wallet.controller";
import { OrderService } from "./order.service";
import { PaymentService } from "./payment.service";
import { AlipayProvider } from "./alipay.provider";
import { PrismaModule } from "../../prisma/prisma.module";
import { EnterpriseModule } from "../enterprise/enterprise.module";
import { ComputeModule } from "../compute/compute.module";
import { WalletModule } from "../wallet/wallet.module";
import { SubscriptionFulfillmentModule } from "../subscription-fulfillment/subscription-fulfillment.module";
import { PersonalWalletModule } from "../personal-wallet/personal-wallet.module";
import { EmployeeBundleModule } from "../employee-bundle/employee-bundle.module";

@Module({
  imports: [
    PrismaModule,
    EnterpriseModule,
    SubscriptionFulfillmentModule,
    ComputeModule,
    WalletModule,
    // 单向依赖：PersonalWalletModule 只 import PrismaModule，不会回头依赖这里。
    // 不用 forwardRef —— 加了会掩盖将来真的成环。
    PersonalWalletModule,
    EmployeeBundleModule,
  ],
  // WalletController 依赖 PaymentService 创建充值订单，因此由已导入 PaymentModule 负责装配，
  // 避免 WalletModule 与 PaymentModule 互相 import 造成 Nest DI 循环。
  controllers: [OrderController, PaymentController, PersonalRechargeController, WalletController],
  providers: [OrderService, PaymentService, AlipayProvider],
  exports: [OrderService, PaymentService],
})
export class PaymentModule {}
