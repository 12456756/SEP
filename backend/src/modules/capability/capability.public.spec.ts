import { CapabilityService } from './capability.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdapterFactory } from './adapters/adapter.factory';

describe('CapabilityService public projection', () => {
  it('requests only approved capabilities and excludes skill and model secrets', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'capability-1',
      status: 'APPROVED',
      skillConfig: { id: 'skill-config-1' },
    });
    const prisma = { capability: { findFirst } };
    const skillVersionService = {} as any;
    const service = new CapabilityService(
      prisma as unknown as PrismaService,
      {} as AdapterFactory,
      skillVersionService,
    );

    const result = await service.findOne('capability-1');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'capability-1',
          OR: [
            { visibility: 'MARKET_PUBLIC', platformReviewStatus: 'APPROVED', status: 'APPROVED' },
            { enterpriseId: null, status: 'APPROVED' },
          ],
        },
        include: expect.objectContaining({
          skillConfig: { select: { id: true } },
          agentConfig: {
            select: expect.not.objectContaining({ apiKey: expect.anything() }),
          },
        }),
      }),
    );
    expect(result.skillConfig).toEqual({ id: 'skill-config-1' });
    expect(result.skillConfig).not.toHaveProperty('template');
    expect(result.skillConfig).not.toHaveProperty('modelId');
    expect(result.skillConfig).not.toHaveProperty('temperature');
    expect(result.skillConfig).not.toHaveProperty('maxTokens');
  });
});
