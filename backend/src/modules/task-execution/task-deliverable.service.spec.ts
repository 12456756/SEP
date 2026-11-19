import {
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TaskRun, TaskRunStep } from '@prisma/client';
import {
  MODEL_RUNTIME_POLICY_FIELDS,
  SETTING_KEYS,
  type ModelRuntimePolicySnapshot,
} from 'shared';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import { TaskDeliverableService } from './task-deliverable.service';

describe('TaskDeliverableService model admission', () => {
  const snapshot: ModelRuntimePolicySnapshot = {
    version: 23,
    values: Object.fromEntries(
      MODEL_RUNTIME_POLICY_FIELDS.map((field) => [
        field.key,
        Number(field.defaultValue),
      ]),
    ) as ModelRuntimePolicySnapshot['values'],
  };
  const run = {
    id: 'run-1',
    userId: 'user-1',
    enterpriseId: 'enterprise-1',
    objective: 'Task objective',
    summary: '',
  } as TaskRun;
  const steps = [
    {
      id: 'step-1',
      order: 1,
      status: 'COMPLETED',
      output: 'Step output',
      title: 'Analysis',
      employeeName: 'Analyst',
    },
  ] as TaskRunStep[];
  let prisma: any;
  let runtimePolicy: any;
  let admission: any;
  let release: jest.Mock;
  let upstream: jest.SpyInstance;
  let service: TaskDeliverableService;
  let publish: jest.Mock;
  let record: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = {
      enterpriseMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
      platformModel: {
        findUnique: jest.fn().mockResolvedValue({ maxOutputTokens: 1500 }),
      },
      taskRun: { update: jest.fn().mockResolvedValue({}) },
    };
    runtimePolicy = { getSnapshot: jest.fn().mockResolvedValue({ ...snapshot,
      values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 4000 } }) };
    release = jest.fn().mockResolvedValue(undefined);
    admission = {
      acquire: jest.fn().mockResolvedValue({ release }),
      reserve: jest.fn().mockResolvedValue(undefined),
    };
    upstream = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '# Deliverable' } }],
        }),
      ),
    );
    const settings = {
      getEffectiveValue: jest.fn(
        async (key: string) =>
          ({
            [SETTING_KEYS.SUB2API_BASE_URL]: 'https://relay.example/v1',
            [SETTING_KEYS.SUB2API_API_KEY]: 'settings-key',
            [SETTING_KEYS.SUB2API_DEFAULT_MODEL]: 'default-model',
          })[key],
      ),
    };
    publish = jest.fn();
    record = jest.fn().mockResolvedValue(undefined);
    service = new TaskDeliverableService(
      prisma,
      { get: jest.fn() } as never,
      settings as never,
      {
        getPlannerModel: jest.fn().mockResolvedValue('planner-model'),
      } as never,
      { publish } as never,
      { record } as never,
      runtimePolicy,
      admission,
      new GatewayModelPolicyService({} as never, {} as never, {} as never),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('counts the standalone summary once using the persisted task tenant and member', async () => {
    const bounded = { ...snapshot, values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 4000 } };
    await service.generate(run, steps);
    expect(prisma.enterpriseMember.findFirst).toHaveBeenCalledWith({
      where: { userId: run.userId, enterpriseId: run.enterpriseId },
      select: { id: true },
    });
    expect(runtimePolicy.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledWith(
      { enterpriseId: 'enterprise-1', memberId: 'member-1' },
      bounded,
    );
    const request = JSON.parse(upstream.mock.calls[0][1].body);
    expect(request).toMatchObject({ model: 'planner-model', max_tokens: 1500 });
    expect(request.messages[1].content).toContain('Step output');
    expect(admission.reserve).toHaveBeenCalledWith(
      { enterpriseId: 'enterprise-1', memberId: 'member-1' },
      bounded,
      request,
      1500,
    );
    expect(admission.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      upstream.mock.invocationCallOrder[0],
    );
    expect(prisma.taskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliverable: '# Deliverable',
          deliverableDegraded: false,
        }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      '[ModelPolicy] runId=run-1 chain=task-deliverable policyVersion=23',
    );
  });

  it.each(['network', 'response-json', 'upstream-status'])(
    'does not leak %s details or task content in correlation and fallback logs',
    async (stage) => {
      const secret = 'private-deliverable-response-fragment';
      if (stage === 'network')
        upstream.mockRejectedValueOnce(new Error(secret));
      if (stage === 'response-json')
        upstream.mockResolvedValueOnce(new Response(`{"${secret}":}`));
      if (stage === 'upstream-status')
        upstream.mockResolvedValueOnce(new Response(secret, { status: 503 }));

      await service.generate({ ...run, objective: secret }, [
        { ...steps[0], output: secret },
      ]);

      expect(Logger.prototype.log).toHaveBeenCalledWith(
        '[ModelPolicy] runId=run-1 chain=task-deliverable policyVersion=23',
      );
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        `Deliverable summarization failed runId=run-1 chain=task-deliverable status=${stage === 'upstream-status' ? 503 : 502}; falling back to concatenation`,
      );
      expect(
        JSON.stringify((Logger.prototype.log as jest.Mock).mock.calls),
      ).not.toContain(secret);
      expect(
        JSON.stringify((Logger.prototype.warn as jest.Mock).mock.calls),
      ).not.toContain(secret);
      expect(prisma.taskRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliverableDegraded: true,
            deliverable: expect.stringContaining(secret),
          }),
        }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('does not consume RPM or request policy for tasks without produced steps', async () => {
    await service.generate(run, []);
    expect(runtimePolicy.getSnapshot).not.toHaveBeenCalled();
    expect(admission.acquire).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(prisma.taskRun.update).not.toHaveBeenCalled();
  });

  it('sends and persists the original sanitized summary failure when falling back', async () => {
    const diagnostic = { error: { code: 'MODEL_UNAVAILABLE', message: 'No model capacity Bearer [REDACTED]',
      attempts: [{ upstream_status: 429, detail: 'Quota exhausted' }] } };
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ error: { ...diagnostic.error,
      message: 'No model capacity Bearer settings-key' } }), { status: 503 }));
    await service.generate(run, steps);
    expect(publish).toHaveBeenCalledWith(run.id, expect.objectContaining({ type: 'deliverable', degraded: true, diagnostic }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ degraded: true, diagnostic }) }));
    expect(JSON.stringify(publish.mock.calls) + JSON.stringify(record.mock.calls)).not.toContain('settings-key');
  });

  it.each(['no-enterprise', 'removed-member'])(
    'degrades %s tasks without inventing an admission identity',
    async (kind) => {
      if (kind === 'removed-member')
        prisma.enterpriseMember.findFirst.mockResolvedValue(null);
      await service.generate(
        kind === 'no-enterprise' ? { ...run, enterpriseId: null } : run,
        steps,
      );
      expect(admission.acquire).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
      expect(prisma.taskRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliverable: expect.stringContaining('Step output'),
            deliverableDegraded: true,
          }),
        }),
      );
    },
  );

  it('keeps the existing honest concatenation fallback on admission rejection', async () => {
    admission.acquire.mockRejectedValueOnce(
      new HttpException({ code: 'PLATFORM_ADMISSION_REJECTED' }, 429),
    );
    await service.generate(run, steps);
    expect(admission.reserve).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(prisma.taskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliverableDegraded: true }),
      }),
    );
  });

  it.each(['reserve', 'upstream', 'body'])(
    'releases admission and degrades on %s failure',
    async (stage) => {
      if (stage === 'reserve')
        admission.reserve.mockRejectedValueOnce(
          new ServiceUnavailableException(),
        );
      if (stage === 'upstream')
        upstream.mockRejectedValueOnce(new Error('network unavailable'));
      if (stage === 'body')
        upstream.mockResolvedValueOnce(new Response('not JSON'));
      await service.generate(run, steps);
      if (stage === 'reserve') expect(upstream).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(prisma.taskRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deliverableDegraded: true }),
        }),
      );
    },
  );

  it('holds admission until response body is read', async () => {
    let finish!: (value: unknown) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    upstream.mockResolvedValueOnce({
      ok: true,
      json: () => {
        reading();
        return body;
      },
    });
    const result = service.generate(run, steps);
    await started;
    expect(release).not.toHaveBeenCalled();
    finish({ choices: [{ message: { content: '# Result' } }] });
    await result;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('bounds body reading with the same deadline as fetch and degrades on timeout', async () => {
    jest.useFakeTimers();
    runtimePolicy.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      values: { ...snapshot.values, PLANNER_REQUEST_TIMEOUT_MS: 1000 },
    });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    upstream.mockResolvedValueOnce({
      ok: true,
      json: () => {
        reading();
        return new Promise(() => undefined);
      },
    });
    const result = service.generate(run, steps);
    await started;
    await jest.advanceTimersByTimeAsync(1000);
    await result;
    expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(prisma.taskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deliverableDegraded: true }),
      }),
    );
  });

  it('omits the output budget when following upstream despite known model metadata', async () => {
    runtimePolicy.getSnapshot.mockResolvedValueOnce(snapshot);
    await service.generate(run, steps);
    expect(JSON.parse(upstream.mock.calls[0][1].body)).not.toHaveProperty('max_tokens');
    expect(admission.reserve.mock.calls[0][3]).toBeUndefined();
  });

  it('uses the configured planner budget without an extra local 4000 cap', async () => {
    prisma.platformModel.findUnique.mockResolvedValue(null);
    runtimePolicy.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 12000 },
    });
    await service.generate(run, steps);
    expect(JSON.parse(upstream.mock.calls[0][1].body).max_tokens).toBe(12000);
    runtimePolicy.getSnapshot.mockResolvedValueOnce({
      ...snapshot,
      values: {
        ...snapshot.values,
        PLANNER_MAX_OUTPUT_TOKENS: 2000,
        MODEL_MAX_OUTPUT_TOKENS: 900,
      },
    });
    upstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '# Again' } }] }),
      ),
    );
    await service.generate(run, steps);
    expect(JSON.parse(upstream.mock.calls[1][1].body).max_tokens).toBe(900);
  });
});
