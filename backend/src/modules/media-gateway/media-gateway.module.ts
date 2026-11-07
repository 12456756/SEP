import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { SettingModule } from '../setting/setting.module';
import { MediaConfigModule } from '../media-config/media-config.module';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { GatewayAuthRateLimitService } from '../gateway/gateway-auth-rate-limit.service';
import { MediaGatewayController } from './media-gateway.controller';
import { MediaGatewayMockAdapter } from './media-gateway-mock.adapter';
import { MediaGatewayMockGuard } from './media-gateway-mock.guard';
import { MediaGatewayService } from './media-gateway.service';
import { MediaGatewayStore } from './media-gateway.store';
import { MediaRealController } from './media-real.controller';
import { MediaRealGuard } from './media-real.guard';
import { MediaRealService } from './media-real.service';
import { MediaRealStore } from './media-real.store';
import { MediaRealBillingService } from './media-real-billing.service';
import { MediaByteCacheService } from './media-byte-cache.service';
import { MediaVideoGatewayController } from './media-video-gateway.controller';
import { MediaVideoGatewayService } from './media-video-gateway.service';
import { MediaVideoGatewayStore } from './media-video-gateway.store';
import { MediaVideoRealController } from './media-video-real.controller';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { MediaVideoRealGuard } from './media-video-real.guard';

@Module({
  imports: [ConfigModule, JwtModule.register({}), PrismaModule, RedisModule, AuthModule, SettingModule, MediaConfigModule],
  controllers: [MediaGatewayController, MediaRealController, MediaVideoGatewayController, MediaVideoRealController],
  providers: [ClientEmploymentGuard, GatewayAuthRateLimitService, MediaGatewayMockGuard, MediaGatewayMockAdapter, MediaGatewayStore, MediaGatewayService,
    MediaRealGuard, MediaRealService, MediaRealStore, MediaRealBillingService, MediaByteCacheService, MediaVideoGatewayStore,
    MediaVideoRealService, MediaVideoRealStore, MediaVideoRealGuard,
    {
      provide: MediaVideoGatewayService,
      useFactory: (prisma: PrismaService, store: MediaVideoGatewayStore, configuration: MediaVideoConfigService) =>
        new MediaVideoGatewayService(prisma, store, configuration),
      inject: [PrismaService, MediaVideoGatewayStore, MediaVideoConfigService],
    }],
  exports: [MediaRealBillingService, MediaByteCacheService, MediaConfigModule],
})
export class MediaGatewayModule {}
