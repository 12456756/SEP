import { BadRequestException, ForbiddenException, HttpException, InternalServerErrorException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnterpriseModelConfigService } from '../enterprise-model-config/enterprise-model-config.service';
import { ClientService } from '../client/client.service';
import { ChatCompletionRequestSchema } from 'shared';
import { GatewayModelPolicyService } from './gateway-model-policy.service';
import { policySnapshot as runtimeSnapshot } from './gateway-policy.test-fixtures';

// Existing bounded-policy regressions keep exercising an explicitly finite deployment.
const policySnapshot: typeof runtimeSnapshot = (overrides = {}, version) => runtimeSnapshot({
  GATEWAY_DEFAULT_MAX_TOKENS: 4096, MODEL_MAX_OUTPUT_TOKENS: 32768, ...overrides,
}, version);

jest.mock('../setting/setting.service', () => ({ SettingService: jest.fn() }));

const identity = { sub: 'user-1', enterpriseId: 'ent-1', memberId: 'member-1', subscriptionId: 'sub-1' };

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enterpriseId: 'ent-1', defaultChatModel: 'model-a', allowedChatModels: [] as string[],
    allowUserSwitchModel: true, employeeModelPolicy: 'FOLLOW_TEMPLATE', employeeDefaultModel: null,
    rerankModel: null, createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return ChatCompletionRequestSchema.parse({
    model: 'model-a', messages: [{ role: 'user', content: 'hello' }], ...overrides,
  });
}

async function expectPlatformError(operation: Promise<unknown>, status: number, code: string,
  message: string, param: string | null, type = 'invalid_request_error') {
  const error = await operation.catch((failure) => failure);
  expect(error).toBeInstanceOf(HttpException);
  if (!(error instanceof HttpException)) throw error;
  expect(error.getStatus()).toBe(status);
  expect(error.message).toBe(message);
  expect(error.getResponse()).toEqual({ message, error: { message, code, source: 'platform', param, type } });
}

