import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { GatewayModelPolicyService } from './gateway-model-policy.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

jest.mock('../setting/setting.service', () => ({ SettingService: jest.fn() }));

const enterpriseClaims = {
  sub: 'user-1',
  enterpriseId: 'enterprise-1',
  subscriptionId: 'subscription-1',
  memberId: 'member-1',
};

describe('GatewayService.getSub2ApiConfig', () => {
  it('requires enterprise context even when an administrator key is configured', async () => {
    const getEffectiveValue = jest.fn().mockResolvedValue('private-config-value');
    const service = new GatewayService(
      {} as never, new ConfigService(), { getEffectiveValue } as never, {} as never, {} as never,
    );
    const error = await service.getSub2ApiConfig().catch((failure) => failure);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'COMPUTE_ENTERPRISE_CONTEXT_REQUIRED' });
    expect(getEffectiveValue).not.toHaveBeenCalled();
    expect(JSON.stringify(error.getResponse())).not.toContain('private-config-value');
  });

  it('propagates enterprise failures without reading an administrator credential', async () => {
    const failure = new Error('enterprise connection unavailable');
    const getEffectiveValue = jest.fn().mockResolvedValue('administrator-key');
    const connections = { chatProvider: jest.fn().mockRejectedValue(failure) };
    const service = new GatewayService(
      {} as never, new ConfigService(),
      { getEffectiveValue } as never, {} as never, {} as never, connections as never,
    );
    await expect(service.getSub2ApiConfig({ enterpriseId: 'enterprise-1' })).rejects.toBe(failure);
    expect(getEffectiveValue).not.toHaveBeenCalled();
  });
});

