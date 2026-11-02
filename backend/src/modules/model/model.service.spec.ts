import { NotFoundException } from '@nestjs/common';
import { UpdatePlatformModelDtoSchema } from 'shared';
import { ModelService } from './model.service';

describe('ModelService admin model settings', () => {
  const model = {
    id: 'platform-model-1',
    modelId: 'model-a',
    label: 'Model A',
    enabled: true,
    isFree: false,
    sortOrder: 0,
  };
  const prisma = {
    platformModel: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const service = new ModelService(prisma as never, {} as never, {} as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.platformModel.findUnique.mockResolvedValue(model);
    prisma.platformModel.update.mockImplementation(({ data }: { data: Partial<typeof model> }) =>
      Promise.resolve({ ...model, ...data }),
    );
  });

  it('persists the free flag independently of enablement', async () => {
    await service.updateModel(model.id, { isFree: true });

    expect(prisma.platformModel.update).toHaveBeenCalledWith({
      where: { id: model.id },
      data: { isFree: true },
    });
  });


  it('rejects an unknown platform model', async () => {
    prisma.platformModel.findUnique.mockResolvedValue(null);

    await expect(service.updateModel('missing', { isFree: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.platformModel.update).not.toHaveBeenCalled();
  });

  it('sync preserves the operator free-campaign flag', async () => {
    jest.spyOn(service, 'listUpstream').mockResolvedValue([{ id: 'model-a', label: 'Model A' }]);
    prisma.platformModel.findMany.mockResolvedValue([{ ...model, isFree: true, isStale: false }]);

    await service.syncFromUpstream();

    expect(prisma.platformModel.update).toHaveBeenCalledWith({
      where: { id: model.id },
      data: { lastSeenAt: expect.any(Date), isStale: false },
    });
    expect(prisma.platformModel.update.mock.calls[0][0].data).not.toHaveProperty('isFree');
  });

  it.each([
    { isFree: 'true' },
    { isFree: null },
    { isFree: true, extra: 'rejected' },
  ])('rejects invalid update payload %#', (payload) => {
    expect(() => UpdatePlatformModelDtoSchema.parse(payload)).toThrow();
  });
});
