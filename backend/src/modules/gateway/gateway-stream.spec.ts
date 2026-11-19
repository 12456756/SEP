import { ConfigService } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { createGatewayStreamLifecycle, createChatCompletionStreamObserver, timeoutValue } from './gateway-stream';
import { policySnapshot } from './gateway-policy.test-fixtures';

describe('Gateway streaming time budgets', () => {
  let service: GatewayService;
  let fetchMock: jest.SpyInstance;
  let upstream: ReadableStreamDefaultController<Uint8Array>;
  let requestSignal: AbortSignal;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new GatewayService(
      {} as never,
      new ConfigService(),
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'getSub2ApiConfig').mockResolvedValue({
      baseUrl: 'https://relay.test/v1',
      apiKey: 'synthetic',
      defaultModel: 'test-model',
    });
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (_url, init) => {
        requestSignal = init!.signal as AbortSignal;
        return new Response(
          new ReadableStream({
            start(controller) {
              upstream = controller;
            },
          }),
        );
      });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  const dto = {
    model: 'test-model',
    messages: [{ role: 'user' as const, content: 'synthetic' }],
    stream: true,
  };

  it('keeps a 75 second stream alive and preserves its actual finish and DONE', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot(), 'long-stream');
    const body = response.text();
    upstream.enqueue(
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}\n\n',
      ),
    );
    await jest.advanceTimersByTimeAsync(75_000);
    expect(requestSignal.aborted).toBe(false);
    upstream.enqueue(
      new TextEncoder().encode(
        'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    upstream.close();
    expect(await body).toContain('"finish_reason":"stop"');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resets the idle budget on received bytes, not on total stream age', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    const body = response.text();
    for (let i = 0; i < 4; i++) {
      upstream.enqueue(new TextEncoder().encode(': keepalive\n\n'));
      await jest.advanceTimersByTimeAsync(90_000);
      expect(requestSignal.aborted).toBe(false);
    }
    upstream.close();
    await body;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts and errors a body that remains idle for 120 seconds', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    const failure = response.text().catch((error) => error);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(requestSignal.aborted).toBe(true);
    expect(await failure).toMatchObject({
      response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' } },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('enforces the ten minute total budget even if bytes keep arriving', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    const failure = response.text().catch((error) => error);
    for (let i = 0; i < 10; i++) {
      upstream.enqueue(new TextEncoder().encode(': keepalive\n\n'));
      await jest.advanceTimersByTimeAsync(60_000);
    }
    expect(await failure).toMatchObject({
      response: { error: { code: 'UPSTREAM_STREAM_TOTAL_TIMEOUT' } },
    });
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels upstream work and clears all timers on client abort', async () => {
    const client = new AbortController();
    const response = await service.forwardChatCompletion(
      dto,
      policySnapshot(),
      'cancel-stream',
      client.signal,
    );
    const failure = response.text().catch((error) => error);
    client.abort();
    expect(await failure).toBeDefined();
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds the wait for upstream headers separately', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    );
    const failure = service.forwardChatCompletion(dto, policySnapshot()).catch((error) => error);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(await failure).toMatchObject({
      status: 502,
      response: { error: { code: 'UPSTREAM_STREAM_HEADER_TIMEOUT' } },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up after upstream body failures', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    const failure = response.text().catch(error => error);
    upstream.error(new Error('synthetic failure'));
    expect(await failure).toMatchObject({ message: 'synthetic failure' });
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels the fetch when the downstream reader cancels', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    await response.body!.cancel();
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never starts fetch for an already cancelled client', async () => {
    const client = new AbortController();
    client.abort();
    await expect(service.forwardChatCompletion(dto, policySnapshot(), 'cancelled', client.signal)).rejects.toMatchObject({
      response: { error: { code: 'CLIENT_DISCONNECTED' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses configured time budgets', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot({
      GATEWAY_STREAM_HEADER_TIMEOUT_MS: 40, GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50, GATEWAY_STREAM_TOTAL_TIMEOUT_MS: 100,
    }));
    const failure = response.text().catch(error => error);
    await jest.advanceTimersByTimeAsync(50);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' } } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, 2147483648])('rejects invalid stream timeout %s without fetching', async value => {
    await expect(service.forwardChatCompletion(dto, policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: value }))).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not mistake slow downstream consumption for upstream silence', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot());
    const reader = response.body!.getReader();
    upstream.enqueue(new TextEncoder().encode('first'));
    expect((await reader.read()).done).toBe(false);
    upstream.enqueue(new TextEncoder().encode('buffered'));
    await jest.advanceTimersByTimeAsync(180_000);
    expect(requestSignal.aborted).toBe(false);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('buffered');
    upstream.close();
    expect((await reader.read()).done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps non-streaming work alive past 30 seconds and reads the full body', async () => {
    const response = await service.forwardChatCompletion({ ...dto, stream: false }, policySnapshot());
    const result = response.json();
    upstream.enqueue(new TextEncoder().encode('{"choices":'));
    await jest.advanceTimersByTimeAsync(75_000);
    expect(requestSignal.aborted).toBe(false);
    upstream.enqueue(new TextEncoder().encode('[{"message":{"content":"ok"}}]}'));
    upstream.close();
    expect(await result).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts header and body waiting toward one non-streaming total budget', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      requestSignal = init!.signal as AbortSignal;
      await new Promise(resolve => setTimeout(resolve, 75_000));
      return new Response(new ReadableStream({ start(controller) { upstream = controller; } }));
    });
    const waiting = service.forwardChatCompletion({ ...dto, stream: false }, policySnapshot());
    await jest.advanceTimersByTimeAsync(75_000);
    const response = await waiting;
    const failure = response.text().catch(error => error);
    await jest.advanceTimersByTimeAsync(45_000);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_NON_STREAM_TIMEOUT' } } });
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('pauses idle while downstream backpressure stops reads, but not total time', async () => {
    const snapshot = policySnapshot({ GATEWAY_STREAM_HEADER_TIMEOUT_MS: 40, GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50,
      GATEWAY_STREAM_TOTAL_TIMEOUT_MS: 200 });
    const response = await service.forwardChatCompletion(dto, snapshot);
    const reader = response.body!.getReader();
    upstream.enqueue(new TextEncoder().encode('first'));
    expect((await reader.read()).done).toBe(false);
    await jest.advanceTimersByTimeAsync(100);
    expect(requestSignal.aborted).toBe(false);
    const next = reader.read().catch(error => error);
    await jest.advanceTimersByTimeAsync(50);
    expect(await next).toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' } } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not let empty upstream chunks reset idle', async () => {
    const response = await service.forwardChatCompletion(dto, policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50 }));
    const failure = response.text().catch(error => error);
    for (let i = 0; i < 4; i++) {
      upstream.enqueue(new Uint8Array());
      await jest.advanceTimersByTimeAsync(10);
    }
    await jest.advanceTimersByTimeAsync(10);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' } } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([200, 503])('bounds the complete non-stream body even after HTTP %i headers', async status => {
    fetchMock.mockImplementation(async (_url, init) => {
      requestSignal = init!.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { status });
    });
    const operation = service.forwardChatCompletion({ ...dto, stream: false },
      policySnapshot({ GATEWAY_NON_STREAM_TIMEOUT_MS: 50 }));
    const failure = status === 200
      ? operation.then(response => response.json()).catch(error => error)
      : operation.catch(error => error);
    await jest.advanceTimersByTimeAsync(50);
    if (status === 200) {
      expect(await failure).toMatchObject({ status: 502, response: { error: {
        code: 'UPSTREAM_NON_STREAM_TIMEOUT', policyVersion: 7,
      } } });
    } else {
      expect(await failure).toMatchObject({ status: 503, upstreamError: { status: 503, body: '' },
        readDiagnostics: { readError: { response: { error: { code: 'UPSTREAM_NON_STREAM_TIMEOUT', policyVersion: 7 } } } } });
    }
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses one non-stream total deadline for fetch and body without resetting at headers', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise(resolve => {
      requestSignal = init!.signal as AbortSignal;
      setTimeout(() => resolve(new Response(new ReadableStream({ start(controller) { upstream = controller; } }))), 40);
    }));
    const operation = service.forwardChatCompletion({ ...dto, stream: false }, policySnapshot({ GATEWAY_NON_STREAM_TIMEOUT_MS: 50 }));
    await jest.advanceTimersByTimeAsync(40);
    const response = await operation;
    const failure = response.text().catch(error => error);
    await jest.advanceTimersByTimeAsync(10);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_NON_STREAM_TIMEOUT' } } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels non-stream bodies on disconnect and clears every timer', async () => {
    const client = new AbortController();
    const response = await service.forwardChatCompletion({ ...dto, stream: false }, policySnapshot(), 'cancel-json', client.signal);
    const failure = response.json().catch(error => error);
    client.abort();
    expect(await failure).toMatchObject({ response: { error: { code: 'CLIENT_DISCONNECTED' } } });
    expect(requestSignal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Gateway static response limit validation', () => {
  it('preserves defaults and configured numeric byte limits', () => {
    expect(timeoutValue(new ConfigService(), 'GATEWAY_JSON_MAX_BYTES', 8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
    expect(timeoutValue(new ConfigService({ GATEWAY_ERROR_MAX_BYTES: '65536' }), 'GATEWAY_ERROR_MAX_BYTES', 1)).toBe(65536);
    expect(timeoutValue(new ConfigService({ GATEWAY_JSON_MAX_BYTES: 2147483647 }), 'GATEWAY_JSON_MAX_BYTES', 1)).toBe(2147483647);
  });

  it.each(['0', '-1', '1.5', 'NaN', '2147483648'])('rejects invalid static limits %s', value => {
    expect(() => timeoutValue(new ConfigService({ GATEWAY_JSON_MAX_BYTES: value }), 'GATEWAY_JSON_MAX_BYTES', 1)).toThrow(
      'GATEWAY_JSON_MAX_BYTES must be an integer between 1 and 2147483647',
    );
  });
});

describe('Gateway snapshot lifecycle and reader cleanup', () => {
  let source: ReadableStream<Uint8Array>;
  let upstream: ReadableStreamDefaultController<Uint8Array>;
  let cancel: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    cancel = jest.fn();
    source = new ReadableStream({
      start(controller) { upstream = controller; },
      cancel,
    });
  });
  afterEach(() => jest.useRealTimers());

  it.each([0, -1, 1.5, NaN, 720001, 2147483648])('rejects invalid snapshot budgets %s before starting timers', value => {
    expect(() => createGatewayStreamLifecycle(policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: value }))).toThrow(
      expect.objectContaining({ status: 503, response: { error: {
        message: '模型超时策略无效', type: 'server_error', source: 'platform',
        code: 'MODEL_TIMEOUT_POLICY_INVALID', policyVersion: 7,
      } } }),
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears timers and releases the upstream lock on EOF', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot());
    const response = lifecycle.wrap(new Response(source));
    const text = response.text();
    upstream.enqueue(Buffer.from('complete body'));
    upstream.close();
    expect(await text).toBe('complete body');
    expect(source.locked).toBe(false);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the upstream lock when a pending downstream read is cancelled', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot());
    const reader = lifecycle.wrap(new Response(source)).body!.getReader();
    const pending = reader.read();
    await reader.cancel('downstream cancelled');
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledWith('downstream cancelled');
    expect(source.locked).toBe(false);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels and releases the upstream reader on client disconnect', async () => {
    const client = new AbortController();
    const lifecycle = createGatewayStreamLifecycle(policySnapshot(), client.signal);
    const failure = lifecycle.wrap(new Response(source)).text().catch(error => error);
    client.abort();
    expect(await failure).toMatchObject({ response: { error: { code: 'CLIENT_DISCONNECTED' } } });
    await jest.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledWith(lifecycle.signal.reason);
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('releases the upstream reader after a read failure', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot());
    const failure = lifecycle.wrap(new Response(source)).text().catch(error => error);
    const error = new Error('upstream read failed');
    upstream.error(error);
    expect(await failure).toBe(error);
    await jest.advanceTimersByTimeAsync(0);
    expect(source.locked).toBe(false);
    expect(lifecycle.signal.reason).toBe(error);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps a pending read idle across empty chunks without exposing them downstream', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50 }));
    const reader = lifecycle.wrap(new Response(source)).body!.getReader();
    let completed = false;
    const failure = reader.read().then(result => { completed = true; return result; }).catch(error => error);
    for (let i = 0; i < 4; i++) {
      upstream.enqueue(new Uint8Array());
      await jest.advanceTimersByTimeAsync(10);
      expect(completed).toBe(false);
      expect(lifecycle.signal.aborted).toBe(false);
    }
    await jest.advanceTimersByTimeAsync(10);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT', policyVersion: 7 } } });
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts idle only when a read is outstanding, including after backpressure', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50 }));
    const reader = lifecycle.wrap(new Response(source)).body!.getReader();
    await jest.advanceTimersByTimeAsync(100);
    expect(lifecycle.signal.aborted).toBe(false);
    upstream.enqueue(Buffer.from('first'));
    expect((await reader.read()).value).toEqual(Buffer.from('first'));
    await jest.advanceTimersByTimeAsync(100);
    expect(lifecycle.signal.aborted).toBe(false);
    const failure = reader.read().catch(error => error);
    await jest.advanceTimersByTimeAsync(50);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_IDLE_TIMEOUT' } } });
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the total deadline active while downstream backpressure pauses idle', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot({ GATEWAY_STREAM_IDLE_TIMEOUT_MS: 50, GATEWAY_STREAM_TOTAL_TIMEOUT_MS: 200 }));
    const reader = lifecycle.wrap(new Response(source)).body!.getReader();
    upstream.enqueue(Buffer.from('first'));
    await reader.read();
    await jest.advanceTimersByTimeAsync(199);
    expect(lifecycle.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(reader.read()).rejects.toMatchObject({ response: { error: { code: 'UPSTREAM_STREAM_TOTAL_TIMEOUT' } } });
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([200, 503])('bounds headers and the entire non-stream body under HTTP %i', async status => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot({ GATEWAY_NON_STREAM_TIMEOUT_MS: 100, GATEWAY_STREAM_IDLE_TIMEOUT_MS: 10 }), undefined, false);
    await jest.advanceTimersByTimeAsync(40);
    const failure = lifecycle.wrap(new Response(source, { status })).text().catch(error => error);
    upstream.enqueue(Buffer.from('partial'));
    await jest.advanceTimersByTimeAsync(59);
    expect(lifecycle.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await failure).toMatchObject({ response: { error: { code: 'UPSTREAM_NON_STREAM_TIMEOUT', policyVersion: 7 } } });
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels a response arriving after the header deadline', async () => {
    const lifecycle = createGatewayStreamLifecycle(policySnapshot({ GATEWAY_STREAM_HEADER_TIMEOUT_MS: 40 }));
    await jest.advanceTimersByTimeAsync(40);
    expect(() => lifecycle.wrap(new Response(source))).toThrow(lifecycle.signal.reason);
    expect(cancel).toHaveBeenCalled();
    expect(source.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cleans up bodyless responses and removes the abort listener', () => {
    const client = new AbortController();
    const remove = jest.spyOn(client.signal, 'removeEventListener');
    const lifecycle = createGatewayStreamLifecycle(policySnapshot(), client.signal);
    const response = new Response(null, { status: 204 });
    expect(lifecycle.wrap(response)).toBe(response);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    client.abort();
    expect(lifecycle.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Gateway SSE observation without wire rewriting', () => {
  it('observes split UTF-8, CRLF, no-space data fields and multiline events', () => {
    const observer = createChatCompletionStreamObserver();
    const wire = 'data:{"choices":[{"delta":{"content":"中文"},\r\ndata:"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\r\n\r\ndata:[DONE]\r\n\r\n';
    for (const byte of new TextEncoder().encode(wire)) observer.write(Uint8Array.of(byte));
    expect(observer.finish()).toEqual({ finishReason: 'stop', done: true, protocolError: false, usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  });

  it('does not mistake DONE or usage for a model finish_reason', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(new TextEncoder().encode('data:{"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata:[DONE]\n\n'));
    expect(observer.finish()).toMatchObject({ finishReason: null, done: true });
  });

  it.each([' ', '\t', '\n'])('does not treat whitespace-only finish_reason %j as completion', (reason) => {
    const observer = createChatCompletionStreamObserver();
    observer.write(new TextEncoder().encode(
      `data:${JSON.stringify({ choices: [{ finish_reason: reason }] })}\n\ndata:[DONE]\n\n`,
    ));
    expect(observer.finish()).toMatchObject({ finishReason: null, done: true });
  });

  it.each(['stop', 'length', 'tool_calls', 'provider_specific_reason', ' provider_specific_reason '])(
    'preserves a non-empty finish_reason %j verbatim after a whitespace frame', (reason) => {
      const observer = createChatCompletionStreamObserver();
      observer.write(new TextEncoder().encode(
        `data:${JSON.stringify({ choices: [{ finish_reason: ' ' }] })}\n\n` +
        `data:${JSON.stringify({ choices: [{ finish_reason: reason }] })}\n\n`,
      ));
      expect(observer.finish()).toMatchObject({ finishReason: reason });
    },
  );

  it('does not overwrite an observed finish_reason with a later whitespace frame', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"length"}]}\n\n' +
      'data:{"choices":[{"finish_reason":" "}]}\n\n'));
    expect(observer.finish()).toMatchObject({ finishReason: 'length' });
  });

  it('bounds oversized diagnostics events and recovers for later frames', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(new TextEncoder().encode(`data:${'x'.repeat(1024 * 1024 + 1)}`));
    observer.write(new TextEncoder().encode('\n\ndata:{"choices":[{"finish_reason":"stop"}]}\n\ndata:[DONE]\n\n'));
    expect(observer.finish()).toEqual({ finishReason: 'stop', done: true, usage: null, protocolError: false });
  });

  it.each(['\u00e9', '\u4e2d', '\ud83d\ude00'])('bounds a complete multibyte event by UTF-8 bytes and recovers (%s)', (character) => {
    const observer = createChatCompletionStreamObserver();
    const padding = character.repeat(Math.ceil(1024 * 1024 / Buffer.byteLength(character, 'utf8')));
    const wire = `data:${JSON.stringify({
      padding, choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 2, completion_tokens: 3 },
    })}\n\n`;
    expect(wire.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(wire, 'utf8')).toBeGreaterThan(1024 * 1024);
    observer.write(Buffer.from(wire, 'utf8'));
    expect(observer.snapshot()).toEqual({ finishReason: null, done: false, usage: null, protocolError: false });
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"stop"}]}\n\ndata:[DONE]\n\n'));
    expect(observer.finish()).toEqual({ finishReason: 'stop', done: true, usage: null, protocolError: false });
  });

  it('bounds accumulated multibyte lines within one event and recovers after its delimiter', () => {
    const observer = createChatCompletionStreamObserver();
    const comment = `:${'\u4e2d'.repeat(200_000)}\n`;
    expect(Buffer.byteLength(comment, 'utf8')).toBeLessThan(1024 * 1024);
    observer.write(Buffer.from(comment));
    observer.write(Buffer.from(comment));
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'));
    expect(observer.snapshot()).toEqual({ finishReason: null, done: false, usage: null, protocolError: false });
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"tool_calls"}]}\n\ndata:[DONE]\n\n'));
    expect(observer.finish()).toEqual({ finishReason: 'tool_calls', done: true, usage: null, protocolError: false });
  });

  it('discards a multibyte unterminated buffer through the next delimiter and recovers', () => {
    const observer = createChatCompletionStreamObserver();
    const prefix = `data:{"padding":"${'\u4e2d'.repeat(350_000)}`;
    const bytes = Buffer.from(prefix, 'utf8');
    // Split inside a multibyte character as well as across the buffer limit.
    observer.write(bytes.subarray(0, 100_001));
    observer.write(bytes.subarray(100_001));
    observer.write(Buffer.from('","choices":[{"finish_reason":"length"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'));
    expect(observer.snapshot()).toEqual({ finishReason: null, done: false, usage: null, protocolError: false });
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"stop"}]}\n\ndata:[DONE]\n\n'));
    expect(observer.finish()).toEqual({ finishReason: 'stop', done: true, usage: null, protocolError: false });
  });

  it('does not extract usage or completion from an oversized multibyte EOF tail', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(Buffer.from(`data:${JSON.stringify({
      padding: '\u4e2d'.repeat(350_000), choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })}`));
    expect(observer.finish()).toEqual({ finishReason: null, done: false, usage: null, protocolError: false });
    expect(observer.finish()).toEqual(observer.snapshot());
  });

  it('reports usage at complete event boundaries and finalizes an EOF tail once', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(new TextEncoder().encode('data:{"usage":{"prompt_tokens":2,"completion_tokens":3}}'));
    expect(observer.snapshot().usage).toBeNull();
    expect(observer.finish().usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    expect(observer.finish()).toEqual(observer.snapshot());
  });

  it.each(['', '\n'])('does not promote an unterminated finish/DONE tail to success (%j)', (ending) => {
    const observer = createChatCompletionStreamObserver();
    observer.write(Buffer.from(`data:{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}${ending}`));
    expect(observer.finish()).toMatchObject({ finishReason: null, usage: { prompt_tokens: 2, completion_tokens: 3 } });
    const done = createChatCompletionStreamObserver();
    done.write(Buffer.from(`data:[DONE]${ending}`));
    expect(done.finish().done).toBe(false);
  });

  it('bounds empty data lines and discards oversized events until their delimiter', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(Buffer.from('data:\n'.repeat(4097)));
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"stop"}]}\n\n'));
    expect(observer.snapshot().finishReason).toBeNull();
    observer.write(Buffer.from('data:{"choices":[{"finish_reason":"tool_calls"}]}\n\n'));
    expect(observer.finish().finishReason).toBe('tool_calls');
  });

  it('marks embedded upstream errors and ignores invalid usage', () => {
    const observer = createChatCompletionStreamObserver();
    observer.write(new TextEncoder().encode('data:{"error":{"message":"failed"},"usage":{"prompt_tokens":-1,"completion_tokens":3}}\n\n'));
    expect(observer.finish()).toMatchObject({ protocolError: true, usage: null });
  });
});