describe('GatewayService.forwardChatCompletion', () => {
  const dto = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hello' }] };
  let service: GatewayService;
  let fetchMock: jest.SpyInstance;
  let warnMock: jest.SpyInstance;

  beforeEach(() => {
    service = new GatewayService({} as never, new ConfigService(), {} as never, {} as never, {} as never);
    jest.spyOn(service, 'getSub2ApiConfig').mockResolvedValue({
      baseUrl: 'https://relay.test/v1/', apiKey: 'test-key', defaultModel: 'test-model',
    });
    fetchMock = jest.spyOn(global, 'fetch');
    warnMock = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('forwards the validated request only through sub2api', async () => {
    const upstream = new Response('{}');
    fetchMock.mockResolvedValue(upstream);
    expect(await (await service.forwardChatCompletion(dto, policySnapshot())).json()).toEqual({});
    expect(fetchMock).toHaveBeenCalledWith('https://relay.test/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify(dto),
    }));
  });

  it('forwards the optional platform request id without changing the payload', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await (await service.forwardChatCompletion(dto, policySnapshot(), 'platform-request-123')).body!.cancel();
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer test-key',
        'x-request-id': 'platform-request-123',
      },
      body: JSON.stringify(dto),
    }));
    expect(warnMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 422, 429, 500, 503])('preserves HTTP %i and all diagnostic fields', async status => {
    const body = { error: { code: 40103, message: 'Invalid tool arguments', param: { key: 'duration' },
      source: 'supplier', details: { minimum: 4 }, attempts: [{ status: 422, reason: 'missing seconds' }] }, request_id: 'compute-1' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    await expect(service.forwardChatCompletion(dto, policySnapshot())).rejects.toMatchObject({ status, response: body });
  });

  it.each([{ code: 'missing_model', message: 'Model is required' }, { error: 'Account quota exhausted' },
    { detail: [{ loc: ['body', 'duration'], msg: 'Required' }] }, ['provider failure'], 'proxy connection refused'])(
    'preserves alternate upstream error shape %j', async body => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      fetchMock.mockResolvedValue(new Response(raw, { status: 502 }));
      const error = await service.forwardChatCompletion(dto, policySnapshot()).catch(error => error);
      expect(error.getStatus()).toBe(502);
      expect(error.getResponse()).toEqual(body);
    },
  );

  it.each(['17', '0', 'Sat, 10 Oct 2026 00:00:18 GMT', 'tomorrow', '1.5', ''])(
    'preserves Retry-After %j as received instead of inventing recovery timing', async retryAfter => {
      fetchMock.mockResolvedValue(new Response('{}', { status: 503, headers: { 'Retry-After': retryAfter,
        'X-Request-ID': 'compute-123', 'X-Upstream-Request-ID': 'vendor-1', 'Set-Cookie': 'secret-cookie' } }));
      const error = await service.forwardChatCompletion(dto, policySnapshot()).catch(error => error);
      expect(error.diagnosticHeaders).toEqual({ 'retry-after': retryAfter, 'x-request-id': 'compute-123', 'x-upstream-request-id': 'vendor-1' });
      expect(error.getResponse()).toEqual({});
    },
  );

  it('redacts sensitive fragments while retaining numeric codes, context and nested fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Bad parameter test-key',
      code: 40012, param: { key: 'duration' }, details: { token: 'private', minimum: 4, url: 'http://10.0.0.1:8080/private' },
      credentials: 'private-key' }, attempts: [{ upstream_status: 422 }] }), { status: 422 }));
    const error = await service.forwardChatCompletion(dto, policySnapshot()).catch(error => error);
    expect(error.getResponse()).toEqual({ error: { message: 'Bad parameter [REDACTED]', code: 40012, param: { key: 'duration' },
      details: { token: '[REDACTED]', minimum: 4, url: '[REDACTED]' }, credentials: '[REDACTED]' },
      attempts: [{ upstream_status: 422 }] });
  });

  it('retains the transport cause and errno without exposing the connection credential', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed test-key'), { cause: { code: 'ECONNREFUSED',
      message: 'Connection refused http://127.0.0.1:8080/private' } }));
    await expect(service.forwardChatCompletion(dto, policySnapshot())).rejects.toMatchObject({ status: 502,
      response: { message: 'fetch failed [REDACTED]', cause: { cause: { code: 'ECONNREFUSED', message: 'Connection refused [REDACTED]' } } } });
  });

  it('preserves business failures carried by HTTP 200', async () => {
    const body = { error: { code: 'unsupported_parameter', message: 'seconds is required', details: { field: 'seconds' } } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    await expect(service.readCompletion(response)).rejects.toMatchObject({ status: 502, upstreamError: { status: 200, body } });
  });

  it('redacts SSE failures with the active key while preserving successful frames', async () => {
    const success = 'data: {"choices":[{"delta":{"content":"hello"}}]}\r\n\r\n';
    const failure = 'event: error\ndata: {"error":{"code":"bad_tool","message":"test-key","details":{"field":"seconds"}}}\n\n';
    fetchMock.mockResolvedValue(new Response(success + failure, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await service.forwardChatCompletion({ ...dto, stream: true }, policySnapshot());
    const text = await response.text();
    expect(text.startsWith(success)).toBe(true);
    expect(text).toContain('"code":"bad_tool"');
    expect(text).toContain('"field":"seconds"');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('test-key');
  });

  it('forces usage collection for streams even if the caller disables it', async () => {
    const snapshot = policySnapshot();
    const policy = new GatewayModelPolicyService({} as never, { platformModel: {
      findFirst: jest.fn().mockResolvedValue({ maxOutputTokens: null, supportedFeatures: null }),
    } } as never, new ConfigService());
    jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
      allowedModels: [dto.model], defaultModel: dto.model, allowUserSwitchModel: true, departmentId: null,
    });
    service = new GatewayService({} as never, new ConfigService(), {} as never, {} as never, policy);
    jest.spyOn(service, 'getSub2ApiConfig').mockResolvedValue({
      baseUrl: 'https://relay.test/v1/', apiKey: 'test-key', defaultModel: dto.model,
    });
    const input = { ...dto, stream: true, stream_options: { include_usage: false } };
    const prepared = await service.prepareRequest(enterpriseClaims, input, snapshot);
    expect(input.stream_options.include_usage).toBe(false);
    expect(prepared.request.stream_options).toEqual({ include_usage: true });
    expect(prepared.inputBytes).toBe(Buffer.byteLength(JSON.stringify(prepared.request)));
    fetchMock.mockResolvedValue(new Response('data:[DONE]\n\n'));
    const response = await service.forwardChatCompletion(prepared.request, snapshot);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(prepared.request));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ stream_options: { include_usage: true } });
    await response.body!.cancel();
  });

  it('bounds diagnostic bodies without replacing the received HTTP status', async () => {
    service = new GatewayService({} as never, new ConfigService({ GATEWAY_ERROR_MAX_BYTES: 1024 }), {} as never, {} as never, {} as never);
    jest.spyOn(service, 'getSub2ApiConfig').mockResolvedValue({ baseUrl: 'https://relay.test/v1', apiKey: 'test-key', defaultModel: dto.model });
    fetchMock.mockResolvedValue(new Response('x'.repeat(1025), { status: 429 }));
    const error = await service.forwardChatCompletion(dto, policySnapshot()).catch(error => error);
    expect(error.getStatus()).toBe(429);
    expect(error.upstreamError.body.length).toBe(1024);
    expect(error.readDiagnostics).toEqual({ truncated: true });
  });});

