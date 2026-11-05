import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SubscriptionFulfillmentModule } from '../subscription-fulfillment/subscription-fulfillment.module';
import {
  EmployeeBundleAdminController,
  EmployeeBundleController,
} from './employee-bundle.controller';
import { EmployeeBundleService } from './employee-bundle.service';
import { EmployeeBundleEditorService } from './employee-bundle-editor.service';
import { EmployeeCopyDraftService } from '../admin/employee-copy-draft.service';
import { SettingModule } from '../setting/setting.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [PrismaModule, SubscriptionFulfillmentModule, SettingModule, UploadModule],
  controllers: [
    EmployeeBundleController,
    EmployeeBundleAdminController,
  ],
  providers: [EmployeeBundleService, EmployeeBundleEditorService, EmployeeCopyDraftService],
  exports: [EmployeeBundleService],
})
export class EmployeeBundleModule {}
