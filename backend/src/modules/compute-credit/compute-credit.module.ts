import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { WalletModule } from "../wallet/wallet.module";
import { SettingModule } from "../setting/setting.module";
import { PersonalWalletModule } from "../personal-wallet/personal-wallet.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ComputeCreditService } from "./compute-credit.service";
import { ComputeCreditController } from "./compute-credit.controller";
import { MemberAllowanceService } from "./member-allowance.service";
import { MemberAllowanceQueryService } from "./member-allowance-query.service";
import { UsageAnalyticsService } from "./usage-analytics.service";
import { AllowanceNotifierService } from "./allowance-notifier.service";
import { ModelModule } from '../model/model.module';

/**
 * 统一人民币算力账本。订阅履约、对话计费、企业算力查询都经过这里，
 * 所以它被 SubscriptionModule / PaymentModule / ConversationModule 共同依赖。
 *
 * WalletModule 必须用 forwardRef 引入。存在一条模块环：
 *   WalletModule → PaymentModule → SubscriptionFulfillmentModule
 *                → ComputeCreditModule → WalletModule
 * 直接写 `WalletModule` 会在 wallet.module.ts 求值途中再次读取它，
 * 触发 `Cannot access 'WalletModule' before initialization`。
 * forwardRef 把引用推迟到箭头函数里执行，绕开这个时序 ——
 * 与本仓库 wallet/payment/compute 三角已有的处理方式一致。
 *
 * 注意这只影响**模块**引用：ComputeCreditService 直接注入 WalletService 即可，
 * wallet.service.ts 本身不在环上。
 *
 * PersonalWalletModule 不需要 forwardRef：它只依赖 PrismaModule，
 * 单向被本模块引入（额度用尽改道自费时要读个人余额），没给环加新边。
 * NotificationsModule 同理（只依赖 PrismaModule + JwtModule），
 * 额度类通知靠它发出去。
 */
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => WalletModule),
    SettingModule,
    PersonalWalletModule,
    NotificationsModule,
    ModelModule,
  ],
  controllers: [ComputeCreditController],
  providers: [
    ComputeCreditService,
    MemberAllowanceService,
    MemberAllowanceQueryService,
    UsageAnalyticsService,
    AllowanceNotifierService,
  ],
  exports: [
    ComputeCreditService,
    MemberAllowanceService,
    MemberAllowanceQueryService,
    UsageAnalyticsService,
    AllowanceNotifierService,
  ],
})
export class ComputeCreditModule {}
