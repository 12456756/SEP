import { enterpriseConnectionStub } from '../../../test/stubs/enterprise-connection.stub';
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CapabilityInsightService } from './capability-insight.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import {
  MODEL_RUNTIME_POLICY_FIELDS,
  SETTING_KEYS,
  type ModelRuntimePolicySnapshot,
} from 'shared';

describe('CapabilityInsightService SKILL write closure', () => {
  const ctx = {
    enterpriseId: 'enterprise-1',
    memberId: 'admin-member-1',
    role: 'ENTERPRISE_ADMIN',
  };
  const pending = {
    id: 'insight-1',
    enterpriseId: 'enterprise-1',
    capabilityId: 'skill-1',
    status: 'PENDING',
    scope: 'ALL',
    findings: [],
  };
  const prisma = {
    capabilityInsight: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    capability: { findUnique: jest.fn() },
    subscription: { findFirst: jest.fn() },
    toolExecution: { findMany: jest.fn() },
    skillVersion: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    platformModel: { findUnique: jest.fn() },
  };
  const enterpriseContext = {
    resolve: jest.fn(),
    assertEnterpriseAdmin: jest.fn(),
  };
  const skillVersions = {
    createEnterpriseVersionFromContent: jest.fn(),
    resolveEffectiveVersion: jest.fn(),
  };
  const config = { get: jest.fn() };
  const snapshot: ModelRuntimePolicySnapshot = {
    version: 19,
    values: Object.fromEntries(
      MODEL_RUNTIME_POLICY_FIELDS.map((field) => [
        field.key,
        Number(field.defaultValue),
      ]),
    ) as ModelRuntimePolicySnapshot['values'],
  };
  const settings = { getEffectiveValue: jest.fn() };
  const runtimePolicy = { getSnapshot: jest.fn() };
  const release = jest.fn();
  const admission = { acquire: jest.fn(), reserve: jest.fn() };
  const service = new CapabilityInsightService(
    prisma as never,
    enterpriseContext as never,
    skillVersions as never,
    config as never,
    settings as never,
    {} as never,
    runtimePolicy as never,
    admission as never,
    new GatewayModelPolicyService({} as never, {} as never, {} as never),
    enterpriseConnectionStub('https://relay.example/v1', 'settings-key') as never,
    { checkBalanceBeforeConversation: async () => ({ allowed: true }) } as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    enterpriseContext.resolve.mockResolvedValue(ctx);
    prisma.capabilityInsight.findFirst.mockResolvedValue(pending);
    runtimePolicy.getSnapshot.mockResolvedValue({ ...snapshot,
      values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 3000 } });
    release.mockResolvedValue(undefined);
    admission.acquire.mockResolvedValue({ release });
    admission.reserve.mockResolvedValue(undefined);
    prisma.platformModel.findUnique.mockResolvedValue({
      maxOutputTokens: 1400,
    });
    settings.getEffectiveValue.mockImplementation(
      async (key: string) =>
        ({
          [SETTING_KEYS.SUB2API_BASE_URL]: 'https://relay.example/v1',
          [SETTING_KEYS.SUB2API_API_KEY]: 'settings-key',
          [SETTING_KEYS.SUB2API_DEFAULT_MODEL]: 'default-model',
        })[key],
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('rejects edited AI adoption before generating a version or consuming the pending suggestion', async () => {
    await expect(
      service.adopt('admin-1', 'insight-1', {
        content: '# 角色\n管理员修改的正文',
        changeSummary: '采纳 AI 建议',
      }),
    ).rejects.toThrow('AI 建议正文采纳已停用');
    expect(prisma.capabilityInsight.findFirst).toHaveBeenCalledWith({
      where: { id: 'insight-1', enterpriseId: 'enterprise-1' },
    });
    expect(
      skillVersions.createEnterpriseVersionFromContent,
    ).not.toHaveBeenCalled();
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(prisma.skillVersion.update).not.toHaveBeenCalled();
    expect(prisma.capabilityInsight.update).not.toHaveBeenCalled();
  });

  it('does not expose or adopt another enterprise suggestion', async () => {
    prisma.capabilityInsight.findFirst.mockResolvedValue(null);
    await expect(
      service.adopt('admin-1', 'other-insight', { content: '新正文' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.capabilityInsight.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-insight', enterpriseId: ctx.enterpriseId },
    });
    expect(
      skillVersions.createEnterpriseVersionFromContent,
    ).not.toHaveBeenCalled();
  });

  it.each(['ADOPTED', 'DISMISSED'])(
    'keeps historical %s suggestions immutable',
    async (status) => {
      prisma.capabilityInsight.findFirst.mockResolvedValue({
        ...pending,
        status,
      });
      await expect(
        service.adopt('admin-1', 'insight-1', { content: '新正文' }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.dismiss('admin-1', 'insight-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.capabilityInsight.update).not.toHaveBeenCalled();
      expect(
        skillVersions.createEnterpriseVersionFromContent,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(['adopt', 'dismiss', 'list', 'generate'])(
    'keeps enterprise admin authorization for %s',
    async (action) => {
      enterpriseContext.assertEnterpriseAdmin.mockImplementation(() => {
        throw new ForbiddenException('仅企业管理员');
      });
      const request =
        action === 'adopt'
          ? service.adopt('member-1', 'insight-1', { content: '新正文' })
          : action === 'dismiss'
            ? service.dismiss('member-1', 'insight-1')
            : action === 'list'
              ? service.list('member-1', 'skill-1')
              : service.generate('member-1', 'skill-1', { scope: 'ALL' });
      await expect(request).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.capabilityInsight.findFirst).not.toHaveBeenCalled();
      expect(prisma.capabilityInsight.findMany).not.toHaveBeenCalled();
      expect(prisma.capability.findUnique).not.toHaveBeenCalled();
    },
  );

  it('retains pending suggestion rejection without writing skill content', async () => {
    prisma.capabilityInsight.update.mockResolvedValue({
      ...pending,
      status: 'DISMISSED',
    });
    await expect(
      service.dismiss('admin-1', 'insight-1'),
    ).resolves.toMatchObject({ status: 'DISMISSED' });
    expect(prisma.capabilityInsight.update).toHaveBeenCalledWith({
      where: { id: 'insight-1' },
      data: {
        status: 'DISMISSED',
        adoptedById: 'admin-1',
        resolvedAt: expect.any(Date),
      },
    });
    expect(
      skillVersions.createEnterpriseVersionFromContent,
    ).not.toHaveBeenCalled();
  });

  it('keeps historical adopted suggestions and version attribution readable within the enterprise', async () => {
    const history = [
      { ...pending, status: 'ADOPTED', adoptedVersionId: 'enterprise-v1' },
    ];
    prisma.capabilityInsight.findMany.mockResolvedValue(history);
    await expect(service.list('admin-1', 'skill-1')).resolves.toEqual(history);
    expect(prisma.capabilityInsight.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { capabilityId: 'skill-1', enterpriseId: 'enterprise-1' },
        include: {
          createdBy: { select: { id: true, name: true } },
          adoptedBy: { select: { id: true, name: true } },
        },
      }),
    );
  });

  it('still analyzes usage and stores suggestions without creating an enterprise skill version', async () => {
    prisma.capability.findUnique.mockResolvedValue({
      id: 'skill-1',
      name: '分析助手',
      type: 'SKILL',
    });
    prisma.subscription.findFirst.mockResolvedValue({ id: 'subscription-1' });
    skillVersions.resolveEffectiveVersion.mockResolvedValue({
      content: '当前正文',
    });
    prisma.toolExecution.findMany.mockResolvedValue([
      {
        input: { task: '分析' },
        output: { result: '缺少指标' },
        status: 'SUCCESS',
        user: { name: '成员一' },
      },
    ]);
    prisma.skillVersion.findMany.mockResolvedValue([]);
    config.get.mockReturnValue('planner-test');
    const findings = [
      {
        phenomenon: '结果缺少指标',
        suggestion: '添加指标定义',
        confidence: 0.8,
      },
    ];
    const askModel = jest
      .spyOn(service as any, 'askModel')
      .mockResolvedValue({ findings });
    prisma.capabilityInsight.create.mockResolvedValue({ ...pending, findings });

    await expect(
      service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
    ).resolves.toMatchObject({ findings });
    expect(askModel).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineContent: '当前正文',
        modelId: 'planner-test',
      }),
    );
    expect(askModel).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { enterpriseId: ctx.enterpriseId, memberId: ctx.memberId },
      }),
    );
    expect(prisma.capabilityInsight.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        capabilityId: 'skill-1',
        enterpriseId: 'enterprise-1',
        findings,
        scope: 'ALL',
        sampleSize: 1,
        personalCount: 0,
        createdById: 'admin-1',
      }),
    });
    expect(prisma.skillVersion.create).not.toHaveBeenCalled();
    expect(
      skillVersions.createEnterpriseVersionFromContent,
    ).not.toHaveBeenCalled();
  });

  describe('real model entry', () => {
    let upstream: jest.SpyInstance;
    beforeEach(() => {
      prisma.capability.findUnique.mockResolvedValue({
        id: 'skill-1',
        name: 'Analysis',
        type: 'SKILL',
      });
      prisma.subscription.findFirst.mockResolvedValue({ id: 'subscription-1' });
      skillVersions.resolveEffectiveVersion.mockResolvedValue({
        content: 'Baseline',
      });
      prisma.toolExecution.findMany.mockResolvedValue([
        {
          input: 'Input',
          output: 'Output',
          status: 'SUCCESS',
          user: { name: 'Member' },
        },
      ]);
      prisma.skillVersion.findMany.mockResolvedValue([]);
      config.get.mockReturnValue('planner-test');
      prisma.capabilityInsight.create.mockResolvedValue(pending);
      upstream = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"findings":[]}' } }],
          }),
        ),
      );
    });

    it('omits the analysis budget when following upstream', async () => {
      runtimePolicy.getSnapshot.mockResolvedValueOnce(snapshot);
      await service.generate('admin-1', 'skill-1', { scope: 'MEMBER', memberId: 'analyzed-user' });
      expect(JSON.parse(upstream.mock.calls[0][1].body)).not.toHaveProperty('max_tokens');
      expect(admission.reserve.mock.calls[0][3]).toBeUndefined();
    });

    it('uses an explicitly configured analysis budget above the old local 3000 cap', async () => {
      prisma.platformModel.findUnique.mockResolvedValueOnce(null);
      runtimePolicy.getSnapshot.mockResolvedValueOnce({ ...snapshot, values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 12000 } });
      await service.generate('admin-1', 'skill-1', { scope: 'MEMBER', memberId: 'analyzed-user' });
      expect(JSON.parse(upstream.mock.calls[0][1].body).max_tokens).toBe(12000);
    });

    it('uses the requesting admin identity, one snapshot and a normalized request for reservation', async () => {
      const bounded = { ...snapshot, values: { ...snapshot.values, PLANNER_MAX_OUTPUT_TOKENS: 3000 } };
      await service.generate('admin-1', 'skill-1', {
        scope: 'MEMBER',
        memberId: 'analyzed-user',
      });
      const request = JSON.parse(upstream.mock.calls[0][1].body);
      expect(request).toMatchObject({
        model: 'planner-test',
        max_tokens: 3000,
      });
      expect(runtimePolicy.getSnapshot).toHaveBeenCalledTimes(1);
      expect(admission.acquire).toHaveBeenCalledTimes(1);
      expect(admission.acquire).toHaveBeenCalledWith(
        { enterpriseId: ctx.enterpriseId, memberId: ctx.memberId },
        bounded,
      );
      expect(admission.reserve).toHaveBeenCalledWith(
        { enterpriseId: ctx.enterpriseId, memberId: ctx.memberId },
        bounded,
        request,
        3000,
      );
      expect(admission.reserve.mock.invocationCallOrder[0]).toBeLessThan(
        upstream.mock.invocationCallOrder[0],
      );
      expect(release).toHaveBeenCalledTimes(1);
      expect(prisma.platformModel.findUnique).not.toHaveBeenCalled();
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[ModelPolicy\] requestId=[\da-f-]+ chain=capability-insight policyVersion=19$/i,
        ),
      );
    });

    it.each(['network', 'response-json', 'model-json'])(
      'keeps %s response fragments and prompts out of correlated error logs',
      async (stage) => {
        const secret = 'private-insight-response-fragment';
        skillVersions.resolveEffectiveVersion.mockResolvedValueOnce({
          content: secret,
        });
        if (stage === 'network')
          upstream.mockRejectedValueOnce(new Error(secret));
        if (stage === 'response-json')
          upstream.mockResolvedValueOnce(new Response(`{"${secret}":}`));
        if (stage === 'model-json')
          upstream.mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                choices: [{ message: { content: `{"${secret}":}` } }],
              }),
            ),
          );

        await expect(
          service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
        ).rejects.toMatchObject({ status: 502, response: { message: expect.stringContaining(stage === 'network' ? secret : 'JSON') } });

        const log = (Logger.prototype.log as jest.Mock).mock
          .calls[0][0] as string;
        const requestId = log.match(/requestId=([\w-]+)/)?.[1];
        expect(requestId).toBeDefined();
        expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `Model request failed requestId=${requestId} chain=capability-insight policyVersion=19 status=${stage === 'model-json' ? 'internal' : 502}`,
        );
        expect(
          JSON.stringify((Logger.prototype.log as jest.Mock).mock.calls),
        ).not.toContain(secret);
        expect(
          JSON.stringify((Logger.prototype.error as jest.Mock).mock.calls),
        ).not.toContain(secret);
        expect(release).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['admission', 'reserve'])(
      'preserves platform rejection on %s without writing suggestions or calling upstream',
      async (stage) => {
        const error = new HttpException(
          {
            code: 'PLATFORM_ADMISSION_REJECTED',
            policyVersion: snapshot.version,
          },
          429,
        );
        if (stage === 'admission')
          admission.acquire.mockRejectedValueOnce(error);
        else admission.reserve.mockRejectedValueOnce(error);
        await expect(
          service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
        ).rejects.toBe(error);
        expect(upstream).not.toHaveBeenCalled();
        expect(prisma.capabilityInsight.create).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(stage === 'admission' ? 0 : 1);
      },
    );

    it('preserves Redis unavailable 503 rather than labeling it upstream 502', async () => {
      const error = new ServiceUnavailableException({
        code: 'PLATFORM_ADMISSION_UNAVAILABLE',
      });
      admission.reserve.mockRejectedValueOnce(error);
      await expect(
        service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
      ).rejects.toBe(error);
      expect(upstream).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it.each(['network', 'invalid-json', 'invalid-schema', 'upstream-status'])(
      'releases admission on %s failure',
      async (kind) => {
        if (kind === 'network')
          upstream.mockRejectedValueOnce(new Error('network unavailable'));
        else
          upstream.mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content:
                        kind === 'invalid-schema'
                          ? '{"findings":[{}]}'
                          : 'bad output',
                    },
                  },
                ],
              }),
              { status: kind === 'upstream-status' ? 429 : 200 },
            ),
          );
        await expect(
          service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
        ).rejects.toMatchObject({ status: kind === 'upstream-status' ? 429 : 502 });
        expect(release).toHaveBeenCalledTimes(1);
        expect(prisma.capabilityInsight.create).not.toHaveBeenCalled();
      },
    );

    it('does not charge requests without samples', async () => {
      prisma.toolExecution.findMany.mockResolvedValue([]);
      await expect(
        service.generate('admin-1', 'skill-1', { scope: 'ALL' }),
      ).rejects.toThrow('无从分析');
      expect(runtimePolicy.getSnapshot).not.toHaveBeenCalled();
      expect(admission.acquire).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    });

    it('times out body reading under the shared deadline and preserves timeout 504', async () => {
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
      const result = service.generate('admin-1', 'skill-1', { scope: 'ALL' });
      const rejected = expect(result).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'MODEL_REQUEST_TIMEOUT',
          phase: 'planner',
        }),
        status: 504,
      });
      await started;
      expect(release).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(prisma.capabilityInsight.create).not.toHaveBeenCalled();
    });
  });
});
