import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
    jest.restoreAllMocks();
    jest.clearAllMocks();
    prisma.platformModel.findUnique.mockResolvedValue(model);
    prisma.platformModel.update.mockImplementation(({ data }: { data: Partial<typeof model> }) =>
      Promise.resolve({ ...model, ...data }),
    );
  });

  it('cannot re-enable a model missing from upstream', async () => {
    prisma.platformModel.findUnique.mockResolvedValue({ ...model, isStale: true });
    await expect(service.updateModel(model.id, { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.platformModel.update).not.toHaveBeenCalled();
  });

  it('disables missing models including previously stale enabled rows', async () => {
    jest.spyOn(service, 'listUpstream').mockResolvedValue([{ id: 'new-model', label: 'New' }]);
    prisma.platformModel.findMany.mockResolvedValue([
      { ...model, isStale: true },
      { ...model, id: 'model-2', modelId: 'missing', isStale: false },
    ]);
    expect(await service.syncFromUpstream()).toMatchObject({ added: 1, staled: 1 });
    expect(prisma.platformModel.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [model.id, 'model-2'] } },
      data: { isStale: true, enabled: false },
    });
    expect(prisma.platformModel.create).toHaveBeenCalledWith({ data: expect.objectContaining({ enabled: false }) });
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

describe('ModelService upstream catalogue validation', () => {
  const prisma = { platformModel: { findMany: jest.fn(), updateMany: jest.fn() } };
  const settings = { getEffectiveValue: jest.fn() };
  const service = new ModelService(prisma as never, settings as never, {} as never);
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    settings.getEffectiveValue.mockImplementation(async (key: string) =>
      key === 'SUB2API_BASE_URL' ? 'https://effective.example/v1///' : 'effective-key');
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it.each([{}, { data: null }, { data: [] }, { data: [{}] }, { data: [{ id: ' ' }] }, { data: [{ id: 123 }] }])(
    'rejects invalid or empty catalogues before touching the whitelist: %j', async (body) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
      await expect(service.syncFromUpstream()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.platformModel.findMany).not.toHaveBeenCalled();
      expect(prisma.platformModel.updateMany).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid JSON without changing models', async () => {
    fetchMock.mockResolvedValue(new Response('{broken-json'));
    await expect(service.syncFromUpstream()).rejects.toMatchObject({ status: 502, response: { stage: 'response-json', cause: { name: 'SyntaxError' } } });
    expect(prisma.platformModel.findMany).not.toHaveBeenCalled();
  });

  it('uses the effective connection and normalizes duplicate model IDs', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })));
    expect(await service.listUpstream()).toEqual([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
    expect(fetchMock).toHaveBeenCalledWith('https://effective.example/v1/models', {
      headers: { Authorization: 'Bearer effective-key' }, signal: expect.any(AbortSignal),
    });
  });

  it('preserves catalogue degradation diagnostics without changing the model whitelist', async () => {
    const body = { data: [{ id: 'fallback-model' }], partial: true,
      diagnostics: [{ field: 'models', message: 'Repository read timed out' }] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'X-Data-Degraded': 'true' } }));
    await expect(service.syncFromUpstream()).rejects.toMatchObject({ response: expect.objectContaining({ body }) });
    expect(prisma.platformModel.findMany).not.toHaveBeenCalled();
    expect(prisma.platformModel.updateMany).not.toHaveBeenCalled();
  });
});

describe('ModelService stream diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps a split SSE business error instead of reporting a successful model test', async () => {
    const service = new ModelService({ platformModel: { findUnique: jest.fn().mockResolvedValue({ modelId: 'test-model' }) } } as never,
      { getEffectiveValue: jest.fn(async key => key === 'SUB2API_BASE_URL' ? 'https://relay.example/v1' : 'test-key') } as never, {} as never);
    const frame = 'event: error\r\ndata: {"error":{"code":1203,"message":"Quota exhausted token=test-key","details":{"limit":10}}}\r\n\r\n';
    let index = 0;
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
      if (index >= frame.length) controller.close();
      else { controller.enqueue(Buffer.from(frame.slice(index, index + 7))); index += 7; }
    } }), { headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'compute-test-id' } }));
    await expect(service.testModel('model-id')).rejects.toMatchObject({ status: 502, upstreamError: { status: 200,
      body: { error: { code: 1203, message: 'Quota exhausted token=[REDACTED]', details: { limit: 10 } } } },
      diagnosticHeaders: { 'x-request-id': 'compute-test-id' } });
  });
});
