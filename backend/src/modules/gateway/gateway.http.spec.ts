import { ExecutionContext, HttpException, INestApplication, Logger, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { APIError } from 'openai/error';
import { randomUUID } from 'node:crypto';
import type { ChatCompletionRequest } from 'shared';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { GatewayLifecycleService } from '../../common/lifecycle/gateway-lifecycle.service';
import { requestContextMiddleware } from '../../common/middleware/request-context.middleware';
import { createJsonBodyMiddleware } from '../../common/middleware/json-body.middleware';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewayRateLimitGuard } from './gateway-rate-limit.guard';
import { GatewayAdmissionService } from './gateway-admission.service';
import { GatewayExecutionService } from './gateway-execution.service';
import { ModelRuntimePolicyService } from '../setting/model-runtime-policy.service';
import { GatewayModelPolicyService } from './gateway-model-policy.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

const toolCall = { id: 'call_test_ls_001', type: 'function', function: { name: 'ls', arguments: '{}' } };
const tools = [{ type: 'function', function: { name: 'ls', parameters: { type: 'object' } } }];
const endpoint = '/api/gateway/v1/chat/completions';
const claims = {
  sub: 'user-1', sid: 'session-1', enterpriseId: 'enterprise-1', memberId: 'member-1', subscriptionId: 'subscription-1',
  type: 'client-employment', iat: 1, exp: 2,
};
const body = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hello' }] };
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
const completion = { choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage };

