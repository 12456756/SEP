import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SkillPackageModule } from '../skill-package/skill-package.module';
import { CapabilityContributionModule } from '../capability-contribution/capability-contribution.module';
import { SkillImportController } from './skill-import.controller';
import { SkillImportConnectorController } from './skill-import-connector.controller';
import { SkillImportService } from './skill-import.service';
import { SkillImportStore } from './skill-import-store';
import { SkillImportUploadGuard } from './skill-import-upload.guard';
import { SkillImportUploadInterceptor } from './skill-import-upload.interceptor';
import { SkillImportResponseInterceptor } from './skill-import-response.interceptor';

@Module({
  imports: [AuthModule, SkillPackageModule, CapabilityContributionModule],
  controllers: [SkillImportController, SkillImportConnectorController],
  providers: [SkillImportService, SkillImportStore, SkillImportUploadGuard, SkillImportUploadInterceptor, SkillImportResponseInterceptor],
  exports: [SkillImportService],
})
export class SkillImportModule {}
