import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response as ExpressResponse } from 'express';
import { Writable } from 'node:stream';
import type { ChatCompletionRequest } from 'shared';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { policySnapshot } from './gateway-policy.test-fixtures';

class StreamResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();
  headersSent = false;
  onChunk?: () => void;

  constructor(private readonly delayWrites = false) {
    super({ highWaterMark: 1 });
    // pipeline errors are asserted through the response state, not unhandled events.
    this.on('error', () => undefined);
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  flushHeaders() { this.headersSent = true; }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    this.onChunk?.();
    if (this.delayWrites) setImmediate(callback);
    else callback();
  }

  get bytes() { return Buffer.concat(this.chunks); }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const requestId = 'controller-stream-request-123';
const snapshot = policySnapshot();
const claims: ClientEmploymentClaims = {
  sub: 'user-1', enterpriseId: 'enterprise-1', subscriptionId: 'subscription-1',
  memberId: 'member-1', sid: 'session-auth-1', type: 'client-employment', iat: 1, exp: 9999999999,
};
const dto: ChatCompletionRequest = {
  model: 'test-model', messages: [{ role: 'user', content: 'synthetic' }], stream: true,
};
const finish = 'data:{"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n';
const usageEvent = `data:${JSON.stringify({ choices: [], usage })}`;
const content = 'data:{"choices":[{"delta":{"content":"中文分片"},"finish_reason":null}]}\r\n\r\n';

