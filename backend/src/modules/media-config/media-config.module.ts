import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SettingModule } from '../setting/setting.module';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { MediaConfigController } from './media-config.controller';
import { MediaConfigService } from './media-config.service';
import { Sub2apiImageAdapter } from '../media-gateway/sub2api-image.adapter';
import { MediaVideoConfigController } from './media-video-config.controller';
import { MediaVideoConfigService } from './media-video-config.service';
import { Sub2apiVideoAdapter } from '../media-gateway/sub2api-video.adapter';
import { VideoFileCacheService } from '../media-gateway/video-file-cache.service';
import { MediaModelSyncService } from './media-model-sync.service';
import { ComputeIntegrationModule } from '../compute-integration/compute-integration.module';

@Module({
  imports: [PrismaModule, SettingModule, EnterpriseModule, ComputeIntegrationModule],
  controllers: [MediaConfigController, MediaVideoConfigController],
  providers: [MediaConfigService, MediaVideoConfigService, MediaModelSyncService, Sub2apiImageAdapter, Sub2apiVideoAdapter, VideoFileCacheService],
  exports: [MediaConfigService, MediaVideoConfigService, Sub2apiImageAdapter, Sub2apiVideoAdapter, VideoFileCacheService],
})
export class MediaConfigModule {}
