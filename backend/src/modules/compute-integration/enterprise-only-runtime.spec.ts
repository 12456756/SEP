import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayService } from '../gateway/gateway.service';
import { policySnapshot } from '../gateway/gateway-policy.test-fixtures';
import { MediaRealService } from '../media-gateway/media-real.service';
import { MediaVideoRealService } from '../media-gateway/media-video-real.service';
import { ComputeMediaService } from './compute-media.service';

describe('Enterprise model credentials are mandatory', () => {
  const failure = new ServiceUnavailableException({ code: 'COMPUTE_ENTERPRISE_NOT_ENABLED', message: 'Enterprise connection is not activated' });
  const claims = { enterpriseId: 'enterprise', sub: 'user', memberId: 'member', subscriptionId: 'subscription' } as any;

  it('blocks a gateway request before fetch without reading the administrator key', async () => {
    const settings = { getEffectiveValue: jest.fn().mockResolvedValue('administrator-key') };
    const connections = { chatProvider: jest.fn().mockRejectedValue(failure) };
    const service = new GatewayService({} as never, new ConfigService(), settings as never, {} as never, {} as never, connections as never);
    const upstream = jest.spyOn(global, 'fetch');
    try {
      await expect(service.forwardChatCompletion({ model: 'model', messages: [{ role: 'user', content: 'test' }] }, policySnapshot(), undefined,
        undefined, { ...claims, userId: claims.sub, employeeId: 'employee', gatewayId: 'gateway' })).rejects.toBe(failure);
      expect(settings.getEffectiveValue).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
    } finally { upstream.mockRestore(); }
  });

  it('uses the selected enterprise signed transport and credential', async () => {
    const signedFetch = jest.fn().mockResolvedValue(new Response('{}'));
    const connections = { chatProvider: jest.fn().mockResolvedValue({ baseURL: 'https://enterprise.invalid/v1', apiKey: 'enterprise-key', fetch: signedFetch }) };
    const settings = { getEffectiveValue: jest.fn().mockResolvedValue('administrator-key') };
    const service = new GatewayService({} as never, new ConfigService(), settings as never, {} as never, {} as never, connections as never);
    const response = await service.forwardChatCompletion({ model: 'model', messages: [{ role: 'user', content: 'test' }] }, policySnapshot(), undefined,
      undefined, { ...claims, userId: claims.sub, employeeId: 'employee', gatewayId: 'gateway' });
    await response.text();
    expect(signedFetch).toHaveBeenCalledWith('https://enterprise.invalid/v1/chat/completions', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer enterprise-key' }),
    }));
    expect(settings.getEffectiveValue).not.toHaveBeenCalled();
  });

  it.each(['image', 'video'] as const)('blocks new %s operations before the administrator adapter can run', async kind => {
    const adapter = { pricing: jest.fn(), connection: jest.fn(), execute: jest.fn(), submit: jest.fn() };
    const connections = { assertEnterpriseModeSupported: jest.fn().mockRejectedValue(failure), resolve: jest.fn().mockRejectedValue(failure) };
    const config = { get: () => 'true' };
    const service = kind === 'image'
      ? new MediaRealService(config as never, {} as never, {} as never, {} as never, adapter as never,
        {} as never, {} as never, {} as never, connections as never, {} as never)
      : new MediaVideoRealService(config as never, {} as never, {} as never, {} as never, adapter as never,
        {} as never, {} as never, {} as never, connections as never, {} as never);
    await expect(service.quote(claims, {} as never)).rejects.toBe(failure);
    for (const call of Object.values(adapter)) expect(call).not.toHaveBeenCalled();
  });

  it.each(['image', 'video'] as const)('media %s connection errors never return a null platform fallback', async kind => {
    const connections = { resolve: jest.fn().mockRejectedValue(failure) };
    const service = new ComputeMediaService({} as never, connections as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.connection('enterprise', kind)).rejects.toBe(failure);
  });
});