describe('GatewayService.prepareRequest snapshot normalization', () => {
  const request = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hello' }] };
  const snapshot = policySnapshot({ GATEWAY_DEFAULT_MAX_TOKENS: 4096, MODEL_MAX_OUTPUT_TOKENS: 32768 });
  let findFirst: jest.Mock;
  let service: GatewayService;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue({ maxOutputTokens: 1000, supportedFeatures: null });
    const policy = new GatewayModelPolicyService({} as never, { platformModel: { findFirst } } as never, new ConfigService());
    jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
      allowedModels: [request.model], defaultModel: request.model, allowUserSwitchModel: true, departmentId: null,
    });
    service = new GatewayService({} as never, new ConfigService(), {} as never, {} as never, policy);
  });

  afterEach(() => jest.restoreAllMocks());

  it('normalizes to the snapshot default without reading retired model metadata', async () => {
    const result = await service.prepareRequest(enterpriseClaims, request, snapshot);
    expect(result.request).toEqual({ ...request, max_tokens: 4096 });
    expect(result.inputBytes).toBe(Buffer.byteLength(JSON.stringify(result.request)));
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('enforces the platform ceiling and ignores invalid retired metadata', async () => {
    await expect(service.prepareRequest(enterpriseClaims, { ...request, max_tokens: 32769 }, snapshot)).rejects.toMatchObject({
      status: 400, response: { error: { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', limit: 32768, policyVersion: 7 } },
    });
    findFirst.mockResolvedValue({ maxOutputTokens: -1, supportedFeatures: null });
    await expect(service.prepareRequest(enterpriseClaims, request, snapshot)).resolves.toMatchObject({ request: { max_tokens: 4096 } });
  });

  it('leaves streaming capability checks to upstream', async () => {
    findFirst.mockResolvedValue({ maxOutputTokens: 1000, supportedFeatures: { streaming: false } });
    await expect(service.prepareRequest(enterpriseClaims, { ...request, stream: true }, snapshot)).resolves.toMatchObject({ request: { stream: true } });
  });
});

describe('GatewayService.compute credit integration', () => {
  const snapshot = policySnapshot();
  const enabledModel = { modelId: 'test-model' };
  const modelConfig = { allowedChatModels: ['test-model'] };
  const balanceAllowed = {
    allowed: true,
    enterpriseFundsAllowed: true,
    creditRemainingCNY: 0,
    walletBalanceCNY: 9699,
    memberWalletBalanceCNY: 0,
    totalAvailableCNY: 9699,
    personalBalanceCNY: 0,
  };
  let prisma: Record<string, any>;
  let creditService: { checkBalanceBeforeConversation: jest.Mock; chargeUsage: jest.Mock };
  let service: GatewayService;
  let prepare: jest.Mock;

  beforeEach(() => {
    prisma = {
      subscription: { findFirst: jest.fn().mockResolvedValue({ id: 'subscription-1', employeeId: 'employee-1' }) },
      employeeGrant: { findFirst: jest.fn().mockResolvedValue({ id: 'grant-1' }) },
      platformModel: { findMany: jest.fn().mockResolvedValue([enabledModel]) },
      enterpriseModelConfig: { findUnique: jest.fn().mockResolvedValue(modelConfig) },
    };
    creditService = {
      checkBalanceBeforeConversation: jest.fn().mockResolvedValue(balanceAllowed),
      chargeUsage: jest.fn().mockResolvedValue({
        alreadyCharged: false,
        usageRecordId: 'usage-1',
        unpaidCNY: 0,
      }),
    };
    prepare = jest.fn().mockResolvedValue({ allowedModels: ['test-model'], request: {}, inputBytes: 2 });
    service = new GatewayService(
      prisma as never,
      new ConfigService(),
      {} as never,
      creditService as never,
      { prepare } as never,
    );
  });

  it('uses the unified credit balance instead of the legacy ComputeAccount', async () => {
    const result = await service.validateAndAuthorize(enterpriseClaims);

    expect(result).toEqual({
      enterpriseId: 'enterprise-1',
      subscriptionId: 'subscription-1',
      memberId: 'member-1',
      employeeId: 'employee-1',
      paymentMode: 'AUTO',
    });
    expect(creditService.checkBalanceBeforeConversation).toHaveBeenCalledWith(
      'enterprise-1',
      'subscription-1',
      'user-1',
    );
    expect(prisma.computeAccount).toBeUndefined();
  });

  it('rejects the request when the unified credit service disallows the conversation', async () => {
    creditService.checkBalanceBeforeConversation.mockResolvedValue({
      ...balanceAllowed,
      allowed: false,
      reason: '企业和个人算力余额均不足',
    });

    await expect(service.validateAndAuthorize(enterpriseClaims)).rejects.toMatchObject({
      status: 403,
      message: '企业和个人算力余额均不足',
      response: { error: {
        message: '企业和个人算力余额均不足', code: 'INSUFFICIENT_BALANCE',
        source: 'platform', param: null, type: 'permission_error',
      } },
    });
  });

  it.each([
    ['subscription', 'SUBSCRIPTION_INACTIVE', '订阅不存在、已停用或不属于该企业'],
    ['employeeGrant', 'SUBSCRIPTION_ACCESS_DENIED', '无该订阅的使用授权或授权已过期'],
  ])('returns a stable platform contract for rejected %s', async (model, code, message) => {
    prisma[model].findFirst.mockResolvedValue(null);
    const error = await service.validateAndAuthorize(enterpriseClaims).catch((failure) => failure);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(403);
    expect(error.message).toBe(message);
    expect(error.getResponse()).toEqual({ message, error: {
      message, code, source: 'platform', param: null, type: 'permission_error',
    } });
    expect(creditService.checkBalanceBeforeConversation).not.toHaveBeenCalled();
    if (model === 'subscription') expect(prisma.employeeGrant.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the fallback balance message in the structured error', async () => {
    creditService.checkBalanceBeforeConversation.mockResolvedValue({ ...balanceAllowed, allowed: false });
    await expect(service.validateAndAuthorize(enterpriseClaims)).rejects.toMatchObject({
      status: 403,
      response: { error: {
        message: '企业算力余额不足，请联系管理员充值', code: 'INSUFFICIENT_BALANCE',
        source: 'platform', param: null, type: 'permission_error',
      } },
    });
  });

  it.each(['subscription', 'employeeGrant', 'balance', 'policy'])('propagates unknown %s errors unchanged', async (step) => {
    const failure = new Error('unexpected failure');
    if (step === 'balance') creditService.checkBalanceBeforeConversation.mockRejectedValue(failure);
    else if (step === 'policy') prepare.mockRejectedValue(failure);
    else prisma[step].findFirst.mockRejectedValue(failure);
    const operation = step === 'policy'
      ? service.prepareRequest(enterpriseClaims, { model: 'test-model', messages: [] }, snapshot)
      : service.validateAndAuthorize(enterpriseClaims);
    await expect(operation).rejects.toBe(failure);
  });

  it('delegates resource limits and effective model policy to the policy service', async () => {
    const dto = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hello' }] };
    const result = await service.prepareRequest(enterpriseClaims, dto, snapshot);
    expect(result).toEqual({ allowedModels: ['test-model'], request: {}, inputBytes: 2 });
    expect(prepare).toHaveBeenCalledWith(enterpriseClaims, dto, snapshot);
    expect(creditService.chargeUsage).not.toHaveBeenCalled();
  });
});