describe('GatewayController raw SSE streaming', () => {
  let controller: GatewayController;
  let forward: jest.SpyInstance;
  let executions: Record<string, jest.Mock>;
  let release: jest.Mock;
  let releaseRequest: jest.Mock;
  let acquire: jest.Mock;
  let reserve: jest.Mock;
  let prepare: jest.SpyInstance;
  let beginRequest: jest.Mock;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    const service = new GatewayService(
      {} as never, new ConfigService(), {} as never, {} as never, {} as never,
    );
    jest.spyOn(service, 'validateAndAuthorize').mockResolvedValue({
      enterpriseId: claims.enterpriseId, subscriptionId: claims.subscriptionId,
      memberId: claims.memberId, employeeId: 'employee-1',
    });
    prepare = jest.spyOn(service, 'prepareRequest').mockResolvedValue({
      request: { ...dto, max_tokens: 4096, stream_options: { include_usage: true } },
      allowedModels: [dto.model], inputBytes: 100,
    });
    forward = jest.spyOn(service, 'forwardChatCompletion');
    executions = {
      start: jest.fn().mockResolvedValue({ id: 'server-execution' }),
      setUpstreamRequest: jest.fn().mockResolvedValue(undefined),
      saveUsage: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    release = jest.fn().mockResolvedValue(undefined);
    releaseRequest = jest.fn();
    acquire = jest.fn().mockResolvedValue({ release });
    reserve = jest.fn().mockResolvedValue(undefined);
    beginRequest = jest.fn().mockReturnValue(releaseRequest);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    controller = new GatewayController(service, executions as never, { acquire, reserve } as never, { beginRequest } as never);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  function invoke(res: StreamResponse) {
    return controller.chatCompletions(
      dto, claims,
      { 'x-sep-session-id': 'session-1', 'x-sep-message-id': 'message-1' },
      { requestId, modelRuntimePolicy: snapshot } as unknown as Request & { requestId: string },
      res as unknown as ExpressResponse,
    );
  }

  function respondWithBytes(raw: Buffer, oneByteChunks = false) {
    forward.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(source) {
        if (oneByteChunks) {
          for (const byte of raw) source.enqueue(Uint8Array.of(byte));
        } else source.enqueue(raw);
        source.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
  }

  async function expectSingleLedgerEntry() {
    await turn();
    await turn();
    expect(executions.saveUsage).toHaveBeenCalledTimes(1);
    expect(executions.saveUsage).toHaveBeenCalledWith('server-execution', usage);
    expect(executions.finish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(claims, dto, snapshot);
    expect(executions.start).toHaveBeenCalledWith(claims, 'employee-1', dto.model, requestId, snapshot, undefined);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(claims, snapshot);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(claims, snapshot, {
      ...dto, max_tokens: 4096, stream_options: { include_usage: true },
    }, 4096);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(forward.mock.invocationCallOrder[0]);
  }

  it('preserves no-space data fields, CRLF, split UTF-8 and an EOF tail byte-for-byte', async () => {
    const raw = Buffer.from(`: keepalive\r\n\r\n${content}${finish}${usageEvent}\r\n\r\ndata:[DONE]`);
    respondWithBytes(raw, true);
    const res = new StreamResponse();
    await invoke(res);
    expect(res.bytes).toEqual(raw);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.writableFinished).toBe(true);
    expect(raw.byteLength).toBeGreaterThan(raw.toString().length);
    expect([...log.mock.calls, ...warn.mock.calls]).toContainEqual([expect.objectContaining({
      message: 'gateway stream ended', requestId, executionId: 'server-execution',
      bytesForwarded: raw.byteLength,
    })]);
    await expectSingleLedgerEntry();
  });

  it('logs header and data arrival times before journal delays with correlated raw byte totals', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    forward.mockImplementation(async () => {
      now = 1050;
      return new Response(new ReadableStream<Uint8Array>({
        start(value) { source = value; },
      }), { headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'provider-request-123' } });
    });
    executions.setUpstreamRequest.mockImplementation(async () => { now = 1100; });
    executions.saveUsage.mockImplementation(async () => { now = 1700; });
    const res = new StreamResponse();
    const wrote = deferred<void>();
    res.onChunk = () => wrote.resolve();
    const outcome = invoke(res);
    await turn();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'provider response received', requestId, executionId: 'server-execution',
      upstreamRequestId: 'provider-request-123', headerLatencyMs: 50,
      firstByteLatencyMs: null, lastDataAt: null, bytesForwarded: 0,
    }));
    now = 1200;
    source.enqueue(Buffer.from(content));
    await wrote.promise;
    now = 1300;
    const tail = `${finish}${usageEvent}\n\ndata:[DONE]\n\n`;
    source.enqueue(Buffer.from(tail));
    source.close();
    await outcome;
    expect(res.bytes).toEqual(Buffer.from(`${content}${tail}`));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream ended', requestId, executionId: 'server-execution',
      upstreamRequestId: 'provider-request-123', headerLatencyMs: 50,
      firstByteLatencyMs: 200, lastDataAt: 1300, bytesForwarded: res.bytes.byteLength,
      durationMs: 700,
    }));
    await expectSingleLedgerEntry();
  });

  it.each(['empty EOF', 'read failure'])('logs null data arrival times and zero bytes after %s without data', async (failure) => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let source!: ReadableStreamDefaultController<Uint8Array>;
    forward.mockImplementation(async () => {
      now = 1050;
      return new Response(new ReadableStream<Uint8Array>({
        start(value) { source = value; },
      }), { headers: { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'provider-request-123' } });
    });
    const res = new StreamResponse();
    const outcome = invoke(res);
    await turn();
    now = 1200;
    if (failure === 'empty EOF') source.close();
    else source.error(new Error('synthetic read failure before data'));
    await outcome;
    expect(res.bytes.byteLength).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream interrupted', requestId, executionId: 'server-execution',
      upstreamRequestId: 'provider-request-123', headerLatencyMs: 50,
      firstByteLatencyMs: null, lastDataAt: null, bytesForwarded: 0, durationMs: 200,
    }));
    expect(executions.saveUsage).not.toHaveBeenCalled();
  });

  it('records usage from a final unterminated data field without inventing DONE', async () => {
    const raw = Buffer.from(`${content}${finish}${usageEvent}`);
    respondWithBytes(raw, true);
    const res = new StreamResponse();
    await invoke(res);
    expect(res.bytes).toEqual(raw);
    expect(res.bytes.toString()).not.toContain('[DONE]');
    await expectSingleLedgerEntry();
  });

  it('records duplicate usage frames only once', async () => {
    const raw = Buffer.from(`${finish}${usageEvent}\n\n${usageEvent}\n\ndata:[DONE]\n\n`);
    respondWithBytes(raw);
    const res = new StreamResponse();
    await invoke(res);
    expect(res.bytes).toEqual(raw);
    await expectSingleLedgerEntry();
  });

  it('destroys incomplete EOF without synthesizing finish or DONE while retaining observed usage', async () => {
    const raw = Buffer.from(`${content}${usageEvent}`);
    respondWithBytes(raw, true);
    const res = new StreamResponse();
    await invoke(res);
    expect(res.bytes).toEqual(raw);
    expect(res.writableFinished).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(res.bytes.toString()).not.toContain('[DONE]');
    expect(res.bytes.toString()).not.toContain('"finish_reason":"stop"');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream interrupted', requestId, executionId: 'server-execution',
      headerLatencyMs: expect.any(Number), firstByteLatencyMs: expect.any(Number),
      lastDataAt: expect.any(Number), bytesForwarded: raw.byteLength,
    }));
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain(requestId);
    expect(error).not.toHaveBeenCalled();
    expect(executions.finish).toHaveBeenCalledWith('server-execution', expect.objectContaining({ errorCode: 'UPSTREAM_INCOMPLETE_STREAM' }));
    await expectSingleLedgerEntry();
  });

  it.each([' ', '\t', '\n'])('rejects whitespace-only finish_reason %j without rewriting SSE', async (reason) => {
    const raw = Buffer.from(`${content}data:${JSON.stringify({ choices: [{ finish_reason: reason }] })}\n\n` +
      `${usageEvent}\n\ndata:[DONE]\n\n`);
    respondWithBytes(raw, true);
    const res = new StreamResponse();
    await invoke(res);
    expect(res.bytes).toEqual(raw);
    expect(res.writableFinished).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(executions.finish).toHaveBeenCalledWith('server-execution', {
      finishReason: null, done: true, errorCode: 'UPSTREAM_INCOMPLETE_STREAM',
    });
    await expectSingleLedgerEntry();
  });

  it.each(['stop', 'length', 'tool_calls', 'provider_specific_reason', ' provider_specific_reason '])(
    'forwards and records non-blank finish_reason %j verbatim', async (reason) => {
      const raw = Buffer.from(`${content}data:${JSON.stringify({ choices: [{ finish_reason: reason }] })}\n\n` +
        `${usageEvent}\n\ndata:[DONE]\n\n`);
      respondWithBytes(raw, true);
      const res = new StreamResponse();
      await invoke(res);
      expect(res.bytes).toEqual(raw);
      expect(res.writableFinished).toBe(true);
      expect(executions.finish).toHaveBeenCalledWith('server-execution', {
        finishReason: reason, done: true, errorCode: undefined,
      });
      await expectSingleLedgerEntry();
    },
  );

  it('waits for a backpressured Writable to finish all raw bytes', async () => {
    const raw = Buffer.from(`${content}${finish}${usageEvent}\n\ndata:[DONE]\n\n`);
    respondWithBytes(raw, true);
    const res = new StreamResponse(true);
    const write = jest.spyOn(res, 'write');
    await invoke(res);
    expect(write.mock.results.some((result) => result.value === false)).toBe(true);
    expect(res.writableFinished).toBe(true);
    expect(res.bytes).toEqual(raw);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream ended', bytesForwarded: raw.byteLength,
    }));
    await expectSingleLedgerEntry();
  });

  it('destroys the response on upstream read failure instead of a successful end and logs requestId', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    forward.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(value) { source = value; },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const res = new StreamResponse();
    const wrote = deferred<void>();
    res.onChunk = () => wrote.resolve();
    const end = jest.spyOn(res, 'end');
    const outcome = invoke(res).catch((failure) => failure);
    await turn();
    source.enqueue(Buffer.from(content));
    await wrote.promise;
    source.error(new Error('synthetic upstream read failure'));
    await outcome;
    await turn();
    expect(res.writableFinished).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(end).not.toHaveBeenCalled();
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).toContain(requestId);
    expect(res.bytes.toString()).not.toContain('[DONE]');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream interrupted', requestId,
      firstByteLatencyMs: expect.any(Number), lastDataAt: expect.any(Number),
      bytesForwarded: Buffer.byteLength(content),
    }));
    expect(executions.saveUsage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('aborts the upstream client signal when res.close arrives before headers', async () => {
    const entered = deferred<void>();
    const headers = deferred<Response>();
    let signal: AbortSignal | undefined;
    forward.mockImplementation((_dto, _snapshot, _requestId, clientSignal?: AbortSignal) => {
      signal = clientSignal;
      entered.resolve();
      return headers.promise;
    });
    const res = new StreamResponse();
    const outcome = invoke(res).catch((failure) => failure);
    await entered.promise;
    try {
      expect(res.headersSent).toBe(false);
      res.destroy();
      await turn();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      expect(forward.mock.calls[0].slice(0, 3)).toEqual([
        { ...dto, max_tokens: 4096, stream_options: { include_usage: true } }, snapshot, requestId,
      ]);
    } finally {
      headers.resolve(new Response(''));
      await outcome;
    }
    expect(executions.saveUsage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('aborts the upstream client signal when res.close arrives during a pending read', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | undefined;
    const upstreamCancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(value) { source = value; }, cancel: upstreamCancelled,
    });
    forward.mockImplementation((_dto, _snapshot, _requestId, clientSignal?: AbortSignal) => {
      signal = clientSignal;
      signal?.addEventListener('abort', () => {
        try { source.error(signal?.reason ?? new Error('client disconnected')); } catch { /* Already cancelled. */ }
      }, { once: true });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    });
    const res = new StreamResponse();
    const wrote = deferred<void>();
    res.onChunk = () => wrote.resolve();
    const outcome = invoke(res).catch((failure) => failure);
    await turn();
    source.enqueue(Buffer.from(content));
    await wrote.promise;
    try {
      res.destroy();
      await turn();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
    } finally {
      try { source.error(new Error('test cleanup')); } catch { /* Already cancelled. */ }
      await outcome;
    }
    expect(res.writableFinished).toBe(false);
    expect(res.bytes.toString()).not.toContain('[DONE]');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream interrupted', requestId, executionId: 'server-execution',
      clientDisconnected: true, bytesForwarded: Buffer.byteLength(content),
      firstByteLatencyMs: expect.any(Number), lastDataAt: expect.any(Number),
    }));
    expect(executions.saveUsage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('fails closed before forwarding when execution storage is unavailable', async () => {
    executions.start.mockRejectedValue(new Error('database unavailable'));
    await expect(invoke(new StreamResponse())).rejects.toThrow('database unavailable');
    expect(forward).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('releases activity and records a definitive failure when admission rejects', async () => {
    acquire.mockRejectedValue(new Error('rate limit'));
    await expect(invoke(new StreamResponse())).rejects.toThrow('rate limit');
    expect(forward).not.toHaveBeenCalled();
    expect(executions.fail).toHaveBeenCalledWith('server-execution', 'EXECUTION_FAILED', true, false);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects JSON mislabeled as a successful stream before flushing headers', async () => {
    const cancel = jest.fn();
    forward.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const res = new StreamResponse();
    await expect(invoke(res)).rejects.toMatchObject({ response: { error: { code: 'UPSTREAM_INVALID_CONTENT_TYPE' } } });
    expect(res.headersSent).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(executions.fail).toHaveBeenCalledWith('server-execution', 'UPSTREAM_INVALID_CONTENT_TYPE', false, false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not end successfully when durable usage checkpointing fails', async () => {
    executions.saveUsage.mockRejectedValue(new Error('storage failure'));
    respondWithBytes(Buffer.from(`${finish}${usageEvent}\n\ndata:[DONE]\n\n`));
    const res = new StreamResponse();
    await invoke(res);
    expect(res.writableFinished).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(res.bytes.byteLength).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'gateway stream interrupted', requestId,
      firstByteLatencyMs: expect.any(Number), lastDataAt: expect.any(Number), bytesForwarded: 0,
    }));
    expect(executions.fail).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a finish_reason present only in an unclosed EOF event', async () => {
    respondWithBytes(Buffer.from('data:{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}'));
    const res = new StreamResponse();
    await invoke(res);
    expect(res.writableFinished).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(executions.saveUsage).toHaveBeenCalledWith('server-execution', usage);
    expect(executions.finish).toHaveBeenCalledWith('server-execution', expect.objectContaining({
      finishReason: null, done: false, errorCode: 'UPSTREAM_INCOMPLETE_STREAM',
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(['client', 'upstream', 'late-rejection'])('bounds a pending usage checkpoint after %s failure', async (failure) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    let complete!: () => void;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const entered = deferred<void>();
    executions.saveUsage.mockImplementation(() => new Promise((resolve, reject) => {
      complete = () => failure === 'late-rejection' ? reject(new Error('late storage error')) : resolve(undefined);
      entered.resolve();
    }));
    forward.mockResolvedValue(new Response(new ReadableStream({ start(value) {
      source = value;
      source.enqueue(Buffer.from(`${usageEvent}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const res = new StreamResponse();
    const outcome = invoke(res);
    try {
      await entered.promise;
      if (failure === 'client') res.destroy();
      else source.error(new Error('synthetic upstream timeout'));
      await jest.advanceTimersByTimeAsync(5000);
      await outcome;
      expect(executions.saveUsage).toHaveBeenCalledTimes(1);
      expect(executions.finish).not.toHaveBeenCalled();
      expect(executions.fail).toHaveBeenCalledWith('server-execution', 'EXECUTION_JOURNAL_TIMEOUT', false, true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseRequest).toHaveBeenCalledTimes(1);
      complete();
      await turn();
      expect(executions.finish).not.toHaveBeenCalled();
    } finally { complete(); jest.useRealTimers(); }
  });

  it('releases transport resources when finish storage remains pending after EOF', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const entered = deferred<void>();
    const pending = deferred<void>();
    executions.finish.mockImplementation(() => { entered.resolve(); return pending.promise; });
    respondWithBytes(Buffer.from(`${finish}${usageEvent}\n\ndata:[DONE]\n\n`));
    const res = new StreamResponse();
    const outcome = invoke(res);
    try {
      await entered.promise;
      await jest.advanceTimersByTimeAsync(5000);
      await outcome;
      expect(res.writableFinished).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseRequest).toHaveBeenCalledTimes(1);
    } finally { pending.resolve(); jest.useRealTimers(); }
  });

  it('bounds failure storage and releases activity when admission is rejected', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    acquire.mockRejectedValue(new Error('rate limit'));
    const entered = deferred<void>();
    const pending = deferred<void>();
    executions.fail.mockImplementation(() => { entered.resolve(); return pending.promise; });
    const outcome = invoke(new StreamResponse()).catch(error => error);
    try {
      await entered.promise;
      await jest.advanceTimersByTimeAsync(5000);
      expect(await outcome).toMatchObject({ message: 'rate limit' });
      expect(releaseRequest).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    } finally { pending.resolve(); jest.useRealTimers(); }
  });

  it('releases an owned lease that arrives after admission times out', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const entered = deferred<void>();
    const pending = deferred<{ release: jest.Mock }>();
    acquire.mockImplementation(() => { entered.resolve(); return pending.promise; });
    const outcome = invoke(new StreamResponse()).catch(error => error);
    try {
      await entered.promise;
      await jest.advanceTimersByTimeAsync(5000);
      expect(await outcome).toMatchObject({ response: { error: { code: 'PLATFORM_ADMISSION_TIMEOUT' } } });
      expect(forward).not.toHaveBeenCalled();
      expect(releaseRequest).toHaveBeenCalledTimes(1);
      pending.resolve({ release });
      await turn();
      expect(release).toHaveBeenCalledTimes(1);
    } finally { pending.resolve({ release }); jest.useRealTimers(); }
  });

  it('does not hold activity forever when Redis lease release stays pending', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const entered = deferred<void>();
    const pending = deferred<void>();
    release.mockImplementation(() => { entered.resolve(); return pending.promise; });
    respondWithBytes(Buffer.from(`${finish}${usageEvent}\n\ndata:[DONE]\n\n`));
    const outcome = invoke(new StreamResponse());
    try {
      await entered.promise;
      await jest.advanceTimersByTimeAsync(5000);
      await outcome;
      expect(releaseRequest).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).toContain('gateway_admission_release_timeout');
    } finally { pending.resolve(); jest.useRealTimers(); }
  });

  it('releases the owned lease when reservation rejects without masking the original error', async () => {
    const failure = new Error('resource limit');
    reserve.mockRejectedValue(failure);
    release.mockRejectedValue(new Error('release unavailable'));
    await expect(invoke(new StreamResponse())).rejects.toBe(failure);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
    expect(executions.fail).toHaveBeenCalledWith('server-execution', 'EXECUTION_FAILED', true, false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseRequest).toHaveBeenCalledTimes(1);
  });

  it('bounds a pending reservation and never forwards after its late completion', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const entered = deferred<void>();
    const pending = deferred<void>();
    reserve.mockImplementation(() => { entered.resolve(); return pending.promise; });
    const outcome = invoke(new StreamResponse()).catch(error => error);
    try {
      await entered.promise;
      await jest.advanceTimersByTimeAsync(5000);
      expect(await outcome).toMatchObject({ response: { error: { code: 'PLATFORM_ADMISSION_TIMEOUT' } } });
      expect(release).toHaveBeenCalledTimes(1);
      expect(releaseRequest).toHaveBeenCalledTimes(1);
      pending.resolve();
      await turn();
      expect(forward).not.toHaveBeenCalled();
    } finally { pending.resolve(); jest.useRealTimers(); }
  });
});
