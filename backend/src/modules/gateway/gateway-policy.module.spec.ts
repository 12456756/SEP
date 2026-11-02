import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { GatewayAdmissionService } from './gateway-admission.service';
import { GatewayModelPolicyService } from './gateway-model-policy.service';
import { GatewayPolicyModule } from './gateway-policy.module';
import { GatewayModule } from './gateway.module';
import { policySnapshot } from './gateway-policy.test-fixtures';

@Injectable()
class Consumer {
  constructor(readonly admission: GatewayAdmissionService, readonly policy: GatewayModelPolicyService) {}
}
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), GatewayPolicyModule], providers: [Consumer] })
class ConsumerModule {}

describe('GatewayPolicyModule registration', () => {
  it('exports real admission and output services to another module without gateway controllers', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 0, 0, 720000, 1720000]);
    const module = await Test.createTestingModule({ imports: [ConsumerModule] })
      .overrideProvider(RedisService).useValue({ redis: { eval: evalMock } })
      .overrideProvider(PrismaService).useValue({})
      .overrideProvider(EnterpriseModelConfigService).useValue({})
      .overrideProvider(ConfigService).useValue({ get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('test-secret') })
      .compile();
    try {
      const consumer = module.get(Consumer);
      expect(consumer.admission).toBeInstanceOf(GatewayAdmissionService);
      expect(consumer.policy).toBeInstanceOf(GatewayModelPolicyService);
      const snapshot = policySnapshot();
      const lease = await consumer.admission.acquire({ enterpriseId: 'enterprise', memberId: 'member' }, snapshot);
      expect(consumer.policy.internalOutputTokens(null, snapshot, 4000)).toBe(4000);
      evalMock.mockResolvedValue(1);
      await lease.release();
      expect(evalMock).toHaveBeenCalledTimes(2);
      expect(Reflect.getMetadata('imports', GatewayModule)).toContain(GatewayPolicyModule);
    } finally { await module.close(); }
  });
});