describe('GatewayModelPolicyService', () => {
  let prisma: any;
  let config: ConfigService;
  let context: any;
  let modelConfig: EnterpriseModelConfigService;
  let service: GatewayModelPolicyService;

  beforeEach(() => {
    prisma = {
      enterpriseMember: { findFirst: jest.fn().mockResolvedValue({ departmentId: 'dept-current' }) },
      enterpriseModelConfig: {
        findUnique: jest.fn().mockResolvedValue(makeConfig()),
        create: jest.fn().mockResolvedValue(makeConfig()),
      },
      departmentModelPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
      subscription: {
        findFirst: jest.fn().mockResolvedValue({ employee: { modelId: 'model-template' } }),
        findUnique: jest.fn().mockResolvedValue({ config: { modelId: 'model-subscription' } }),
      },
      platformModel: {
        findMany: jest.fn().mockResolvedValue([
          { modelId: 'model-a' }, { modelId: 'model-b' },
          { modelId: 'model-template' }, { modelId: 'model-subscription' },
        ]),
        findFirst: jest.fn().mockResolvedValue({ maxOutputTokens: null, supportedFeatures: null }),
      },
      employeeGrant: { findMany: jest.fn() },
    };
    config = new ConfigService({ GATEWAY_DEFAULT_MAX_TOKENS: 4096, MODEL_MAX_OUTPUT_TOKENS: 32768 });
    context = { resolve: jest.fn() };
    modelConfig = new EnterpriseModelConfigService(prisma, context, config);
    service = new GatewayModelPolicyService(modelConfig, prisma, config);
  });

  it('matches member, enterprise and user together and uses the current department only', async () => {
    const policy = await service.resolvePolicy(identity);
    expect(prisma.enterpriseMember.findFirst).toHaveBeenCalledWith({
      where: { id: 'member-1', enterpriseId: 'ent-1', userId: 'user-1', enterprise: { status: 'ACTIVE' } }, select: { departmentId: true },
    });
    expect(prisma.departmentModelPolicy.findUnique).toHaveBeenCalledWith({
      where: { departmentId: 'dept-current' }, select: { defaultChatModel: true, allowedChatModels: true },
    });
    expect(context.resolve).not.toHaveBeenCalled();
    expect(policy.departmentId).toBe('dept-current');
    expect(prisma.platformModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, isStale: false },
    }));
  });

  it('rejects missing or mismatched members before reading policies or model metadata', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue(null);
    await expectPlatformError(service.prepare(identity, request()), 403, 'MEMBER_ACCESS_DENIED',
      '成员不属于当前用户或企业', null, 'permission_error');
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.platformModel.findMany).not.toHaveBeenCalled();
    expect(prisma.platformModel.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a subscription outside the claimed enterprise', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expectPlatformError(service.resolvePolicy(identity), 403, 'SUBSCRIPTION_ACCESS_DENIED',
      '订阅不属于当前企业', null, 'permission_error');
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: { id: 'sub-1', enterpriseId: 'ent-1' }, select: { employee: { select: { modelId: true } } },
    });
  });

  it('intersects enterprise and department allowlists without allowing department expansion', async () => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['model-a'] }));
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({
      defaultChatModel: 'model-a', allowedChatModels: ['model-a', 'model-b'],
    });
    expect((await service.resolvePolicy(identity)).allowedModels).toEqual(['model-a']);
    await expectPlatformError(service.prepare(identity, request({ model: 'model-b' })), 403,
      'MODEL_NOT_ALLOWED', '该模型不在当前成员允许范围内', 'model', 'permission_error');
    expect(prisma.platformModel.findFirst).not.toHaveBeenCalled();
  });

  it('does not reinterpret an empty intersection as unrestricted', async () => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['model-a'] }));
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: null, allowedChatModels: ['model-b'] });
    expect((await service.resolvePolicy(identity)).allowedModels).toEqual([]);
    await expect(service.prepare(identity, request())).rejects.toThrow(ForbiddenException);
  });

  it('treats empty allowlists as no restriction at that level', async () => {
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: null, allowedChatModels: ['model-b'] });
    expect((await service.resolvePolicy(identity)).allowedModels).toEqual(['model-b']);
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: null, allowedChatModels: [] });
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['model-a'] }));
    expect((await service.resolvePolicy(identity)).allowedModels).toEqual(['model-a']);
  });

  it('disabling switching limits requests to the department or enterprise default', async () => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowUserSwitchModel: false }));
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: 'model-b', allowedChatModels: [] });
    const policy = await service.resolvePolicy(identity);
    expect(policy).toMatchObject({ allowedModels: ['model-b'], defaultModel: 'model-b', allowUserSwitchModel: false });
    await expect(service.prepare(identity, request())).rejects.toThrow(ForbiddenException);
    await expect(service.prepare(identity, request({ model: 'model-b' }))).resolves.toMatchObject({ request: { model: 'model-b', max_tokens: 4096 } });
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
  });

  it('FORCE_DEFAULT uses its employee default and disallows model switching', async () => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({
      employeeModelPolicy: 'FORCE_DEFAULT', employeeDefaultModel: 'model-b',
    }));
    expect(await service.resolvePolicy(identity)).toMatchObject({
      allowedModels: ['model-b'], defaultModel: 'model-b', allowUserSwitchModel: false,
    });
    await expect(service.prepare(identity, request())).rejects.toThrow(ForbiddenException);
  });

  it.each([
    { allowUserSwitchModel: false, defaultChatModel: 'stale' },
    { employeeModelPolicy: 'FORCE_DEFAULT', employeeDefaultModel: 'disabled' },
    { allowUserSwitchModel: false, allowedChatModels: ['model-b'] },
  ])('fails explicitly on an unavailable or excluded forced default: %j', async (overrides) => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig(overrides));
    await expectPlatformError(service.resolvePolicy(identity), 400, 'MODEL_POLICY_DEFAULT_INVALID',
      '强制默认模型未启用、已下架或不在企业与部门允许范围内，请联系管理员', 'model');
  });

  it('preserves subscription > template > department > enterprise default precedence', async () => {
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: 'model-b', allowedChatModels: [] });
    expect((await service.resolvePolicy(identity)).defaultModel).toBe('model-subscription');
    prisma.subscription.findUnique.mockResolvedValue({ config: {} });
    expect((await service.resolvePolicy(identity)).defaultModel).toBe('model-template');
    prisma.subscription.findFirst.mockResolvedValue({ employee: { modelId: null } });
    expect((await service.resolvePolicy(identity)).defaultModel).toBe('model-b');
    prisma.departmentModelPolicy.findUnique.mockResolvedValue(null);
    expect((await service.resolvePolicy(identity)).defaultModel).toBe('model-a');
  });

  it('skips stale implicit subscription and template models when advertising the client default', async () => {
    prisma.platformModel.findMany.mockResolvedValue([{ modelId: 'model-a' }, { modelId: 'model-b' }]);
    const policy = await service.resolvePolicy(identity);
    expect(policy.defaultModel).toBe('model-a');
    expect(policy.allowedModels).toContain(policy.defaultModel);
    await expect(service.prepare(identity, request({ model: 'model-template' }))).rejects.toThrow(ForbiddenException);
  });

  it('prepares a copy with default output tokens and never silently replaces the requested model', async () => {
    const dto = request({ model: 'model-b' });
    const prepared = await service.prepare(identity, dto);
    expect(prepared.request).toMatchObject({ model: 'model-b', max_tokens: 4096 });
    expect(dto).not.toHaveProperty('max_tokens');
    expect(prepared.inputBytes).toBe(Buffer.byteLength(JSON.stringify(prepared.request), 'utf8'));
  });

  it('caps an omitted max_tokens, but rejects an explicit limit beyond the model cap', async () => {
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens: 2048, supportedFeatures: null });
    expect((await service.prepare(identity, request())).request.max_tokens).toBe(2048);
    await expect(service.prepare(identity, request({ max_tokens: 2049 }))).rejects.toMatchObject({
      status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', param: 'max_tokens', limit: 2048 } },
    });
    expect((await service.prepare(identity, request({ max_tokens: 2048 }))).request.max_tokens).toBe(2048);
  });

  it('keeps an explicit 4096 budget but accepts larger budgets independently of the default', async () => {
    for (const max_tokens of [4096, 8192, 16384, 32768]) {
      const dto = request({ max_tokens });
      expect((await service.prepare(identity, dto)).request.max_tokens).toBe(max_tokens);
      expect(dto.max_tokens).toBe(max_tokens);
    }
    expect((await service.prepare(identity, request())).request.max_tokens).toBe(4096);
  });

  it.each([null, 65536])('enforces the independent platform ceiling with model capability %p', async (maxOutputTokens) => {
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens, supportedFeatures: null });
    jest.spyOn(config, 'get').mockImplementation((key: string) => (
      key === 'MODEL_MAX_OUTPUT_TOKENS' ? '8192' : undefined
    ) as never);
    expect((await service.prepare(identity, request({ max_tokens: 8192 }))).request.max_tokens).toBe(8192);
    await expect(service.prepare(identity, request({ max_tokens: 8193 }))).rejects.toMatchObject({
      status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', param: 'max_tokens', limit: 8192, source: 'platform' } },
    });
  });

  it('clamps only the omitted default to the platform ceiling', async () => {
    jest.spyOn(config, 'get').mockImplementation((key: string) => (
      key === 'MODEL_MAX_OUTPUT_TOKENS' ? 2048 : key === 'GATEWAY_DEFAULT_MAX_TOKENS' ? 4096 : undefined
    ) as never);
    expect((await service.prepare(identity, request())).request.max_tokens).toBe(2048);
    await expect(service.prepare(identity, request({ max_tokens: 4096 }))).rejects.toMatchObject({
      status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', limit: 2048 } },
    });
  });

  it('rejects budgets above the independent platform ceiling when model metadata is unknown', async () => {
    expect((await service.prepare(identity, request({ max_tokens: 4096 }))).request.max_tokens).toBe(4096);
    await expect(service.prepare(identity, request({ max_tokens: 32769 }))).rejects.toMatchObject({
      status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', limit: 32768 } },
    });
    await expect(service.prepare(identity, request({ max_tokens: Number.MAX_SAFE_INTEGER }))).rejects.toThrow(BadRequestException);
  });

  it('treats omitted cap/features metadata as unknown rather than invalid or unsupported', async () => {
    prisma.platformModel.findFirst.mockResolvedValue({});
    const prepared = await service.prepare(identity, request({ stream: true, tools: [
      { type: 'function', function: { name: 'ls' } },
    ] }));
    expect(prepared.request.max_tokens).toBe(4096);
    expect((await service.prepare(identity, request({ max_tokens: 8192 }))).request.max_tokens).toBe(8192);
  });

  it('uses configured defaults and rejects invalid configuration', async () => {
    jest.spyOn(config, 'get').mockImplementation((key: string) => (
      key === 'GATEWAY_DEFAULT_MAX_TOKENS' ? 1024 : undefined
    ) as never);
    expect((await service.prepare(identity, request())).request.max_tokens).toBe(1024);
    jest.spyOn(config, 'get').mockReturnValue(-1 as never);
    await expect(service.prepare(identity, request())).rejects.toThrow(InternalServerErrorException);
  });

  it.each([0, -1])('rejects invalid model output metadata %s', async (maxOutputTokens) => {
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens, supportedFeatures: null });
    await expectPlatformError(service.prepare(identity, request()), 400, 'MODEL_OUTPUT_LIMIT_INVALID',
      '模型 maxOutputTokens 配置无效', 'model');
  });

  it('rechecks enabled/stale status immediately before resource validation', async () => {
    prisma.platformModel.findFirst.mockResolvedValue(null);
    await expectPlatformError(service.prepare(identity, request()), 400, 'MODEL_UNAVAILABLE',
      '该模型未启用或已下架', 'model');
    expect(prisma.platformModel.findFirst).toHaveBeenCalledWith({
      where: { modelId: 'model-a', enabled: true, isStale: false },
      select: { maxOutputTokens: true, supportedFeatures: true },
    });
  });

  it('rejects explicit unsupported features, but accepts missing or unknown metadata', async () => {
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens: null, supportedFeatures: { streaming: false, functionCalling: false } });
    await expect(service.prepare(identity, request({ stream: true }))).rejects.toThrow('streaming');
    await expect(service.prepare(identity, request({ tools: [{ type: 'function', function: { name: 'ls' } }] }))).rejects.toThrow('functionCalling');
    await expect(service.prepare(identity, request({ tool_choice: 'required' }))).rejects.toThrow('functionCalling');
    await expect(service.prepare(identity, request({ tools: [], tool_choice: 'none', stream: false }))).resolves.toBeDefined();
    for (const supportedFeatures of [null, {}, { streaming: null, functionCalling: null }]) {
      prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens: null, supportedFeatures });
      await expect(service.prepare(identity, request({ stream: true, tools: [{ type: 'function', function: { name: 'ls' } }] }))).resolves.toBeDefined();
    }
  });

  it('applies functionCalling support checks to tool continuation history too', async () => {
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens: null, supportedFeatures: { functionCalling: false } });
    await expect(service.prepare(identity, request({ messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
      { role: 'tool', content: 'done', tool_call_id: 'call-1' },
    ] }))).rejects.toThrow('functionCalling');
  });

  it('bounds the whole UTF-8 serialization including tools and injected output budget', async () => {
    const dto = request({ messages: [{ role: 'user', content: '中文' }] });
    const bytes = Buffer.byteLength(JSON.stringify({ ...dto, max_tokens: 4096 }), 'utf8');
    jest.spyOn(config, 'get').mockImplementation((key: string) => (
      key === 'GATEWAY_MAX_REQUEST_BYTES' ? bytes : key === 'GATEWAY_DEFAULT_MAX_TOKENS' ? 4096 : undefined
    ) as never);
    expect((await service.prepare(identity, dto)).inputBytes).toBe(bytes);
    jest.spyOn(config, 'get').mockImplementation((key: string) => (
      key === 'GATEWAY_MAX_REQUEST_BYTES' ? bytes - 1 : key === 'GATEWAY_DEFAULT_MAX_TOKENS' ? 4096 : undefined
    ) as never);
    await expectPlatformError(service.prepare(identity, dto), 413, 'MODEL_REQUEST_TOO_LARGE',
      '模型请求超过序列化资源上限', null);
  });

  it.each([
    [{ stream: true }, 'streaming', 'stream'],
    [{ tools: [{ type: 'function', function: { name: 'ls' } }] }, 'functionCalling', 'tools'],
    [{ tool_choice: 'required' }, 'functionCalling', 'tool_choice'],
    [{ messages: [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'done', tool_call_id: 'call-1' },
    ] }, 'functionCalling', 'messages'],
    [{ messages: [{ role: 'assistant', content: null, tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'ls', arguments: '{}' } },
    ] }] }, 'functionCalling', 'messages'],
  ])('identifies the unsupported request field %j', async (overrides, feature, param) => {
    prisma.platformModel.findFirst.mockResolvedValue({
      maxOutputTokens: null, supportedFeatures: { streaming: false, functionCalling: false },
    });
    await expectPlatformError(service.prepare(identity, request(overrides)), 400,
      'MODEL_FEATURE_UNSUPPORTED', `该模型不支持 ${feature}`, param);
  });

  it.each([0, -1, 1.5, NaN, Infinity, '4096', null])('rejects invalid explicit output %p', async (max_tokens) => {
    await expect(service.prepare(identity, { ...request(), max_tokens } as never)).rejects.toMatchObject({
      status: 400, response: { error: { code: 'INVALID_PARAMETER', param: 'max_tokens' } },
    });
  });

  it.each(['GATEWAY_DEFAULT_MAX_TOKENS', 'MODEL_MAX_OUTPUT_TOKENS', 'GATEWAY_MAX_REQUEST_BYTES'])('identifies invalid %s configuration', async (key) => {
    jest.spyOn(config, 'get').mockImplementation((name: string) => (name === key ? -1 : undefined) as never);
    await expectPlatformError(service.prepare(identity, request()), 500, 'GATEWAY_CONFIG_INVALID',
      `${key} must be an integer between ${key === 'GATEWAY_MAX_REQUEST_BYTES' ? 1 : 0} and 2147483647`, null, 'server_error');
  });

  it.each(['circular', 'bigint'])('structures known %s serialization failures', async (kind) => {
    const dto = request();
    Object.assign(dto.messages[0], { content: kind === 'circular' ? dto : BigInt(1) });
    await expectPlatformError(service.prepare(identity, dto), 400, 'REQUEST_SERIALIZATION_FAILED',
      '请求无法序列化', null);
  });

  it('does not swallow unknown serialization exceptions', async () => {
    const failure = new Error('unexpected serialization failure');
    const dto = request();
    Object.defineProperty(dto.messages[0], 'content', { get: () => { throw failure; }, enumerable: true });
    await expect(service.prepare(identity, dto)).rejects.toBe(failure);
  });

  it.each(['member', 'policy', 'metadata'])('propagates unknown %s errors unchanged', async (step) => {
    const failure = new Error('unexpected policy failure');
    if (step === 'member') prisma.enterpriseMember.findFirst.mockRejectedValue(failure);
    else if (step === 'policy') jest.spyOn(modelConfig, 'resolveEffectiveModel').mockRejectedValue(failure);
    else prisma.platformModel.findFirst.mockRejectedValue(failure);
    await expect(service.prepare(identity, request())).rejects.toBe(failure);
  });

  it('enforces the default 4 MiB limit without pretending to count context tokens', async () => {
    const content = 'x'.repeat(1024 * 1024);
    await expect(service.prepare(identity, request({ messages: Array(4).fill({ role: 'user', content }) }))).rejects.toThrow(PayloadTooLargeException);
  });

  it('uses the same policy for the client subscription list and prepared requests', async () => {
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ employeeModelPolicy: 'FORCE_DEFAULT' }));
    const subscription = {
      id: 'sub-1', employeeId: 'emp-1', name: null, status: 'ACTIVE', templateVersion: '1.0.0',
      employee: { id: 'emp-1', name: 'Employee', avatar: null, version: '1.0.0' },
    };
    prisma.employeeGrant.findMany.mockResolvedValue([{ subscription }, { subscription }]);
    const client = Object.create(ClientService.prototype) as ClientService;
    Object.assign(client, {
      prisma, modelPolicy: service,
      enterpriseContext: { resolve: jest.fn().mockResolvedValue({ enterpriseId: 'ent-1', memberId: 'member-1', departmentId: 'dept-current' }) },
    });
    const listed = await client.listSubscriptions('user-1');
    const prepared = await service.prepare(identity, request());
    expect(listed).toHaveLength(1);
    expect(listed[0].allowedModels).toEqual(prepared.allowedModels);
    expect(listed[0].allowedModels).toEqual(['model-a']);
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(2);
    await expect(service.prepare(identity, request({ model: 'model-b' }))).rejects.toThrow(ForbiddenException);
  });

  it('adds snapshot defaults without mutating tools or history', () => {
    const body = request({ tools: [{ type: 'function', function: { name: 'tool' } }] });
    expect(service.normalize(body, { maxOutputTokens: 1024 }, policySnapshot())).toEqual({ ...body, max_tokens: 1024 });
    expect(body).not.toHaveProperty('max_tokens');
    expect(service.normalize(body, { maxOutputTokens: null }, policySnapshot()).max_tokens).toBe(4096);
  });

  it('uses the platform ceiling independently of default output and missing model metadata', () => {
    expect(service.resolveOutputLimit({}, policySnapshot())).toBe(32768);
    expect(service.resolveOutputLimit({ maxOutputTokens: 100000 }, policySnapshot())).toBe(32768);
    expect(service.resolveOutputLimit({ maxOutputTokens: 100 }, policySnapshot())).toBe(100);
  });

  it('rejects explicit client overflow and clamps only internal defaults', () => {
    expect(() => service.normalize({ max_tokens: 101 }, { maxOutputTokens: 100 }, policySnapshot())).toThrow(
      expect.objectContaining({ status: 400, response: { error: expect.objectContaining({
        code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', param: 'max_tokens', limit: 100, policyVersion: 7,
      }) } }),
    );
    expect(service.internalOutputTokens({ maxOutputTokens: 100 }, policySnapshot(), 4096)).toBe(100);
    expect(service.internalOutputTokens(null, policySnapshot(), 4000)).toBe(4000);
    expect(service.normalizeInternal({}, policySnapshot({ MODEL_MAX_OUTPUT_TOKENS: 2000 }), 4096)).toBe(2000);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('fails closed on invalid output capability %p', maxOutputTokens => {
    expect(() => service.resolveOutputLimit({ maxOutputTokens }, policySnapshot()))
      .toThrow(expect.objectContaining({ status: 503 }));
    if (maxOutputTokens !== 0) {
      expect(() => service.resolveOutputLimit({}, policySnapshot({ MODEL_MAX_OUTPUT_TOKENS: maxOutputTokens })))
        .toThrow(expect.objectContaining({ status: 503 }));
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, '100', null])('rejects invalid explicit snapshot output %p', max_tokens => {
    expect(() => service.normalize({ max_tokens }, {}, policySnapshot())).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('uses the captured snapshot for prepare and revalidation instead of environment output defaults', async () => {
    jest.spyOn(config, 'get').mockImplementation((key: string) => (key === 'GATEWAY_DEFAULT_MAX_TOKENS' ? -1 : undefined) as never);
    const snapshot = policySnapshot({ GATEWAY_DEFAULT_MAX_TOKENS: 512, MODEL_MAX_OUTPUT_TOKENS: 2048 });
    const dto = request({ max_tokens: 1500 });
    expect((await service.prepare(identity, dto, snapshot)).request.max_tokens).toBe(1500);
    expect((await service.prepare(identity, request(), snapshot)).request.max_tokens).toBe(512);
    const policy = await service.resolvePolicy(identity);
    expect((await service.validateResources(dto, policy, snapshot)).request.max_tokens).toBe(1500);
    await expect(service.prepare(identity, request({ max_tokens: 2049 }), snapshot))
      .rejects.toMatchObject({ status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', policyVersion: 7 } } });
  });

  it('retains ownership and department authorization on the snapshot preparation path', async () => {
    const snapshot = policySnapshot();
    prisma.enterpriseMember.findFirst.mockResolvedValueOnce(null);
    await expect(service.prepare(identity, request(), snapshot)).rejects.toThrow(ForbiddenException);
    expect(prisma.platformModel.findFirst).not.toHaveBeenCalled();
    prisma.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(service.prepare(identity, request(), snapshot)).rejects.toThrow(ForbiddenException);
    prisma.enterpriseModelConfig.findUnique.mockResolvedValue(makeConfig({ allowedChatModels: ['model-a'] }));
    prisma.departmentModelPolicy.findUnique.mockResolvedValue({ defaultChatModel: null, allowedChatModels: ['model-b'] });
    await expect(service.prepare(identity, request(), snapshot)).rejects.toThrow(ForbiddenException);
    expect(prisma.platformModel.findFirst).not.toHaveBeenCalled();
  });

  it('retains availability, feature support, model caps and serialized size checks with a snapshot', async () => {
    const snapshot = policySnapshot();
    prisma.platformModel.findFirst.mockResolvedValueOnce(null);
    await expect(service.prepare(identity, request(), snapshot)).rejects.toThrow(BadRequestException);
    prisma.platformModel.findFirst.mockResolvedValue({ maxOutputTokens: 100, supportedFeatures: { streaming: false, functionCalling: false } });
    await expect(service.prepare(identity, request({ stream: true }), snapshot)).rejects.toThrow('streaming');
    await expect(service.prepare(identity, request({ tool_choice: 'required' }), snapshot)).rejects.toThrow('functionCalling');
    await expect(service.prepare(identity, request({ messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{}' } }] },
      { role: 'tool', content: 'done', tool_call_id: 'call-1' },
    ] }), snapshot))
      .rejects.toThrow('functionCalling');
    await expect(service.prepare(identity, request({ max_tokens: 101 }), snapshot))
      .rejects.toMatchObject({ response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', limit: 100 } } });
    expect((await service.prepare(identity, request(), snapshot)).request.max_tokens).toBe(100);
    jest.spyOn(config, 'get').mockImplementation((key: string) => (key === 'GATEWAY_MAX_REQUEST_BYTES' ? 10 : undefined) as never);
    await expect(service.prepare(identity, request(), snapshot)).rejects.toThrow(PayloadTooLargeException);
  });
});
