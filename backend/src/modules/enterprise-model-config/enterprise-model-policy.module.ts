import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EnterpriseModelConfigService } from './enterprise-model-config.service';
import { ModelModule } from '../model/model.module';

// Keep policy consumers independent of enterprise controllers and employee runners.
@Module({
  imports: [PrismaModule, ModelModule],
  providers: [EnterpriseModelConfigService],
  exports: [EnterpriseModelConfigService],
})
export class EnterpriseModelPolicyModule {}
