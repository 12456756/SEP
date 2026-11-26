import { enterpriseConnectionStub } from '../../../test/stubs/enterprise-connection.stub';
import {
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as aiSdk from 'ai';
import * as openAiCompatible from '@ai-sdk/openai-compatible';
import { DigitalEmployeeRunner } from './digital-employee.runner';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import {
  MODEL_RUNTIME_POLICY_FIELDS,
  SETTING_KEYS,
  type ModelRuntimePolicySnapshot,
} from 'shared';

const snapshot: ModelRuntimePolicySnapshot = {
  version: 17,
  values: Object.fromEntries(
    MODEL_RUNTIME_POLICY_FIELDS.map((field) => [
      field.key,
      Number(field.defaultValue),
    ]),
  ) as ModelRuntimePolicySnapshot['values'],
};

const now = new Date('2026-10-08T06:00:00Z');
const member = {
  id: 'member-1',
  enterpriseId: 'enterprise-1',
  role: 'MEMBER',
  departmentId: 'department-1',
};
const employee = {
  id: 'employee-1',
  name: 'Test employee',
  systemPrompt: 'Test prompt',
  modelId: 'test-model',
  maxSteps: 3,
  bindings: ['cap-1', 'cap-2'].map((id, index) => ({
    capability: {
      id,
      name: `Tool ${index + 1}`,
      description: 'Test tool',
      inputSchema: {},
      type: 'SKILL',
    },
  })),
};

describe('DigitalEmployeeRunner execution context', () => {
  let prisma: any;
  let capabilityService: any;
  let runner: DigitalEmployeeRunner;
  let generateText: jest.SpyInstance;
  let runtimePolicy: any;
  let admission: any;
  let release: jest.Mock;
  let upstream: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma = {
      digitalEmployee: {
        findUnique: jest.fn().mockResolvedValue(employee),
      },
      enterpriseMember: {
        findFirst: jest.fn().mockResolvedValue(member),
      },
      subscription: {
        findFirst: jest.fn().mockResolvedValue({ id: 'subscription-1' }),
      },
      platformModel: {
        findUnique: jest.fn().mockResolvedValue({ maxOutputTokens: 1200 }),
      },
    };
    capabilityService = {
      execute: jest
        .fn()
        .mockResolvedValue({ success: true, output: 'tool result' }),
    };
    const settings = {
      getEffectiveValue: jest.fn(
        async (key: string) =>
          ({
            [SETTING_KEYS.SUB2API_BASE_URL]: 'https://relay.example/v1',
            [SETTING_KEYS.SUB2API_API_KEY]: 'test-key',
            [SETTING_KEYS.SUB2API_DEFAULT_MODEL]: 'settings-model',
          })[key],
      ),
    };
    runtimePolicy = { getSnapshot: jest.fn().mockResolvedValue({ ...snapshot,
      values: { ...snapshot.values, WEB_DEFAULT_MAX_OUTPUT_TOKENS: 4096 } }) };
    release = jest.fn().mockResolvedValue(undefined);
    admission = {
      acquire: jest.fn().mockResolvedValue({ release }),
      reserve: jest.fn().mockResolvedValue(undefined),
    };
    upstream = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));
    jest
      .spyOn(openAiCompatible, 'createOpenAICompatible')
      .mockReturnValue(jest.fn().mockReturnValue({}) as any);
    // 真正调用 runner 组装出的工具，但不调用模型、适配器或数据库。
    generateText = jest
      .spyOn(aiSdk, 'generateText')
      .mockImplementation(async (options: any) => {
        const outputs = [];
        for (const tool of Object.values(options.tools ?? {}) as any[]) {
          outputs.push(await tool.execute({ input: 'tool input' }));
        }
        return { text: outputs.join('|'), steps: [{}] } as any;
      });
    runner = new DigitalEmployeeRunner(
      prisma,
      capabilityService,
      settings as any,
      runtimePolicy,
      admission,
      new GatewayModelPolicyService({} as never, {} as never, {} as never),
      enterpriseConnectionStub('https://relay.example/v1') as never,
      { checkBalanceBeforeConversation: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('passes the authorized subscription and actual user to every bound tool', async () => {
    const result = await runner.run(
      'employee-1',
      'Hello',
      'session-1',
      'user-1',
    );

    expect(prisma.enterpriseMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, enterpriseId: true, role: true, departmentId: true },
    });
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: {
        enterpriseId: 'enterprise-1',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: now } }],
        grants: {
          some: {
            OR: [{ memberId: 'member-1' }, { departmentId: 'department-1' }],
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
          },
        },
      },
      select: { id: true },
    });
    for (const capabilityId of ['cap-1', 'cap-2']) {
      expect(capabilityService.execute).toHaveBeenCalledWith(
        capabilityId,
        {
          userMessage: JSON.stringify({ input: 'tool input' }),
          sessionId: 'session-1',
          userId: 'user-1',
        },
        { subscriptionId: 'subscription-1', userId: 'user-1' },
      );
    }
    expect(capabilityService.execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      text: 'tool result|tool result',
      stepsCount: 1,
      employeeId: 'employee-1',
      employeeName: 'Test employee',
    });
  });

  it('correlates policy and tool logs without logging prompts or employee/capability names', async () => {
    const secret = 'private-runner-prompt-and-name';
    prisma.digitalEmployee.findUnique.mockResolvedValueOnce({
      ...employee,
      name: secret,
      systemPrompt: secret,
      bindings: employee.bindings.map((binding, index) => ({
        capability: { ...binding.capability, name: `${secret}-${index}` },
      })),
    });

    await runner.run('employee-1', secret, 'session-1', 'user-1');

    const logs = (Logger.prototype.log as jest.Mock).mock.calls.map(
      ([line]) => line,
    );
    expect(logs).toHaveLength(3);
    const requestId = logs[0].match(/requestId=([\w-]+)/)?.[1];
    expect(requestId).toMatch(/^[\da-f]{8}-[\da-f-]{27}$/i);
    for (const log of logs) {
      expect(log).toContain(`requestId=${requestId}`);
      expect(log).toContain(
        'sessionId=session-1 chain=digital-employee policyVersion=17',
      );
      expect(log).not.toContain(secret);
    }
    expect(logs[0]).toContain('employeeId=employee-1');
    expect(logs[1]).toContain('capabilityId=cap-1');
    expect(logs[2]).toContain('capabilityId=cap-2');
  });

  it('does not match null department grants for an unassigned member', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue({
      ...member,
      departmentId: null,
    });

    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');

    expect(
      prisma.subscription.findFirst.mock.calls[0][0].where.grants.some.OR,
    ).toEqual([{ memberId: 'member-1' }]);
  });

  it('does not give department managers the enterprise-admin grant exemption', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue({
      ...member,
      role: 'DEPT_MANAGER',
    });

    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');

    expect(
      prisma.subscription.findFirst.mock.calls[0][0].where.grants.some.OR,
    ).toEqual([{ memberId: 'member-1' }, { departmentId: 'department-1' }]);
  });

  it('allows enterprise admins to resolve an active subscription without a grant', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue({
      ...member,
      role: 'ENTERPRISE_ADMIN',
    });

    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');

    expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
      where: {
        enterpriseId: 'enterprise-1',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: now } }],
      },
      select: { id: true },
    });
    expect(capabilityService.execute.mock.calls[0][2]).toEqual({
      subscriptionId: 'subscription-1',
      userId: 'user-1',
    });
  });

  it('rejects anonymous previews before any upstream call or admission', async () => {
    await expect(
      runner.run('employee-1', 'Preview', 'session-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.enterpriseMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
  });

  it('rejects authenticated previews without a real enterprise member', async () => {
    prisma.enterpriseMember.findFirst.mockResolvedValue(null);

    await expect(
      runner.run('employee-1', 'Preview', 'session-1', 'platform-user'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
  });

  it('preserves previews without an eligible subscription and never borrows another tenant subscription', async () => {
    // findFirst 的条件已包含企业、员工、订阅期限和 Grant 期限。
    // 无订阅、订阅停用/过期、Grant 缺失/过期均由查询返回 null。
    prisma.subscription.findFirst.mockResolvedValue(null);

    await runner.run('employee-1', 'Preview', 'session-1', 'user-1');

    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        enterpriseId: 'enterprise-1',
        employeeId: 'employee-1',
      }),
    );
    expect(
      capabilityService.execute.mock.calls.map((call: any[]) => call[2]),
    ).toEqual([{ userId: 'user-1' }, { userId: 'user-1' }]);
  });

  it('does not swallow subscription lookup failures and fall back to preview', async () => {
    const error = new Error('Database unavailable');
    prisma.subscription.findFirst.mockRejectedValue(error);

    await expect(
      runner.run('employee-1', 'Hello', 'session-1', 'user-1'),
    ).rejects.toBe(error);

    expect(generateText).not.toHaveBeenCalled();
    expect(capabilityService.execute).not.toHaveBeenCalled();
  });

  it('retains the tool error response', async () => {
    capabilityService.execute.mockResolvedValue({
      success: false,
      error: 'Tool failed',
    });

    const result = await runner.run(
      'employee-1',
      'Hello',
      'session-1',
      'user-1',
    );

    expect(result.text).toBe('Error: Tool failed|Error: Tool failed');
  });

  it('retains employee-not-found behavior before looking up the execution context', async () => {
    prisma.digitalEmployee.findUnique.mockResolvedValue(null);

    await expect(
      runner.run('missing', 'Hello', 'session-1', 'user-1'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.enterpriseMember.findFirst).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('uses one snapshot/admission and reserves every complete SDK request before upstream dispatch', async () => {
    const requests = [
      {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ type: 'function', function: { name: 'tool_1' } }],
        max_tokens: 1200,
      },
      {
        model: 'test-model',
        messages: [
          { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
        ],
        max_tokens: 1200,
      },
    ];
    generateText.mockImplementationOnce(async (options) => {
      const providerOptions = (
        openAiCompatible.createOpenAICompatible as jest.Mock
      ).mock.calls[0][0];
      for (const request of requests) {
        options.prepareStep();
        await providerOptions.fetch(
          'https://relay.example/v1/chat/completions',
          { method: 'POST', body: JSON.stringify(request) },
        );
      }
      return { text: 'done', steps: [{}, {}] };
    });

    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');

    expect(runtimePolicy.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledWith(
      { enterpriseId: member.enterpriseId, memberId: member.id },
      { ...snapshot, values: { ...snapshot.values, WEB_DEFAULT_MAX_OUTPUT_TOKENS: 4096 } },
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 4096,
        prepareStep: expect.any(Function),
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(generateText.mock.calls[0][0].maxRetries).toBe(0);
    expect(openAiCompatible.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://relay.example/v1',
        apiKey: 'test-key',
      }),
    );
    expect(admission.reserve).toHaveBeenCalledTimes(2);
    requests.forEach((request, index) => {
      expect(admission.reserve).toHaveBeenNthCalledWith(
        index + 1,
        { enterpriseId: member.enterpriseId, memberId: member.id },
        { ...snapshot, values: { ...snapshot.values, WEB_DEFAULT_MAX_OUTPUT_TOKENS: 4096 } },
        request,
        4096,
      );
      expect(admission.reserve.mock.invocationCallOrder[index]).toBeLessThan(
        upstream.mock.invocationCallOrder[index],
      );
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reserves once across SDK retries but reserves again for a new logical step even with the same body', async () => {
    const request = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1200,
    };
    const transient = new Error('upstream temporarily unavailable');
    upstream.mockRejectedValueOnce(transient);
    generateText.mockImplementationOnce(async (options) => {
      const { fetch } = (openAiCompatible.createOpenAICompatible as jest.Mock)
        .mock.calls[0][0];
      const dispatch = () =>
        fetch('https://relay.example/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify(request),
        });
      options.prepareStep();
      await expect(dispatch()).rejects.toMatchObject({ status: 502, response: { message: transient.message, cause: { name: 'Error', message: transient.message } } });
      await dispatch();
      options.prepareStep();
      await dispatch();
      return { text: 'done', steps: [{}, {}] };
    });

    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');

    expect(generateText.mock.calls[0][0].maxRetries).toBe(0);
    expect(runtimePolicy.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledTimes(1);
    expect(admission.reserve).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(admission.reserve.mock.invocationCallOrder[1]).toBeLessThan(
      upstream.mock.invocationCallOrder[2],
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('memoizes a failed reservation within one SDK step without dispatching or reserving again', async () => {
    const error = new ServiceUnavailableException({
      code: 'PLATFORM_ADMISSION_UNAVAILABLE',
    });
    admission.reserve.mockRejectedValueOnce(error);
    generateText.mockImplementationOnce(async (options) => {
      const { fetch } = (openAiCompatible.createOpenAICompatible as jest.Mock)
        .mock.calls[0][0];
      options.prepareStep();
      const dispatch = () =>
        fetch('https://relay.example/v1/chat/completions', {
          body: JSON.stringify({ model: 'test-model', max_tokens: 1200 }),
        });
      await expect(dispatch()).rejects.toBe(error);
      return dispatch();
    });

    await expect(
      runner.run('employee-1', 'Hello', 'session-1', 'user-1'),
    ).rejects.toBe(error);
    expect(admission.reserve).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not start the SDK or reserve on admission rejection', async () => {
    const error = new HttpException(
      { code: 'PLATFORM_ADMISSION_REJECTED' },
      429,
    );
    admission.acquire.mockRejectedValueOnce(error);
    await expect(
      runner.run('employee-1', 'Hello', 'session-1', 'user-1'),
    ).rejects.toBe(error);
    expect(generateText).not.toHaveBeenCalled();
    expect(admission.reserve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('preserves reserve failures, blocks upstream dispatch and releases admission', async () => {
    const error = new ServiceUnavailableException({
      code: 'PLATFORM_ADMISSION_UNAVAILABLE',
    });
    admission.reserve.mockRejectedValueOnce(error);
    generateText.mockImplementationOnce(async () => {
      const { fetch } = (openAiCompatible.createOpenAICompatible as jest.Mock)
        .mock.calls[0][0];
      await fetch('https://relay.example/v1/chat/completions', {
        body: JSON.stringify({ model: 'test-model', max_tokens: 1200 }),
      });
    });
    await expect(
      runner.run('employee-1', 'Hello', 'session-1', 'user-1'),
    ).rejects.toBe(error);
    expect(upstream).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases admission when generation fails', async () => {
    const error = new Error('upstream failed');
    generateText.mockRejectedValueOnce(error);
    await expect(
      runner.run('employee-1', 'Hello', 'session-1', 'user-1'),
    ).rejects.toMatchObject({ status: 502, response: { message: error.message, cause: { name: 'Error', message: error.message } } });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole tool loop and releases admission on timeout', async () => {
    runtimePolicy.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      values: { ...snapshot.values, WEB_MODEL_TOTAL_TIMEOUT_MS: 1000 },
    });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    generateText.mockImplementationOnce(() => {
      started();
      return new Promise(() => undefined);
    });
    const result = runner.run('employee-1', 'Hello', 'session-1', 'user-1');
    const rejected = expect(result).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MODEL_REQUEST_TIMEOUT' }),
    });
    await pending;
    expect(release).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('omits the SDK output budget when following upstream', async () => {
    runtimePolicy.getSnapshot.mockResolvedValueOnce(snapshot);
    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');
    expect(generateText.mock.calls[0][0]).not.toHaveProperty('maxOutputTokens');
  });

  it('uses platform output limits and the settings model when model metadata is unknown', async () => {
    prisma.digitalEmployee.findUnique.mockResolvedValueOnce({
      ...employee,
      modelId: null,
    });
    prisma.platformModel.findUnique.mockResolvedValueOnce(null);
    runtimePolicy.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      values: { ...snapshot.values, MODEL_MAX_OUTPUT_TOKENS: 600 },
    });
    await runner.run('employee-1', 'Hello', 'session-1', 'user-1');
    expect(prisma.platformModel.findUnique).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 600 }),
    );
  });
});
