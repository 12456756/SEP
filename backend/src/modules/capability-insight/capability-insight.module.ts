import { Module } from '@nestjs/common';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { SettingModule } from '../setting/setting.module';
import { EnterpriseModelConfigModule } from '../enterprise-model-config/enterprise-model-config.module';
import { SkillVersionModule } from '../skill-version/skill-version.module';
import { CapabilityInsightController } from './capability-insight.controller';
import { CapabilityInsightService } from './capability-insight.service';
import { GatewayPolicyModule } from '../gateway/gateway-policy.module';
import { ComputeCreditModule } from '../compute-credit/compute-credit.module';

@Module({
  imports: [
    ComputeCreditModule,
    EnterpriseModule,
    SkillVersionModule,
    SettingModule,
    EnterpriseModelConfigModule,
    GatewayPolicyModule,
  ],
  controllers: [CapabilityInsightController],
  providers: [CapabilityInsightService],
})
export class CapabilityInsightModule {}
