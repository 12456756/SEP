import { Module } from '@nestjs/common';
import { ModelController } from './model.controller';
import { ModelService } from './model.service';
import { ModelBillingService } from './model-billing.service';
import { SettingModule } from '../setting/setting.module';

@Module({
  imports: [SettingModule],
  controllers: [ModelController],
  providers: [ModelService, ModelBillingService],
  exports: [ModelService, ModelBillingService],
})
export class ModelModule {}
