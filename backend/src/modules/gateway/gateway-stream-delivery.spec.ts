import { createGatewayStreamDelivery } from './gateway-stream-delivery';

describe('Gateway SSE terminal delivery', () => {
  it.each(['\n\n', '\r\n\r\n', '\r\r', ''])('holds an exact DONE event across UTF-8 and marker boundaries (%j)', ending => {
    const content = Buffer.from('data:{"choices":[{"delta":{"content":"中文 [DONE]"}}]}\r\n\r\n');
    const marker = Buffer.from('data: [DONE]' + ending), delivery = createGatewayStreamDelivery();
    const forwarded = [...Buffer.concat([content, marker])].flatMap(byte => delivery.write(Uint8Array.of(byte)));
    forwarded.push(...delivery.finish());
    expect(Buffer.concat(forwarded)).toEqual(content);
    expect(delivery.complete()).toEqual(marker); expect(delivery.complete()).toBeUndefined();
  });
  it('keeps usage after an early marker ahead of the terminal frame without buffering the whole stream', () => {
    const delivery = createGatewayStreamDelivery(), marker = Buffer.from('data:[DONE]\n\n');
    expect(delivery.write(marker)).toEqual([]);
    const usage = Buffer.from('data:{"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n');
    expect(delivery.write(usage)).toEqual([usage]);
    expect(delivery.finish()).toEqual([]); expect(delivery.complete()).toEqual(marker);
  });
  it('never invents DONE and retains only one copy of duplicate terminal frames', () => {
    const empty = createGatewayStreamDelivery(); expect(empty.finish()).toEqual([]); expect(empty.complete()).toBeUndefined();
    const delivery = createGatewayStreamDelivery();
    expect(delivery.write(Buffer.from('data:[DONE]\n\ndata: [DONE]\n\n'))).toEqual([]);
    expect(delivery.complete()).toEqual(Buffer.from('data:[DONE]\n\n')); expect(delivery.complete()).toBeUndefined();
  });
  it('enforces the existing event size limit even while a success marker is retained', () => {
    const delivery = createGatewayStreamDelivery(); delivery.write(Buffer.from('data:[DONE]\n\n'));
    expect(() => delivery.write(Buffer.from('data:' + 'x'.repeat(8 * 1024 * 1024)))).toThrow();
  });
});
