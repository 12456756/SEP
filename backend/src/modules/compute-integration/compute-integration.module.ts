import { Global, Module } from '@nestjs/common';
import { ComputeCredentialRotationController } from './compute-credential-rotation.controller';
import { ComputeCredentialRotationService } from './compute-credential-rotation.service';
import { ComputeCredentialRotationRemote } from './compute-credential-rotation.remote';
import { SettingModule } from '../setting/setting.module';
import { RedisModule } from '../../redis/redis.module';
import { ComputeBalanceSignatureGuard } from './compute-balance-signature.guard';
import { ComputeBalanceSyncService } from './compute-balance-sync.service';
import { ComputeBalanceSyncWorker } from './compute-balance-sync.worker';
import { ComputeBalanceSyncController, ComputeBalanceWebhookController } from './compute-balance-sync.controller';
import { ComputeIntegrationService } from './compute-integration.service';
import { ComputeRemoteAdapter } from './compute-remote.adapter';
import { ComputeConnectionService } from './compute-connection.service';
import { ComputeIntegrationWorker } from './compute-integration.worker';
import { ComputeAccountingService } from './compute-accounting.service';
import { ComputeModelCatalogService } from './compute-model-catalog.service';
import { ComputeProtocolClient } from './compute-protocol.client';
import { ComputeModelTransportService } from './compute-model-transport.service';
import { ComputeFundsService } from './compute-funds.service';
import { ComputeSpendingPolicyService } from './compute-spending-policy.service';
import { ComputePasswordSyncService } from './compute-password-sync.service';
import { ComputeMediaService } from './compute-media.service';
import { ComputeReconciliationWorker } from './compute-reconciliation.worker';
import { ComputeIntegrationController, EnterpriseComputeIntegrationController } from './compute-integration.controller';

@Global()
@Module({
  imports: [SettingModule, RedisModule],
  controllers: [ComputeCredentialRotationController, ComputeBalanceWebhookController, ComputeBalanceSyncController, ComputeIntegrationController, EnterpriseComputeIntegrationController],
  providers: [ComputeCredentialRotationService, ComputeCredentialRotationRemote, ComputeSpendingPolicyService, ComputePasswordSyncService, ComputeBalanceSignatureGuard, ComputeBalanceSyncService, ComputeBalanceSyncWorker, ComputeReconciliationWorker, ComputeMediaService, ComputeFundsService, ComputeModelTransportService, ComputeProtocolClient, ComputeRemoteAdapter, ComputeIntegrationService, ComputeConnectionService, ComputeIntegrationWorker, ComputeAccountingService, ComputeModelCatalogService],
  exports: [ComputePasswordSyncService, ComputeMediaService, ComputeFundsService, ComputeProtocolClient, ComputeRemoteAdapter, ComputeIntegrationService, ComputeConnectionService, ComputeAccountingService, ComputeModelCatalogService],
})
export class ComputeIntegrationModule {}