// 使用真实 Zod pipe、controller、转发 service 和全局 filter；只 mock 授权/配置/上游。
describe('Gateway tool-call HTTP round trip', () => {
  let app: INestApplication;
  let service: GatewayService;
  let fetchMock: jest.SpyInstance;
  let forwardSpy: jest.SpyInstance;
  const snapshot = policySnapshot({ GATEWAY_DEFAULT_MAX_TOKENS: 4096, MODEL_MAX_OUTPUT_TOKENS: 32768 });
  const policies = { getSnapshot: jest.fn() };
  const modelPolicy = { prepare: jest.fn() };
  const model = { findFirst: jest.fn() };
  const executions = {
    start: jest.fn(), saveUsage: jest.fn(), finish: jest.fn(), fail: jest.fn(), setUpstreamRequest: jest.fn(),
  };
  const releaseAdmission = jest.fn();
  const admission = { acquire: jest.fn(), reserve: jest.fn() };
  const releaseRequest = jest.fn();
  const lifecycle = { beginRequest: jest.fn() };

  beforeAll(async () => {
    service = new GatewayService({} as never, new ConfigService(), {} as never, {} as never, modelPolicy as never);
    jest.spyOn(service, 'validateAndAuthorize').mockResolvedValue({
      enterpriseId: 'enterprise-1', subscriptionId: 'subscription-1', memberId: 'member-1', employeeId: 'employee-1',
    });
    jest.spyOn(service, 'getSub2ApiConfig').mockResolvedValue({
      baseUrl: 'https://relay.test/v1', apiKey: 'test-key', defaultModel: 'deepseek-v4.1-flash',
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [GatewayController], providers: [
        { provide: GatewayService, useValue: service },
        { provide: GatewayExecutionService, useValue: executions },
        { provide: GatewayAdmissionService, useValue: admission },
        { provide: GatewayLifecycleService, useValue: lifecycle },
        { provide: ModelRuntimePolicyService, useValue: policies },
      ],
    }).overrideGuard(ClientEmploymentGuard).useValue({
      canActivate: (context: ExecutionContext) => {
        context.switchToHttp().getRequest().clientEmployment = { ...claims };
        return true;
      },
    }).overrideGuard(GatewayRateLimitGuard).useValue({
      canActivate: async (context: ExecutionContext) => {
        context.switchToHttp().getRequest().modelRuntimePolicy = await policies.getSnapshot();
        return true;
      },
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix('api');
    app.use(requestContextMiddleware);
    app.use(createJsonBodyMiddleware({}));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    policies.getSnapshot.mockReset().mockResolvedValue(snapshot);
    model.findFirst.mockReset().mockResolvedValue({ maxOutputTokens: null, supportedFeatures: null });
    const resourcePolicy = new GatewayModelPolicyService({} as never, { platformModel: model } as never, new ConfigService());
    modelPolicy.prepare.mockReset().mockImplementation(async (_claims, dto: ChatCompletionRequest, policy) => {
      const checked = await resourcePolicy.validateResources(dto, {
        allowedModels: [dto.model], defaultModel: dto.model, allowUserSwitchModel: true, departmentId: null,
      }, policy);
      return { ...checked, allowedModels: [dto.model] };
    });
    executions.start.mockReset().mockImplementation(async () => ({ id: randomUUID() }));
    for (const mock of [executions.saveUsage, executions.finish, executions.fail, executions.setUpstreamRequest, releaseAdmission]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    admission.acquire.mockReset().mockResolvedValue({ release: releaseAdmission });
    admission.reserve.mockReset().mockResolvedValue(undefined);
    releaseRequest.mockReset();
    lifecycle.beginRequest.mockReset().mockReturnValue(releaseRequest);
    fetchMock = jest.spyOn(global, 'fetch');
    forwardSpy = jest.spyOn(service, 'forwardChatCompletion');
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    fetchMock.mockRestore();
    forwardSpy.mockRestore();
    for (const method of ['log', 'warn', 'error'] as const) (Logger.prototype[method] as jest.Mock).mockRestore();
  });
  afterAll(async () => { await app?.close(); jest.restoreAllMocks(); });

  it.each([false, true])('preserves first and follow-up requests with stream=%s', async (stream) => {
    const assistant = { role: 'assistant', content: null, tool_calls: [toolCall], reasoning_content: 'Inspect files.' };
    const first = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '列出文件' }], tools, tool_choice: 'auto', stream };
    const second = {
      ...first,
      messages: [...first.messages, assistant, { role: 'tool', tool_call_id: toolCall.id, content: 'a.txt\nb.txt' }],
    };
    // SSE 参数分片保持原样透传，组装工具调用是客户端职责。
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall, function: { name: 'ls', arguments: '{' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    fetchMock.mockImplementation(async () => new Response(stream ? sse : JSON.stringify({ choices: [{ message: assistant, finish_reason: 'tool_calls' }] }), {
      headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' },
    }));
    for (const body of [first, second]) {
      const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(200);
      const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
      expect(JSON.parse(init.body)).toEqual({
        ...body, max_tokens: 4096, ...(stream ? { stream_options: { include_usage: true } } : {}),
      });
      expect(admission.reserve.mock.calls[fetchMock.mock.calls.length - 1]).toEqual([
        claims, snapshot, JSON.parse(init.body), 4096,
      ]);
      expect(forwardSpy.mock.calls[fetchMock.mock.calls.length - 1][1]).toBe(snapshot);
      if (stream) {
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.text).toBe(sse);
      } else {
        expect(res.body.choices[0].message).toEqual(assistant);
      }
    }
    expect(executions.start).toHaveBeenCalledTimes(2);
    expect(executions.finish).toHaveBeenCalledTimes(2);
    expect(releaseAdmission).toHaveBeenCalledTimes(2);
    expect(releaseRequest).toHaveBeenCalledTimes(2);
    expect(policies.getSnapshot).toHaveBeenCalledTimes(2);
    expect(admission.acquire).toHaveBeenCalledTimes(2);
    expect(admission.reserve).toHaveBeenCalledTimes(2);
  });

  it('forwards multimodal user content unchanged through the HTTP gateway', async () => {
    model.findFirst.mockResolvedValue({ maxOutputTokens: null, supportedFeatures: { vision: true } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const imageRequest = { model: body.model, messages: [{ role: 'user', content: [
      { type: 'text', text: '理解一下这张图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ] }] };
    await request(app.getHttpServer()).post(endpoint).send(imageRequest).expect(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages).toEqual(imageRequest.messages);
    expect(sent.max_tokens).toBe(4096);
  });

  it.each([4096, 8192, 16384, 32768])('forwards explicit output budget %s with unknown model capability', async (max_tokens) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await request(app.getHttpServer()).post(endpoint).send({ ...body, max_tokens }).expect(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(max_tokens);
    expect(admission.reserve.mock.calls[0][3]).toBe(max_tokens);
  });

  it.each([undefined, 65536])('forwards upstream-managed requests without adding or shrinking budget %p', async (max_tokens) => {
    policies.getSnapshot.mockResolvedValue(policySnapshot());
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion), { headers: { 'Content-Type': 'application/json' } }));
    await request(app.getHttpServer()).post(endpoint).send({ ...body, ...(max_tokens === undefined ? {} : { max_tokens }) }).expect(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    if (max_tokens === undefined) expect(sent).not.toHaveProperty('max_tokens');
    else expect(sent.max_tokens).toBe(65536);
    expect(sent).not.toHaveProperty('max_completion_tokens');
    expect(admission.reserve.mock.calls[0][3]).toBe(max_tokens);
  });

  it.each([
    [null, 8192, 8192],
    [65536, 8192, 8192],
    [2048, 32768, 2048],
  ])('returns the effective output ceiling before execution for model=%p platform=%s', async (maxOutputTokens, platformLimit, limit) => {
    policies.getSnapshot.mockResolvedValue(policySnapshot({ MODEL_MAX_OUTPUT_TOKENS: platformLimit }));
    model.findFirst.mockResolvedValue({ maxOutputTokens, supportedFeatures: null });
    const res = await request(app.getHttpServer()).post(endpoint).send({ ...body, max_tokens: limit + 1 }).expect(400);
    expect(res.body.error).toMatchObject({
      code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', source: 'platform', param: 'max_tokens', limit, policyVersion: 7,
    });
    expect(res.body.requestId).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(admission.reserve).not.toHaveBeenCalled();
  });

  it('uses distinct server executions and usage journal entries for repeated client IDs', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(completion), {
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'upstream-request' },
    }));
    const responses = [];
    for (let i = 0; i < 2; i++) {
      responses.push(await request(app.getHttpServer()).post(endpoint)
        .set('x-request-id', 'same-client-request').set('x-sep-session-id', 'same-client-session')
        .set('x-sep-message-id', 'same-client-message').send(body).expect(200));
    }
    const ids = responses.map((res) => res.headers['x-sep-execution-id']);
    expect(ids.every((id) => typeof id === 'string' && id !== 'same-client-message' && id !== 'same-client-request')).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(executions.start).toHaveBeenCalledTimes(2);
    for (const id of ids) {
      expect(admission.acquire).toHaveBeenCalledWith(claims, snapshot);
      expect(admission.reserve).toHaveBeenCalledWith(claims, snapshot, { ...body, max_tokens: 4096 }, 4096);
      expect(executions.setUpstreamRequest).toHaveBeenCalledWith(id, 'upstream-request');
      expect(executions.saveUsage).toHaveBeenCalledWith(id, usage);
      expect(executions.finish).toHaveBeenCalledWith(id, { finishReason: 'stop' });
    }
    expect(executions.start).toHaveBeenNthCalledWith(1, claims, 'employee-1', body.model, 'same-client-request', snapshot, undefined);
    expect(executions.start).toHaveBeenNthCalledWith(2, claims, 'employee-1', body.model, 'same-client-request', snapshot, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executions.fail).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(2);
    expect(releaseRequest).toHaveBeenCalledTimes(2);
  });

  it.each(['stop', 'length', 'tool_calls', 'provider_specific_reason', ' provider_specific_reason '])(
    'records the verified non-stream finish_reason %s', async (finishReason) => {
      const message = finishReason === 'tool_calls'
        ? { role: 'assistant', content: null, tool_calls: [toolCall], reasoning_content: 'Inspect files.' }
        : { role: 'assistant', content: 'hello', reasoning_content: 'Ready.' };
      const upstream = {
        choices: [{ message, finish_reason: finishReason }],
        usage,
      };
      fetchMock.mockResolvedValue(new Response(JSON.stringify(upstream), {
        headers: { 'Content-Type': 'application/json' },
      }));
      const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(200);
      expect(res.body).toEqual(upstream);
      expect(executions.saveUsage).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], usage);
      expect(executions.finish).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], {
        finishReason,
      });
      expect(executions.fail).not.toHaveBeenCalled();
    },
  );

  it('does not acquire or fetch when journal creation fails', async () => {
    executions.start.mockRejectedValue(new ServiceUnavailableException({ error: {
      code: 'EXECUTION_JOURNAL_UNAVAILABLE', source: 'platform', message: 'Journal unavailable',
    } }));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(503);
    expect(res.body.error).toMatchObject({ code: 'EXECUTION_JOURNAL_UNAVAILABLE', source: 'platform' });
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executions.fail).not.toHaveBeenCalled();
    expect(releaseAdmission).not.toHaveBeenCalled();
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('returns draining 503 without creating an execution or forwarding', async () => {
    lifecycle.beginRequest.mockImplementation(() => { throw new ServiceUnavailableException({ error: {
      code: 'SERVER_DRAINING', source: 'platform', message: 'Gateway instance is draining',
    } }); });
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(503);
    expect(res.body.error).toMatchObject({ code: 'SERVER_DRAINING', source: 'platform' });
    expect(modelPolicy.prepare).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseRequest).not.toHaveBeenCalled();
  });

  it('marks the execution failed without forwarding when admission rejects', async () => {
    admission.acquire.mockRejectedValue(new HttpException({ error: {
      code: 'PLATFORM_CONCURRENCY_LIMIT_EXCEEDED', source: 'platform', message: 'Concurrency exceeded',
    }, retryAfterSeconds: 12 }, 429));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(429);
    expect(res.body.error).toMatchObject({ code: 'PLATFORM_CONCURRENCY_LIMIT_EXCEEDED', source: 'platform' });
    expect(res.headers['retry-after']).toBe('12');
    expect(executions.fail).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], 'PLATFORM_CONCURRENCY_LIMIT_EXCEEDED', true, false);
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseAdmission).not.toHaveBeenCalled();
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['application/json', 'text/html', 'text/plain'])('rejects streaming MIME %s as JSON 502 before SSE headers', async (mime) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion), { headers: { 'Content-Type': mime } }));
    const res = await request(app.getHttpServer()).post(endpoint).send({ ...body, stream: true }).expect(502);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_INVALID_CONTENT_TYPE', source: 'upstream' });
    expect(res.headers['x-accel-buffering']).toBeUndefined();
    expect(executions.fail).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], 'UPSTREAM_INVALID_CONTENT_TYPE', false, false);
    expect(executions.saveUsage).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { choices: [] }, { choices: [null] }, { choices: [{}] },
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: null }] },
    { choices: [{ message: { role: 'assistant', content: 'partial' } }] },
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: ' \t\n' }] },
  ])('rejects incomplete JSON choices %j but retains billable usage', async ({ choices }) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices, usage }), { headers: { 'Content-Type': 'application/json' } }));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(502);
    expect(res.body.error.code).toBe('UPSTREAM_INVALID_COMPLETION');
    expect(executions.fail).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], 'UPSTREAM_INVALID_COMPLETION', false, false);
    expect(executions.saveUsage).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], usage);
    expect(executions.finish).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('freezes uncertain usage when a nonstream checkpoint fails instead of returning success', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion), { headers: { 'Content-Type': 'application/json' } }));
    executions.saveUsage.mockRejectedValue(new HttpException({ error: {
      code: 'EXECUTION_USAGE_CHECKPOINT_REJECTED', source: 'platform', message: 'Usage needs reconciliation',
    } }, 503));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(503);
    expect(res.body.error.code).toBe('EXECUTION_USAGE_CHECKPOINT_REJECTED');
    expect(executions.fail).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], 'EXECUTION_USAGE_CHECKPOINT_REJECTED', false, true);
    expect(executions.finish).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, true])('forces upstream include_usage when the client supplied %p', async (includeUsage) => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage })}\n\n` + 'data: [DONE]\n\n';
    fetchMock.mockResolvedValue(new Response(sse, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
    const payload = { ...body, stream: true, ...(includeUsage === undefined ? {} : { stream_options: { include_usage: includeUsage } }) };
    const res = await request(app.getHttpServer()).post(endpoint).send(payload).expect(200);
    expect(res.text).toBe(sse);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...payload, max_tokens: 4096, stream_options: { include_usage: true } });
    expect(executions.saveUsage).toHaveBeenCalledTimes(1);
    expect(executions.saveUsage).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], usage);
    expect(executions.finish).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], { finishReason: 'stop', done: true, errorCode: undefined });
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('accepts an effective finish_reason without fabricating a missing DONE', async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`;
    fetchMock.mockResolvedValue(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    const res = await request(app.getHttpServer()).post(endpoint).send({ ...body, stream: true }).expect(200);
    expect(res.text).toBe(sse);
    expect(res.text).not.toContain('[DONE]');
    expect(executions.saveUsage).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], usage);
    expect(executions.finish).toHaveBeenCalledWith(res.headers['x-sep-execution-id'], { finishReason: 'stop', done: false, errorCode: undefined });
    expect(executions.fail).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('aborts incomplete SSE at EOF while persisting observed usage and releasing resources', async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }], usage })}\n\n` + 'data: [DONE]\n\n';
    fetchMock.mockResolvedValue(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(request(app.getHttpServer()).post(endpoint).send({ ...body, stream: true }))
      .rejects.toThrow(/aborted|socket hang up|ECONNRESET/);
    await new Promise((resolve) => setImmediate(resolve));
    const { id } = await executions.start.mock.results[0].value;
    expect(executions.saveUsage).toHaveBeenCalledWith(id, usage);
    expect(executions.finish).toHaveBeenCalledWith(id, { finishReason: null, done: true, errorCode: 'UPSTREAM_INCOMPLETE_STREAM' });
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('reproduces the SDK no-body message for the legacy nonempty Nest error envelope', () => {
    const error = APIError.generate(400, { statusCode: 400, message: '请求参数校验失败' }, undefined, new Headers());
    expect(error.message).toBe('400 status code (no body)');
  });

  it('returns actionable validation errors instead of the SDK no-body fallback', async () => {
    const res = await request(app.getHttpServer()).post(endpoint).set('x-request-id', 'test-validation').send({
      model: 'deepseek-v4.1-flash', messages: [{ role: 'tool', content: 'a.txt' }], stream: true,
    }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toMatchObject({ code: 'INVALID_PARAMETER', param: 'messages.0.tool_call_id', requestId: 'test-validation' });
    const sdkError = APIError.generate(400, res.body, undefined, new Headers({ 'x-request-id': 'test-validation' }));
    expect(sdkError.message).toContain('tool_call_id');
    expect(sdkError.message).not.toContain('(no body)');
  });

  it.each(['response_format', 'max_completion_tokens', 'top_p', 'stop'])(
    'rejects unsupported %s before starting a billable execution or calling upstream', async (field) => {
      const res = await request(app.getHttpServer()).post(endpoint).send({ ...body, [field]: 'unsupported' }).expect(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_PARAMETER', source: 'platform', param: field });
      expect(res.body.errors).toEqual([{ field, message: '不支持的请求字段' }]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(executions.start).not.toHaveBeenCalled();
      expect(admission.acquire).not.toHaveBeenCalled();
    },
  );

  it('reports the exact nested field rather than the root when rejecting an unknown option', async () => {
    const res = await request(app.getHttpServer()).post(endpoint).send({
      ...body, stream_options: { include_usage: true, unsupported: true },
    }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_PARAMETER', param: 'stream_options.unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a valid history above 2 MiB through the model-specific parser', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion)));
    await request(app.getHttpServer()).post(endpoint).send({
      model: body.model, messages: Array.from({ length: 3 }, () => ({ role: 'user', content: 'a'.repeat(800000) })),
    }).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429, 503])('returns upstream %s with JSON before any SSE headers', async (status) => {
    const error = { message: 'Tool message rejected', type: 'invalid_request_error', code: 'INVALID_TOOL_MESSAGE', param: 'messages[2].tool_call_id' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error }), { status }));
    const res = await request(app.getHttpServer()).post(endpoint).set('x-request-id', 'test-upstream').send({
      model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hello' }], stream: true,
    }).expect(status);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toMatchObject({ ...error, requestId: 'test-upstream' });
    expect(res.headers['x-request-id']).toBe('test-upstream');
    if (status === 429) {
      expect(res.body.error.source).toBe('upstream');
      expect(res.headers['retry-after']).toBe('60');
    }
  });

  it('preserves upstream waiting information and forwards the platform correlation id', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Please wait' } }), {
      status: 429, headers: { 'Retry-After': '7', 'x-request-id': 'relay-123' },
    }));
    const res = await request(app.getHttpServer()).post(endpoint).set('x-request-id', 'platform-123').send({
      model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hello' }], stream: true,
    }).expect(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toMatchObject({ source: 'upstream', code: 'UPSTREAM_RATE_LIMIT_EXCEEDED', requestId: 'platform-123' });
    expect(fetchMock.mock.calls[0][1].headers['x-request-id']).toBe('platform-123');
    expect(res.body.error.rateLimit).toBeUndefined();
  });

  it('releases concurrency on resource rejection and never calls upstream', async () => {
    admission.reserve.mockRejectedValue(new HttpException({ error: {
      message: 'Budget exceeded', type: 'rate_limit_error', source: 'platform',
      code: 'PLATFORM_ADMISSION_REJECTED', rule: 'enterprise-resource-budget',
      dimension: 'enterprise', limit: 1000, count: 900, resetAt: 1060000, policyVersion: 7,
    }, retryAfterSeconds: 4 }, 429));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(429);
    expect(res.body.error).toMatchObject({ source: 'platform', rule: 'enterprise-resource-budget', policyVersion: 7 });
    expect(res.headers['retry-after']).toBe('4');
    expect(policies.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledTimes(1);
    expect(admission.reserve).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
    expect(executions.fail).toHaveBeenCalledWith(expect.any(String), 'PLATFORM_ADMISSION_REJECTED', true, false);
  });

  it('rejects explicit output overflow without admission or upstream calls', async () => {
    const res = await request(app.getHttpServer()).post(endpoint).send({ ...body, max_tokens: 32769 }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', policyVersion: 7, limit: 32768 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(admission.reserve).not.toHaveBeenCalled();
    expect(releaseAdmission).not.toHaveBeenCalled();
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('uses each request snapshot for normalization, journal expiry, reservation and forwarding', async () => {
    const snapshots = [policySnapshot({ GATEWAY_DEFAULT_MAX_TOKENS: 1000 }, 7),
      policySnapshot({ GATEWAY_DEFAULT_MAX_TOKENS: 2000 }, 8)];
    policies.getSnapshot.mockResolvedValueOnce(snapshots[0]).mockResolvedValueOnce(snapshots[1]);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(completion)));
    for (let i = 0; i < snapshots.length; i++) {
      await request(app.getHttpServer()).post(endpoint).send(body).expect(200);
      const expected = { ...body, max_tokens: snapshots[i].values.GATEWAY_DEFAULT_MAX_TOKENS };
      expect(modelPolicy.prepare.mock.calls[i][2]).toBe(snapshots[i]);
      expect(executions.start.mock.calls[i][4]).toBe(snapshots[i]);
      expect(admission.acquire.mock.calls[i][1]).toBe(snapshots[i]);
      expect(admission.reserve.mock.calls[i]).toEqual([claims, snapshots[i], expected, expected.max_tokens]);
      expect(forwardSpy.mock.calls[i][1]).toBe(snapshots[i]);
      expect(fetchMock.mock.calls[i][1].body).toBe(JSON.stringify(expected));
    }
    expect(policies.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('fails closed on policy read failure before authorization, execution or admission', async () => {
    policies.getSnapshot.mockRejectedValue(new ServiceUnavailableException({ error: {
      code: 'MODEL_RUNTIME_POLICY_UNAVAILABLE', source: 'platform', message: 'Policy unavailable',
    } }));
    const res = await request(app.getHttpServer()).post(endpoint).send(body).expect(503);
    expect(res.body.error.code).toBe('MODEL_RUNTIME_POLICY_UNAVAILABLE');
    expect(modelPolicy.prepare).not.toHaveBeenCalled();
    expect(executions.start).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lifecycle.beginRequest).not.toHaveBeenCalled();
  });
});
