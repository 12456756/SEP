import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminUploadController } from './admin-upload.controller';
import { AdminService } from './admin.service';
import { WalletModule } from '../wallet/wallet.module';
import { SkillPackageModule } from '../skill-package/skill-package.module';
import { SettingModule } from '../setting/setting.module';
import { PersonalWalletModule } from '../personal-wallet/personal-wallet.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthService } from './admin-auth.service';
import { CapabilityContributionModule } from '../capability-contribution/capability-contribution.module';
import { EmployeeReadinessModule } from '../digital-employee/employee-readiness.module';
import { EmployeeCopyDraftService } from './employee-copy-draft.service';

@Module({
  imports: [
    WalletModule,
    SkillPackageModule,
    SettingModule,
    PersonalWalletModule,
    AuthModule,
    CapabilityContributionModule,
    EmployeeReadinessModule,
  ],
  controllers: [AdminController, AdminUploadController],
  providers: [AdminService, AdminAuthService, EmployeeCopyDraftService],
  exports: [AdminService, AdminAuthService],
})
export class AdminModule {}
