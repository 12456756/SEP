import { HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { EventEmitter, getEventListeners } from 'node:events';
import { ConversationController } from './conversation.controller';
import type { ConversationStreamService } from './conversation-stream.service';
import type { SseEvent } from './conversation.types';
import { ModelRequestLifecycle } from './model-request-lifecycle';

class ControlledResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, string>();
  readonly setHeader = jest.fn((name: string, value: string) => {
    this.headers.set(name.toLowerCase(), value);
  });
  readonly flushHeaders = jest.fn(() => {
    this.headersSent = true;
  });
  readonly write = jest.fn((_frame: string) => true);
  readonly end = jest.fn(() => {
    this.writableEnded = true;
  });

  disconnect(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const text: SseEvent = { event: 'text_delta', data: { text: 'First chunk' } };
const done: SseEvent = { event: 'done', data: { messageId: 'message-1' } };
const frame = (event: SseEvent) =>
  `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

describe('ConversationController SSE lifecycle', () => {
  let controller: ConversationController;
  let streamConversation: jest.Mock;
  let response: ControlledResponse;

  beforeEach(() => {
    streamConversation = jest.fn();
    response = new ControlledResponse();
    controller = new ConversationController(
      {} as never,
      { streamConversation } as unknown as ConversationStreamService,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function invoke() {
    return controller.sendMessage(
      'session-1',
      { content: 'Hello', targetEmployeeId: 'employee-1' },
      {
        user: { id: 'user-1', email: 'user@example.test', role: 'USER' },
      } as never,
      response as unknown as Response,
    );
  }

  it('leaves headers untouched before the first event and propagates admission 429 unchanged', async () => {
    const entered = deferred<void>();
    const rejected = deferred<void>();
    const error = new HttpException(
      {
        error: {
          code: 'PLATFORM_ADMISSION_REJECTED',
          source: 'platform',
          policyVersion: 7,
        },
      },
      429,
    );
    streamConversation.mockImplementation(async function* () {
      entered.resolve();
      await rejected.promise;
      throw error;
    });
    const outcome = invoke();
    const assertion = expect(outcome).rejects.toBe(error);
    await entered.promise;
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.flushHeaders).not.toHaveBeenCalled();
    expect(response.write).not.toHaveBeenCalled();
    rejected.resolve();
    await assertion;
    expect(response.end).not.toHaveBeenCalled();
    expect(response.listenerCount('close')).toBe(0);
  });

  it('starts SSE on the first event and forwards exactly the generator done event', async () => {
    const entered = deferred<void>();
    const emit = deferred<void>();
    streamConversation.mockImplementation(async function* () {
      entered.resolve();
      await emit.promise;
      yield text;
      yield done;
    });
    const outcome = invoke();
    await entered.promise;
    expect(response.flushHeaders).not.toHaveBeenCalled();
    emit.resolve();
    await outcome;
    expect(streamConversation).toHaveBeenCalledWith(
      'session-1',
      'Hello',
      'user-1',
      'employee-1',
      undefined,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.flushHeaders).toHaveBeenCalledTimes(1);
    expect(response.flushHeaders.mock.invocationCallOrder[0]).toBeLessThan(
      response.write.mock.invocationCallOrder[0],
    );
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(text),
      frame(done),
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });

  it.each([false, true])(
    'propagates response close to the service with started=%s and cleans the generator',
    async (started) => {
      const waiting = deferred<void>();
      const finalized = jest.fn();
      let signal!: AbortSignal;
      streamConversation.mockImplementation(async function* (
        ...args: unknown[]
      ) {
        signal = args[5] as AbortSignal;
        try {
          if (started) yield text;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            waiting.resolve();
          });
          yield done;
        } finally {
          finalized();
        }
      });
      const outcome = invoke();
      await waiting.promise;
      expect(signal.aborted).toBe(false);
      response.disconnect();
      await outcome;
      expect(signal.aborted).toBe(true);
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual(
        started ? [frame(text)] : [],
      );
      expect(response.end).not.toHaveBeenCalled();
      expect(response.listenerCount('close')).toBe(0);
      expect(response.listenerCount('drain')).toBe(0);
    },
  );

  it('waits for each drain before requesting the next generator event and preserves existing listeners', async () => {
    const wrote = deferred<void>();
    const nextStep = jest.fn();
    const existingClose = jest.fn();
    const existingDrain = jest.fn();
    response.on('close', existingClose);
    response.on('drain', existingDrain);
    response.write.mockImplementation(() => {
      wrote.resolve();
      return false;
    });
    streamConversation.mockImplementation(async function* () {
      yield text;
      nextStep();
      yield done;
    });
    const outcome = invoke();
    await wrote.promise;
    await turn();
    expect(nextStep).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
    expect(response.listenerCount('drain')).toBe(2);
    expect(response.listenerCount('close')).toBe(3);
    response.emit('drain');
    await turn();
    expect(nextStep).toHaveBeenCalledTimes(1);
    expect(response.write).toHaveBeenCalledTimes(2);
    expect(response.end).not.toHaveBeenCalled();
    expect(response.listenerCount('drain')).toBe(2);
    response.emit('drain');
    await outcome;
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(text),
      frame(done),
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.listeners('close')).toEqual([existingClose]);
    expect(response.listeners('drain')).toEqual([existingDrain]);
    expect(existingDrain).toHaveBeenCalledTimes(2);
  });

  it('unblocks a drain wait on disconnect, cancels the service and removes both temporary listeners', async () => {
    const wrote = deferred<void>();
    const finalized = jest.fn();
    let signal!: AbortSignal;
    response.write.mockImplementation(() => {
      wrote.resolve();
      return false;
    });
    streamConversation.mockImplementation(async function* (...args: unknown[]) {
      signal = args[5] as AbortSignal;
      try {
        yield text;
        signal.throwIfAborted();
        yield done;
      } finally {
        finalized();
      }
    });
    const outcome = invoke();
    await wrote.promise;
    await turn();
    expect(response.listenerCount('drain')).toBe(1);
    expect(response.listenerCount('close')).toBe(2);
    response.disconnect();
    await outcome;
    expect(signal.aborted).toBe(true);
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(text),
    ]);
    expect(response.end).not.toHaveBeenCalled();
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    response.emit('drain');
    expect(response.write).toHaveBeenCalledTimes(1);
  });

  it('does not abort a normally ended response when close is emitted by end', async () => {
    streamConversation.mockImplementation(async function* () {
      yield done;
    });
    response.end.mockImplementation(() => {
      response.writableEnded = true;
      response.emit('close');
    });
    await invoke();
    const signal = streamConversation.mock.calls[0][5] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(done),
    ]);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('wakes a drain wait on the policy deadline, delivers timeout and awaits generator resource release', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const wrote = deferred<void>();
    const releaseAllowed = deferred<void>();
    const release = jest.fn(async () => {
      await releaseAllowed.promise;
    });
    const abortListeners = jest.spyOn(
      AbortSignal.prototype,
      'addEventListener',
    );
    let externalSignal!: AbortSignal;
    let lifecycle!: ModelRequestLifecycle;
    let timeout!: SseEvent;
    response.write.mockImplementation(() => {
      wrote.resolve();
      return false;
    });
    streamConversation.mockImplementation(async function* (...args: unknown[]) {
      externalSignal = args[5] as AbortSignal;
      lifecycle = new ModelRequestLifecycle(1000, externalSignal);
      const notify = () =>
        (args[6] as (reason: unknown) => void)(lifecycle.signal.reason);
      lifecycle.signal.addEventListener('abort', notify, { once: true });
      try {
        yield text;
        lifecycle.assertActive();
        yield done;
      } catch (error) {
        timeout = {
          event: 'error',
          data: (error as HttpException).getResponse(),
        } as SseEvent;
        yield timeout;
      } finally {
        lifecycle.signal.removeEventListener('abort', notify);
        lifecycle.dispose();
        await release();
      }
    });
    const outcome = invoke();
    try {
      await wrote.promise;
      await turn();
      expect(response.listenerCount('drain')).toBe(1);
      expect(release).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      await turn();
      expect(lifecycle.signal.aborted).toBe(true);
      expect(externalSignal.aborted).toBe(false);
      expect(timeout.data).toMatchObject({
        code: 'MODEL_REQUEST_TIMEOUT',
        source: 'platform',
      });
      expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
        frame(text),
        frame(timeout),
      ]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(response.end).not.toHaveBeenCalled();
      expect(response.listenerCount('drain')).toBe(0);
      const policySignal = abortListeners.mock.contexts.find(
        (signal) => signal !== externalSignal && signal !== lifecycle.signal,
      );
      expect(policySignal).toBeDefined();
      expect(getEventListeners(policySignal!, 'abort')).toHaveLength(0);
      expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(0);
      expect(getEventListeners(externalSignal, 'abort')).toHaveLength(0);
      releaseAllowed.resolve();
      await outcome;
      expect(response.end).toHaveBeenCalledTimes(1);
      expect(release.mock.invocationCallOrder[0]).toBeLessThan(
        response.end.mock.invocationCallOrder[0],
      );
    } finally {
      releaseAllowed.resolve();
      if (!response.writableEnded) response.disconnect();
      await outcome;
    }
    expect(response.listenerCount('close')).toBe(0);
  });

  it.each(['before-write', 'during-write'])(
    'does not wait for drain when policy abort happens %s',
    async (timing) => {
      const release = jest.fn().mockResolvedValue(undefined);
      const timeout: SseEvent = {
        event: 'error',
        data: { code: 'MODEL_REQUEST_TIMEOUT', source: 'platform' },
      };
      let notify!: (reason: unknown) => void;
      let externalSignal!: AbortSignal;
      response.write.mockImplementation(() => {
        if (timing === 'during-write') notify(timeout.data);
        return false;
      });
      streamConversation.mockImplementation(async function* (
        ...args: unknown[]
      ) {
        externalSignal = args[5] as AbortSignal;
        notify = args[6] as (reason: unknown) => void;
        try {
          if (timing === 'before-write') notify(timeout.data);
          yield text;
          yield timeout;
        } finally {
          await release();
        }
      });
      const outcome = invoke();
      try {
        await turn();
        expect(release).toHaveBeenCalledTimes(1);
        expect(externalSignal.aborted).toBe(false);
        expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
          frame(text),
          frame(timeout),
        ]);
        expect(response.end).toHaveBeenCalledTimes(1);
        expect(response.listenerCount('drain')).toBe(0);
        expect(response.listenerCount('close')).toBe(0);
      } finally {
        response.disconnect();
        await outcome;
      }
    },
  );

  it('does not fabricate done when the service ends without one', async () => {
    streamConversation.mockImplementation(async function* () {
      yield text;
    });
    await invoke();
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(text),
    ]);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('writes one structured SSE error after streaming starts without fabricating done', async () => {
    const details = {
      error: {
        message: 'Model request limited',
        code: 'PLATFORM_ADMISSION_REJECTED',
        source: 'platform',
        policyVersion: 8,
      },
    };
    streamConversation.mockImplementation(async function* () {
      yield text;
      throw new HttpException(details, 429);
    });
    await invoke();
    expect(response.write.mock.calls.map(([chunk]) => chunk)).toEqual([
      frame(text),
      `event: error\ndata: ${JSON.stringify({ ...details, ...details.error })}\n\n`,
    ]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'SSE error session=session-1 status=429',
    );
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('retains an unexpected failure reason in SSE', async () => {
    const secret = 'test-only-upstream-private-detail';
    streamConversation.mockImplementation(async function* () {
      yield text;
      throw new Error(secret);
    });

    await invoke();

    expect(response.write).toHaveBeenCalledTimes(2);
    expect(response.write.mock.calls[0][0]).toBe(frame(text));
    const errorFrame = response.write.mock.calls[1][0];
    expect(errorFrame).toMatch(/^event: error\ndata: /);
    expect(errorFrame).toContain(secret);
    expect(JSON.parse(errorFrame.split('\ndata: ')[1].trim())).toEqual({
      name: 'Error', message: secret,
    });
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'SSE error session=session-1 status=internal',
    );
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });
});
