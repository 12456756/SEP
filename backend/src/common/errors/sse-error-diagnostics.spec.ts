import { createSseErrorDiagnostics } from './sse-error-diagnostics';
import { redactUpstreamStream } from './upstream-http.exception';

describe('SSE error diagnostics', () => {
  it('preserves successful CRLF frames and split UTF-8 exactly', () => {
    const raw = Buffer.from('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: [DONE]\n\n');
    const parser = createSseErrorDiagnostics();
    const frames = [...raw].flatMap(byte => parser.write(Buffer.from([byte])));
    expect(Buffer.concat([...frames, ...parser.finish()])).toEqual(raw);
    expect(parser.error()).toBeUndefined();
  });

  it.each(['error', 'response.failed', 'response.error'])(
    'retains %s numeric codes, nested reasons and attempts after redaction', event => {
      const payload = { type: event, error: { code: 40112, message: 'Invalid credential opaque-key',
        details: { field: 'duration', minimum: 4, apiKey: 'opaque-key' } }, attempts: [{ upstream_status: 422 }] };
      const parser = createSseErrorDiagnostics(['opaque-key']);
      const raw = `event: ${event}\r\nid: opaque-key\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
      const frames = [...parser.write(Buffer.from(raw.slice(0, 43))), ...parser.write(Buffer.from(raw.slice(43))), ...parser.finish()];
      const text = Buffer.concat(frames).toString();
      expect(text).not.toContain('opaque-key');
      expect(text).toContain('id: [REDACTED]');
      expect(parser.error()).toMatchObject({ error: { code: 40112, message: 'Invalid credential [REDACTED]',
        details: { field: 'duration', minimum: 4, apiKey: '[REDACTED]' } }, attempts: payload.attempts });
    },
  );

  it('preserves multiline and plain text vendor error events, including an EOF tail', () => {
    const parser = createSseErrorDiagnostics();
    parser.write(Buffer.from('event: error\ndata: {"error":\ndata: {"message":"seconds is required","code":42201}}\n\n'));
    expect(parser.error()).toMatchObject({ error: { message: 'seconds is required', code: 42201 } });
    parser.write(Buffer.from('event: error\ndata: Unauthorized Bearer token-value'));
    expect(Buffer.concat(parser.finish()).toString()).toContain('Unauthorized Bearer [REDACTED]');
  });

  it('cancels an unread transformed stream without waiting for a complete frame', async () => {
    const cancel = jest.fn();
    const response = redactUpstreamStream(new Response(new ReadableStream({ cancel })));
    await response.body.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retains and redacts the transport cause when a stream read fails', async () => {
    const response = redactUpstreamStream(new Response(new ReadableStream({
      pull(controller) { controller.error(Object.assign(new Error('socket closed opaque-key'), { code: 'ECONNRESET' })); },
    })), ['opaque-key']);
    await expect(response.text()).rejects.toMatchObject({ status: 502, response: {
      message: 'socket closed [REDACTED]', cause: { code: 'ECONNRESET' } } });
  });
});
