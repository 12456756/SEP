import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { EmployeeCopyDraftService } from './employee-copy-draft.service';

describe('EmployeeCopyDraftService', () => {
  const settings = {
    getEffectiveValue: jest.fn(),
  };
  const runtimePolicy = {
    getSnapshot: jest.fn(),
  };
  const prisma = {
    platformModel: {
      findMany: jest.fn(),
    },
  };
  let service: EmployeeCopyDraftService;
  let fetchSpy: jest.SpyInstance;

  const input = {
    kind: 'description' as const,
    employee: {
      name: '客服助手',
      industry: '电商',
      position: '售前客服',
      capabilities: [{ name: '订单查询', description: '查询订单状态' }],
    },
  };

  const streamed = (content: string) => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    settings.getEffectiveValue.mockImplementation(async (key: string) => ({
      SUB2API_BASE_URL: 'https://relay.example/v1/',
      SUB2API_API_KEY: 'test-key',
      SUB2API_DEFAULT_MODEL: 'platform-model',
    }[key]));
    runtimePolicy.getSnapshot.mockResolvedValue({ values: { PLANNER_REQUEST_TIMEOUT_MS: 5000 } });
    prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'platform-model' }, { modelId: 'fallback-model' }]);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(streamed('  生成草稿  '));
    service = new EmployeeCopyDraftService(settings as never, runtimePolicy as never, prisma as never);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('uses the platform Sub2API default model and sends description requests through the relay', async () => {
    await expect(service.generate(input)).resolves.toEqual({
      draft: '生成草稿',
      modelId: 'platform-model',
      modelSource: 'PLATFORM_DEFAULT',
    });

    expect(fetchSpy).toHaveBeenCalledWith('https://relay.example/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    }));
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(requestBody.model).toBe('platform-model');
    expect(requestBody.stream).toBe(true);
    expect(requestBody.messages[0].content).toContain('企业选购页展示');
    expect(requestBody.messages[0].content).toContain('30 到 60 个汉字');
    expect(requestBody.max_tokens).toBe(900);
    expect(requestBody.messages[1].content).toContain('订单查询');
  });

  it('builds system-prompt instructions when that draft kind is requested', async () => {
    await service.generate({ ...input, kind: 'systemPrompt' });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(requestBody.messages[0].content).toContain('system prompt');
    expect(requestBody.messages[0].content).toContain('工作步骤');
    expect(requestBody.messages[0].content).toContain('250 到 600 个汉字');
  });

  it('falls back to the first enabled platform chat model when the configured default is unavailable', async () => {
    settings.getEffectiveValue.mockImplementation(async (key: string) => ({
      SUB2API_BASE_URL: 'https://relay.example/v1/',
      SUB2API_API_KEY: 'test-key',
      SUB2API_DEFAULT_MODEL: 'stale-model',
    }[key]));
    prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'first-enabled-model' }]);

    await expect(service.generate(input)).resolves.toMatchObject({ modelId: 'first-enabled-model' });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string).model).toBe('first-enabled-model');
  });

  it('does not fall back to the legacy hardcoded model when no platform chat model is enabled', async () => {
    prisma.platformModel.findMany.mockResolvedValue([]);

    await expect(service.generate(input)).rejects.toThrow('平台没有已启用且有效的会话模型');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid employee context before calling the model', async () => {
    await expect(service.generate({ ...input, employee: { ...input.employee, name: '' } })).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized model output', async () => {
    fetchSpy.mockResolvedValueOnce(streamed('  '));
    await expect(service.generate(input)).rejects.toBeInstanceOf(BadGatewayException);

    fetchSpy.mockResolvedValueOnce(streamed('x'.repeat(3001)));
    await expect(service.generate(input)).rejects.toThrow('文案模型返回内容过长');
  });

  it('maps relay errors to a user-safe upstream error', async () => {
    fetchSpy.mockResolvedValue(new Response('private upstream details', { status: 503 }));
    await expect(service.generate(input)).rejects.toThrow('文案模型暂时不可用');
  });

  it('maps transport failures without exposing upstream or credential details', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('private transport detail'));
    await expect(service.generate(input)).rejects.toThrow('文案生成暂时失败');
  });
});
