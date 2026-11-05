import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/users/user.module';
import { CapabilityModule } from './modules/capability/capability.module';
import { DigitalEmployeeModule } from './modules/digital-employee/digital-employee.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { SettingModule } from './modules/setting/setting.module';
import { ModelModule } from './modules/model/model.module';
import { EnterpriseModule } from './modules/enterprise/enterprise.module';
import { ClientModule } from './modules/client/client.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { AdminModule } from './modules/admin/admin.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { ComputeModule } from './modules/compute/compute.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MailModule } from './modules/mail/mail.module';
import { EnterpriseModelConfigModule } from './modules/enterprise-model-config/enterprise-model-config.module';
import { CostAnalyticsModule } from './modules/cost-analytics/cost-analytics.module';
import { EnterpriseSettingsModule } from './modules/enterprise-settings/enterprise-settings.module';
import { CartModule } from './modules/cart/cart.module';
import { PaymentModule } from './modules/payment/payment.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { UploadModule } from './modules/upload/upload.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PersonalWalletModule } from './modules/personal-wallet/personal-wallet.module';
import { SubscriptionRequestModule } from './modules/subscription-request/subscription-request.module';
import { ComputeQuotaModule } from './modules/compute-quota/compute-quota.module';
import { ComputeCreditModule } from './modules/compute-credit/compute-credit.module';
import { SubscriptionFulfillmentModule } from './modules/subscription-fulfillment/subscription-fulfillment.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SkillVersionModule } from './modules/skill-version/skill-version.module';
import { CapabilityInsightModule } from './modules/capability-insight/capability-insight.module';
import { TaskPlanningModule } from './modules/task-planning/task-planning.module';
import { CapabilityContributionModule } from './modules/capability-contribution/capability-contribution.module';
import { TaskModule } from './modules/task/task.module';
import { TaskExecutionModule } from './modules/task-execution/task-execution.module';
import { AuditModule } from './modules/audit/audit.module';
import { SecurityModule } from './modules/security/security.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { HealthModule } from './health/health.module';
import { employeeAssetBaseUrl } from './common/employee-avatar';
import { validateAuthEnvironment } from './auth-environment';
import { GatewayLifecycleModule } from './common/lifecycle/gateway-lifecycle.module';
import { MediaConfigModule } from './modules/media-config/media-config.module';
import { MediaGatewayModule } from './modules/media-gateway/media-gateway.module';
import { SkillImportModule } from './modules/skill-import/skill-import.module';
import { EmployeeBundleModule } from './modules/employee-bundle/employee-bundle.module';
import { validateSkillImportEnvironment } from './skill-import-environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
      validate: (env) => {
        employeeAssetBaseUrl(env);
        return validateSkillImportEnvironment(validateAuthEnvironment(env));
      },
    }),
    GatewayLifecycleModule,
    // 安全模块（全局限流、日志脱敏、异常处理）
    SecurityModule,
    // 监控告警模块（指标收集、健康检查、告警）
    MonitoringModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    CapabilityModule,
    DigitalEmployeeModule,
    SubscriptionModule,
    ConversationModule,
    SettingModule,
    ModelModule,
    EnterpriseModule,
    ClientModule,
    GatewayModule,
    AdminModule,
    KnowledgeModule,
    ComputeModule,
    NotificationsModule,
    MailModule,
    EnterpriseModelConfigModule,
    MediaConfigModule,
    MediaGatewayModule,
    SkillImportModule,
    EmployeeBundleModule,
    CostAnalyticsModule,
    EnterpriseSettingsModule,
    CartModule,
    PaymentModule,
    AnnouncementModule,
    UploadModule,
    WalletModule,
    PersonalWalletModule,
    SubscriptionRequestModule,
    ComputeQuotaModule,
    ComputeCreditModule,
    SubscriptionFulfillmentModule,
    DashboardModule,
    SkillVersionModule,
    CapabilityInsightModule,
    TaskPlanningModule,
    CapabilityContributionModule,
    TaskModule,
    // 注册顺序在 TaskModule 之后：两者共用 `tasks` 前缀，具体路由（:id/run、
    // :id/stream）与 TaskModule 的 :id 不冲突，但把执行相关的放在后面更符合
    // 「CRUD 是底座，执行是上层」的读法。
    TaskExecutionModule,
    AuditModule,
    HealthModule,
  ],
  controllers: [],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
