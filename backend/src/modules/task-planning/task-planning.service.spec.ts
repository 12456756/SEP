import { BadRequestException, GatewayTimeoutException, HttpException, Logger } from '@nestjs/common';
import { MODEL_RUNTIME_POLICY_FIELDS } from 'shared';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { TaskPlanningService } from './task-planning.service';

describe('TaskPlanningService', () => {
  const subscriptions = { findAll: jest.fn() };
  const prisma = {
    digitalEmployee: { findMany: jest.fn() },
    employeeGrant: { findMany: jest.fn() },
    platformModel: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const enterpriseContext = {
    resolve: jest.fn().mockResolvedValue({
      enterpriseId: 'enterprise-1',
      memberId: 'member-1',
      departmentId: null,
    }),
  };
  const config = { get: jest.fn((key: string, fallback?: string) => {
    // SUB2API_PLANNER_MODEL 之外的键都由系统设置回答了，这里只留规划器覆盖口
    return fallback;
  }) };
  // 中转参数统一从系统设置取（见 resolveSub2ApiProviderConfig 的注释：
  // 读 env 会与运营在管理端改的值不同步，线上因此出过 401）
  const settings = {
    getEffectiveValue: jest.fn(async (key: string) => {
      if (key === 'SUB2API_BASE_URL') return 'https://relay.test/v1';
      if (key === 'SUB2API_API_KEY') return 'test-key';
      if (key === 'SUB2API_DEFAULT_MODEL') return 'gemini-3.5-flash-high';
      return null;
    }),
  };
  // 企业没指定编排模型 → 落到系统设置那一档
  const modelConfig = { getPlannerModel: jest.fn().mockResolvedValue(null) };
  const policy = { version: 7, values: Object.fromEntries(MODEL_RUNTIME_POLICY_FIELDS.map((field) => [field.key, Number(field.defaultValue)])) };
  const runtimePolicies = { getSnapshot: jest.fn().mockResolvedValue(policy) };
  const release = jest.fn().mockResolvedValue(undefined);
  const admission = { acquire: jest.fn().mockResolvedValue({ release }), reserve: jest.fn().mockResolvedValue(undefined) };
  const service = new TaskPlanningService(
    prisma as never,
    subscriptions as never,
    enterpriseContext as never,
    config as never,
    settings as never,
    modelConfig as never,
    runtimePolicies as never,
    admission as never,
    new GatewayModelPolicyService({} as never, {} as never, {} as never),
    { checkBalanceBeforeConversation: jest.fn().mockResolvedValue({ allowed: true }) } as never,
  );

  const validPlan = {
    summary: '先分析数据，再生成管理层报告',
    steps: [
      {
        employeeId: 'employee-1', capabilityId: 'cap-1', title: '分析销售数据',
        description: '识别趋势和异常', rationale: '数据分析师最匹配', dependsOnStepNumbers: [], estimatedSeconds: 7200,
      },
      {
        employeeId: 'employee-2', capabilityId: 'cap-2', title: '生成报告',
        description: '整理分析结果', rationale: '报告撰写员最匹配', dependsOnStepNumbers: [1], estimatedSeconds: 90,
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    runtimePolicies.getSnapshot.mockResolvedValue(policy);
    admission.acquire.mockResolvedValue({ release });
    admission.reserve.mockResolvedValue(undefined);
    subscriptions.findAll.mockResolvedValue([
      { id: 'subscription-1', status: 'ACTIVE', employee: { id: 'employee-1' } },
      { id: 'subscription-2', status: 'ACTIVE', employee: { id: 'employee-2' } },
    ]);
    prisma.employeeGrant.findMany.mockResolvedValue([
      { subscriptionId: 'subscription-1' },
      { subscriptionId: 'subscription-2' },
    ]);
    prisma.digitalEmployee.findMany.mockResolvedValue([
      {
        id: 'employee-1',
        name: '数据分析师',
        description: '分析经营数据',
        position: '数据分析',
        industry: '电商',
        avatar: null,
        bindings: [{ capability: { id: 'cap-1', name: '销售分析', description: '分析销售趋势', type: 'SKILL' } }],
      },
      {
        id: 'employee-2',
        name: '报告撰写员',
        description: '生成管理层报告',
        position: '内容创作',
        industry: '通用',
        avatar: null,
        bindings: [{ capability: { id: 'cap-2', name: '报告生成', description: '生成结构化报告', type: 'SKILL' } }],
      },
    ]);
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validPlan) } }],
    }), { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('企业指定了编排模型就用它，而不是平台默认', async () => {
    modelConfig.getPlannerModel.mockResolvedValueOnce('gemini-3.1-pro-preview');
    const plan = await service.preview('user-1', { objective: '分析销售数据并生成报告' });
    expect(plan.planner.model).toBe('gemini-3.1-pro-preview');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls.at(-1)[1].body);
    expect(body.model).toBe('gemini-3.1-pro-preview');
  });

  it('generates a validated LLM plan without executing any employee', async () => {
    const plan = await service.preview('user-1', { objective: '分析销售数据并生成报告' });

    // 地址与密钥都来自系统设置，不是 env —— 这条断言同时守住「规划器和对话
    // 用同一套中转参数」，线上曾因为规划器读 env 而独自报 401
    expect(global.fetch).toHaveBeenCalledWith(
      'https://relay.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    expect(plan.status).toBe('awaiting_confirmation');
    expect(plan.planner.type).toBe('llm');
    expect(plan.steps.map((step) => step.employee.id)).toEqual(['employee-1', 'employee-2']);
    expect(plan.steps[0].estimatedSeconds).toBe(3600);
    expect(plan.steps[1].dependsOn).toEqual(['step-1']);
  });

  it('only offers enabled bindings with approved capabilities to the planner', async () => {
    await service.preview('user-1', { objective: '分析销售数据' });

    const query = prisma.digitalEmployee.findMany.mock.calls[0][0];
    expect(query.select.bindings.where).toEqual({
      enabled: true,
      capability: { status: 'APPROVED' },
    });
  });

  it('rejects a requested employee outside the active subscription set', async () => {
    await expect(
      service.preview('user-1', { objective: '分析销售数据', employeeIds: ['unknown-employee'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('drops model steps that reference IDs outside the candidate catalog', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: 'invalid selection',
        steps: [{
          employeeId: 'not-allowed', capabilityId: 'not-allowed', title: '越权步骤',
          description: 'should be dropped', rationale: 'invalid', dependsOnStepNumbers: [], estimatedSeconds: 120,
        }],
      }) } }],
    }), { status: 200 }));

    await expect(service.preview('user-1', { objective: '分析销售数据' })).rejects.toThrow('无效的员工或能力选择');
  });

  it('uses one snapshot, shared business admission and reserves the complete planner request', async () => {
    const boundedPolicy = { ...policy, values: { ...policy.values, PLANNER_MAX_OUTPUT_TOKENS: 4000 } };
    runtimePolicies.getSnapshot.mockResolvedValueOnce(boundedPolicy);
    prisma.platformModel.findUnique.mockResolvedValueOnce({ maxOutputTokens: 1000 } as never);
    await service.preview('user-1', { objective: '分析销售数据' });
    expect(runtimePolicies.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledWith({ enterpriseId: 'enterprise-1', memberId: 'member-1' }, boundedPolicy);
    expect(admission.reserve).toHaveBeenCalledWith(expect.anything(), boundedPolicy,
      expect.objectContaining({ max_tokens: 1000, messages: expect.any(Array) }), 1000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('omits the planner output budget with upstream-managed defaults', async () => {
    await service.preview('user-1', { objective: '分析销售数据' });
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent).not.toHaveProperty('max_completion_tokens');
    expect(admission.reserve.mock.calls[0][3]).toBeUndefined();
  });

  it('never calls the upstream after budget refusal and releases its lease', async () => {
    admission.reserve.mockRejectedValueOnce(new HttpException({ code: 'MODEL_BUDGET_EXCEEDED' }, 429));
    await expect(service.preview('user-1', { objective: '分析销售数据' })).rejects.toMatchObject({ status: 429 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([200, 502])('times out a stalled %s response body, not just fetch headers', async (status) => {
    jest.useFakeTimers();
    runtimePolicies.getSnapshot.mockResolvedValueOnce({ ...policy, values: { ...policy.values, PLANNER_REQUEST_TIMEOUT_MS: 1000 } });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: status === 200,
      json: () => new Promise(() => undefined), text: () => new Promise(() => undefined) });
    const pending = service.preview('user-1', { objective: '分析销售数据' });
    const assertion = expect(pending).rejects.toBeInstanceOf(GatewayTimeoutException);
    await jest.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(release).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('propagates client cancellation while reading the response body', async () => {
    const abort = new AbortController();
    (global.fetch as jest.Mock).mockImplementationOnce(async () => {
      queueMicrotask(() => abort.abort());
      return { ok: true, json: () => new Promise(() => undefined) };
    });
    await expect(service.preview('user-1', { objective: '分析销售数据' }, abort.signal)).rejects.toMatchObject({ status: 499 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('correlates safe failure logs without exposing model content or credentials', async () => {
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '{private-upstream-body}' } }],
    }), { status: 200 }));
    await expect(service.preview('user-1', { objective: 'private-prompt' })).rejects.toMatchObject({ status: 502 });
    const start = String(logs.mock.calls[0][0]);
    const requestId = start.match(/requestId=([^ ]+)/)?.[1];
    expect(requestId).toBeDefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`requestId=${requestId} chain=planner policyVersion=7`));
    expect(JSON.stringify([...logs.mock.calls, ...errors.mock.calls])).not.toMatch(/private-upstream-body|private-prompt|test-key/);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
