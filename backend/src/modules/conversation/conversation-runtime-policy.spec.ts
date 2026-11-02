import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { streamText } from 'ai';
import { MODEL_RUNTIME_POLICY_FIELDS, type ModelRuntimePolicySnapshot } from 'shared';
import { ConversationStreamService } from './conversation-stream.service';
import { GatewayModelPolicyService } from '../gateway/gateway-model-policy.service';
import type { SseEvent } from './conversation.types';

// Both SDK imports resolve to the same CJS stub in this repository's Jest config.
jest.mock('ai', () => ({
  streamText: jest.fn(),
  createOpenAICompatible: jest.fn((options) => (id: string) => ({ id, fetch: options.fetch })),
}));

describe('Web model runtime policy lifecycle', () => {
  let prisma: any;
  let service: ConversationStreamService;
  let sessionLock: any;
  let admission: any;
  let policies: any;
  let capabilities: any;
  let knowledge: any;
  let lostLock: (error: unknown) => void;
  let policy: ModelRuntimePolicySnapshot;
  const release = jest.fn();
  const stopRenewal = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (streamText as jest.Mock).mockReset();
    policy = { version: 5, values: Object.fromEntries(MODEL_RUNTIME_POLICY_FIELDS.map((field) => [field.key, Number(field.defaultValue)])) as ModelRuntimePolicySnapshot['values'] };
    prisma = {
      conversationSession: { findUnique: jest.fn().mockResolvedValue({ id: 'session', userId: 'user', employeeId: 'employee',
        employee: { id: 'employee', name: 'assistant', systemPrompt: 'system instructions', maxSteps: 3, bindings: [
          { capability: { id: 'search', name: 'search', description: 'search tool', inputSchema: { properties: { query: { type: 'string' } } } } },
        ] } }), update: jest.fn() },
      subscription: { findUnique: jest.fn().mockResolvedValue({ id: 'subscription' }) },
      platformModel: { findUnique: jest.fn().mockResolvedValue({ maxOutputTokens: 2000 }) },
      message: { create: jest.fn().mockResolvedValue({ id: 'message' }), findMany: jest.fn().mockResolvedValue([{ role: 'USER', content: 'question' }]) },
      toolExecution: { create: jest.fn() },
    };
    release.mockResolvedValue(undefined);
    stopRenewal.mockResolvedValue(undefined);
    sessionLock = { acquireLock: jest.fn().mockResolvedValue('owner'), releaseLock: jest.fn(),
      startRenewal: jest.fn((_id, _owner, callback) => { lostLock = callback; return stopRenewal; }) };
    admission = { acquire: jest.fn().mockResolvedValue({ release }), reserve: jest.fn().mockResolvedValue(undefined) };
    policies = { getSnapshot: jest.fn().mockImplementation(async () => policy) };
    capabilities = { execute: jest.fn().mockResolvedValue({ success: true, output: 'real result' }) };
    knowledge = { search: jest.fn().mockResolvedValue({ count: 0, results: [] }) };
    service = new ConversationStreamService(prisma, capabilities, sessionLock,
      { autoGenerateTitle: jest.fn() } as never, {} as never,
      { getEffectiveValue: jest.fn(async (key) => key === 'SUB2API_BASE_URL' ? 'https://relay.test/v1' : key === 'SUB2API_API_KEY' ? 'test-key' : null) } as never,
      { resolve: jest.fn().mockResolvedValue({ enterpriseId: 'enterprise', memberId: 'member' }) } as never,
      knowledge, { resolveEffectiveModel: jest.fn().mockResolvedValue({ chatModel: 'model' }) } as never,
      {} as never, {} as never,
      {
        getBillingSnapshot: jest.fn().mockResolvedValue({
          modelId: 'model', isFree: false, billingMultiplier: 1, rate: 7,
          inputPriceUsdPerMillion: 0.15, outputPriceUsdPerMillion: 0.6, isFallback: false,
        }),
        checkBalanceBeforeConversation: jest.fn().mockResolvedValue({ allowed: true, enterpriseFundsAllowed: true }),
        chargeUsage: jest.fn().mockResolvedValue({ alreadyCharged: true }),
      } as never,
      policies, admission, new GatewayModelPolicyService({} as never, {} as never, {} as never));
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    mockStep('stop', [{ type: 'text-delta', text: 'reply' }]);
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  function mockStep(finishReason: string, chunks: unknown[]) {
    (streamText as jest.Mock).mockImplementationOnce((options) => ({
      fullStream: (async function* () {
        await options.model.fetch('https://relay.test/v1/chat/completions', { body: JSON.stringify({
          model: 'model', messages: [{ role: 'system', content: options.instructions }, ...options.messages],
          tools: options.tools ? [{ name: 'search', parameters: { query: { type: 'string' } } }] : [], max_tokens: options.maxOutputTokens,
        }) });
        yield* chunks;
      })(), finishReason: Promise.resolve(finishReason), usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }));
  }
  async function collect() {
    const events: SseEvent[] = [];
    for await (const event of service.streamConversation('session', 'question', 'user')) events.push(event);
    return events;
  }

  it('holds one business lease and uses the snapshot throughout model and tool steps', async () => {
    policy = { ...policy, values: { ...policy.values, WEB_DEFAULT_MAX_OUTPUT_TOKENS: 4096 } };
    (streamText as jest.Mock).mockReset();
    mockStep('tool-calls', [{ type: 'tool-call', toolCallId: 'tc', toolName: 'search', input: { query: 'query' } }]);
    mockStep('stop', [{ type: 'text-delta', text: 'final reply' }]);
    capabilities.execute.mockImplementationOnce(async () => {
      policy = { ...policy, version: 6, values: { ...policy.values, WEB_DEFAULT_MAX_OUTPUT_TOKENS: 10 } };
      return { success: true, output: 'real result' };
    });
    const events = await collect();
    expect(events.at(-1)?.event).toBe('done');
    expect(policies.getSnapshot).toHaveBeenCalledTimes(1);
    expect(admission.acquire).toHaveBeenCalledTimes(1);
    expect(admission.reserve).toHaveBeenCalledTimes(2);
    for (const call of admission.reserve.mock.calls) {
      expect(call[1].version).toBe(5);
      expect(call[2].messages[0]).toEqual({ role: 'system', content: 'system instructions' });
      expect(call[2].tools.length).toBe(1);
      expect(call[3]).toBe(2000);
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopRenewal).toHaveBeenCalledTimes(1);
    expect(sessionLock.releaseLock).toHaveBeenCalledWith('session', 'owner');
  });

  it('omits SDK and wire output budgets when following upstream despite known model metadata', async () => {
    const events = await collect();
    expect(events.at(-1)?.event).toBe('done');
    expect((streamText as jest.Mock).mock.calls[0][0]).not.toHaveProperty('maxOutputTokens');
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent).not.toHaveProperty('max_completion_tokens');
    expect(admission.reserve.mock.calls[0][3]).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not persist a user message if business admission rejects', async () => {
    admission.acquire.mockRejectedValueOnce(new HttpException({ code: 'PLATFORM_ADMISSION_REJECTED' }, 429));
    await expect(collect()).rejects.toMatchObject({ status: 429 });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sessionLock.releaseLock).toHaveBeenCalled();
    expect(stopRenewal).toHaveBeenCalled();
  });

  it('preserves completed tool results when the next model reservation is refused', async () => {
    (streamText as jest.Mock).mockReset();
    mockStep('tool-calls', [{ type: 'tool-call', toolCallId: 'tc', toolName: 'search', input: {} }]);
    mockStep('stop', []);
    admission.reserve.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpException({ error: { source: 'platform', code: 'PLATFORM_ADMISSION_REJECTED', rule: 'enterprise-resource-budget', policyVersion: 5 } }, 429));
    const events = await collect();
    expect(prisma.toolExecution.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS', output: { text: 'real result' } }) }));
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.find((event) => event.event === 'error')?.data).toMatchObject({ code: 'PLATFORM_ADMISSION_REJECTED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('counts RAG preparation against the total budget', async () => {
    jest.useFakeTimers();
    policy = { ...policy, values: { ...policy.values, WEB_MODEL_TOTAL_TIMEOUT_MS: 1000 } };
    knowledge.search.mockImplementation(() => new Promise(() => undefined));
    const pending = collect();
    await jest.advanceTimersByTimeAsync(1001);
    const events = await pending;
    expect(events.at(-1)?.data).toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT', phase: 'total', policyVersion: 5 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops immediately on lock loss without writing a success message', async () => {
    (streamText as jest.Mock).mockReset();
    (streamText as jest.Mock).mockImplementationOnce(() => ({ fullStream: (async function* () {
      lostLock(new ServiceUnavailableException({ code: 'SESSION_LOCK_LOST', message: 'lost owner' }));
      yield { type: 'text-delta', text: 'must not be saved' };
    })(), finishReason: Promise.resolve('stop'), usage: Promise.resolve({}) }));
    const events = await collect();
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.at(-1)?.data).toMatchObject({ code: 'SESSION_LOCK_LOST' });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(capabilities.execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains a non-cancellable tool execution after timeout but dispatches no next model', async () => {
    jest.useFakeTimers();
    policy = { ...policy, values: { ...policy.values, WEB_MODEL_TOTAL_TIMEOUT_MS: 1000 } };
    (streamText as jest.Mock).mockReset();
    mockStep('tool-calls', [{ type: 'tool-call', toolCallId: 'tc', toolName: 'search', input: {} }]);
    capabilities.execute.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ success: true, output: 'completed after timeout' }), 1200)));
    const pending = collect();
    await jest.advanceTimersByTimeAsync(1201);
    const events = await pending;
    expect(prisma.toolExecution.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS', output: { text: 'completed after timeout' } }) }));
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.at(-1)?.data).toMatchObject({ code: 'MODEL_REQUEST_TIMEOUT' });
  });

  it('does not count downstream backpressure as upstream idle time', async () => {
    jest.useFakeTimers();
    policy = { ...policy, values: { ...policy.values, SUB2API_STREAM_IDLE_TIMEOUT_MS: 1000 } };
    (streamText as jest.Mock).mockReset();
    mockStep('stop', [{ type: 'text-delta', text: 'first' }, { type: 'text-delta', text: 'second' }]);
    const generator = service.streamConversation('session', 'question', 'user');
    expect((await generator.next()).value).toMatchObject({ event: 'text_delta', data: 'first' });
    await jest.advanceTimersByTimeAsync(1500);
    expect((await generator.next()).value).toMatchObject({ event: 'text_delta', data: 'second' });
    await generator.return(undefined);
    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts the active upstream step when the consumer ends early', async () => {
    const optionsSeen: any[] = [];
    (streamText as jest.Mock).mockReset().mockImplementation((options) => {
      optionsSeen.push(options);
      return { fullStream: (async function* () { yield { type: 'text-delta', text: 'partial' }; })(),
        finishReason: Promise.resolve('stop'), usage: Promise.resolve({}) };
    });
    const generator = service.streamConversation('session', 'question', 'user');
    await generator.next();
    await generator.return(undefined);
    expect(optionsSeen[0].abortSignal.aborted).toBe(true);
    expect(optionsSeen[0].maxRetries).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
  });

  it('cleans up a synchronously failing SDK without exposing request data', async () => {
    (streamText as jest.Mock).mockReset().mockImplementation(() => { throw new Error('secret request body'); });
    const events = await collect();
    expect(events.at(-1)?.data).toMatchObject({ code: 'STREAM_CONSUMPTION_ERROR' });
    expect(JSON.stringify(events)).not.toContain('secret request body');
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopRenewal).toHaveBeenCalledTimes(1);
  });
});
