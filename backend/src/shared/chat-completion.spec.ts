import { ChatCompletionRequestSchema } from './index';

const toolCall = {
  id: 'call_test_ls_001',
  type: 'function',
  function: { name: 'ls', arguments: '{}' },
};

function followUp(content: string | null = '') {
  return {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'user', content: '查看工作目录中有什么文件' },
      { role: 'assistant', content, tool_calls: [structuredClone(toolCall)], reasoning_content: 'List the directory.' },
      { role: 'tool', tool_call_id: toolCall.id, content: 'file-a.txt\nfile-b.txt' },
    ],
    tools: [{ type: 'function', function: { name: 'ls', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  };
}

describe('ChatCompletionRequestSchema tool round trip', () => {
  it('preserves tool linkage, reasoning and request options after validation', () => {
    const request = followUp();
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it.each(['', null, undefined])('accepts assistant tool calls with content=%s', (content) => {
    const request = followUp();
    request.messages[1].content = content;
    expect(ChatCompletionRequestSchema.parse(request).messages[1]).toEqual(request.messages[1]);
  });

  it('preserves an explicitly empty reasoning_content', () => {
    const request = followUp();
    request.messages[1].reasoning_content = '';
    expect(ChatCompletionRequestSchema.parse(request).messages[1]).toHaveProperty('reasoning_content', '');
  });

  it('accepts and preserves user text and Base64 image content parts', () => {
    const request = { model: 'test', messages: [{ role: 'user', content: [
      { type: 'text', text: '理解一下这张图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'auto' } },
    ] }] };
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,not base64',
    'data:image/png;base64,YQ=',
    'file:///tmp/image.png',
  ])('rejects unsupported or malformed image URL %s', (url) => {
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url } },
    ] }] }).success).toBe(false);
  });

  it('rejects multimodal content outside user messages and malformed content parts', () => {
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: [{ role: 'assistant', content: [
      { type: 'text', text: 'unsupported role' },
    ] }] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.com/image.png', extra: true } },
    ] }] }).success).toBe(false);
  });

  it('preserves multiple tool results without requiring every result to immediately follow assistant', () => {
    const request = followUp();
    request.messages[1].tool_calls.push({ ...structuredClone(toolCall), id: 'call_second' });
    request.messages.push({ role: 'tool', tool_call_id: 'call_second', content: 'second result' });
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it('accepts empty tool_calls on an assistant text response', () => {
    const request = { model: 'test', messages: [{ role: 'assistant', content: 'done', tool_calls: [] }] };
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it.each(['enterpriseId', 'response_format', 'max_completion_tokens', 'top_p', 'stop'])(
    'rejects unsupported field %s rather than silently discarding it', (field) => {
      const result = ChatCompletionRequestSchema.safeParse({ ...followUp(), [field]: 'untrusted' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
      ]));
    },
  );

  it.each([
    { messages: [{ role: 'user', content: 'hello', unsupported: true }] },
    { tools: [{ type: 'function', function: { name: 'ls', unsupported: true } }] },
    { stream_options: { include_usage: true, unsupported: true } },
    { thinking: { type: 'enabled', unsupported: true } },
    { tool_choice: { type: 'function', function: { name: 'ls', unsupported: true } } },
  ])('rejects unknown nested protocol fields %p', (overrides) => {
    expect(ChatCompletionRequestSchema.safeParse({ ...followUp(), ...overrides }).success).toBe(false);
  });

  it('requires tool_call_id for tool results', () => {
    const request = followUp();
    delete request.messages[2].tool_call_id;
    const result = ChatCompletionRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['messages', 2, 'tool_call_id'] }),
      ]));
    }
  });

  it('requires content for non-tool-call assistant and user messages', () => {
    for (const role of ['user', 'assistant', 'tool']) {
      expect(ChatCompletionRequestSchema.safeParse({
        model: 'test', messages: [{ role, content: null, tool_call_id: 'call_1' }],
      }).success).toBe(false);
    }
  });

  it('validates function arguments as the original JSON string, not an object', () => {
    const request = followUp();
    (request.messages[1].tool_calls[0].function.arguments as unknown) = {};
    expect(ChatCompletionRequestSchema.safeParse(request).success).toBe(false);
  });

  it('accepts multiple consecutive tool rounds and preserves nested JSON Schema keywords', () => {
    const request = followUp(null);
    request.tools[0].function.parameters = {
      type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'], additionalProperties: false,
      $defs: { path: { type: 'string', pattern: '^/' } },
    } as typeof request.tools[0]['function']['parameters'];
    request.messages.push(
      { role: 'assistant', content: null, tool_calls: [{ ...toolCall, id: 'next_round' }], reasoning_content: '' },
      { role: 'tool', content: 'next result', tool_call_id: 'next_round' },
      { role: 'assistant', content: 'done' },
    );
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects empty messages and accepts exactly 512', () => {
    const message = { role: 'user', content: 'test' };
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: [] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: Array(512).fill(message) }).success).toBe(true);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'test', messages: Array(513).fill(message) }).success).toBe(false);
  });

  it('limits tools to 128 and validates function structure', () => {
    const tool = followUp().tools[0];
    const request = { model: 'test', messages: [{ role: 'user', content: 'test' }] };
    expect(ChatCompletionRequestSchema.safeParse({ ...request, tools: Array(128).fill(tool) }).success).toBe(true);
    expect(ChatCompletionRequestSchema.safeParse({ ...request, tools: Array(129).fill(tool) }).success).toBe(false);
    for (const invalid of [null, {}, { type: 'other' }, { type: 'function', function: {} },
      { type: 'function', function: { name: 'bad name' } },
      { type: 'function', function: { name: 'test', parameters: [] } },
      { type: 'function', function: { name: 'test', parameters: { type: 'string' } } },
      { type: 'function', function: { name: 'test', parameters: { properties: { name: 3 } } } },
      { type: 'function', function: { name: 'test', parameters: { required: 'name' } } },
    ]) {
      expect(ChatCompletionRequestSchema.safeParse({ ...request, tools: [invalid] }).success).toBe(false);
    }
  });

  it('accepts no-argument functions and strict functions with an object schema', () => {
    const request = { model: 'test', messages: [{ role: 'user', content: 'test' }], tools: [
      { type: 'function', function: { name: 'clock' } },
      { type: 'function', function: { name: 'ls', strict: true, parameters: { type: 'object', additionalProperties: false } } },
    ] };
    expect(ChatCompletionRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects orphan, forward, duplicate and obsolete tool results', () => {
    const request = followUp();
    request.messages[2].tool_call_id = 'unknown';
    expect(ChatCompletionRequestSchema.safeParse(request).success).toBe(false);
    const forward = followUp();
    [forward.messages[1], forward.messages[2]] = [forward.messages[2], forward.messages[1]];
    expect(ChatCompletionRequestSchema.safeParse(forward).success).toBe(false);
    const duplicate = followUp();
    duplicate.messages.push({ ...duplicate.messages[2] });
    expect(ChatCompletionRequestSchema.safeParse(duplicate).success).toBe(false);
    const obsolete = followUp();
    obsolete.messages.splice(2, 0, { role: 'assistant', content: 'new response' });
    expect(ChatCompletionRequestSchema.safeParse(obsolete).success).toBe(false);
  });

  it('rejects duplicate call IDs and tool calls on non-assistant messages', () => {
    const duplicate = followUp();
    duplicate.messages[1].tool_calls.push(structuredClone(toolCall));
    expect(ChatCompletionRequestSchema.safeParse(duplicate).success).toBe(false);
    const wrongRole = followUp();
    wrongRole.messages[1].role = 'user';
    expect(ChatCompletionRequestSchema.safeParse(wrongRole).success).toBe(false);
  });

  it('limits tool IDs, names, content, arguments and output integers', () => {
    const base = { model: 'test', messages: [{ role: 'user', content: 'test' }] };
    for (const max_tokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ChatCompletionRequestSchema.safeParse({ ...base, max_tokens }).success).toBe(false);
    }
    const longId = followUp();
    longId.messages[1].tool_calls[0].id = 'x'.repeat(129);
    expect(ChatCompletionRequestSchema.safeParse(longId).success).toBe(false);
    const longName = followUp();
    longName.tools[0].function.name = 'x'.repeat(65);
    expect(ChatCompletionRequestSchema.safeParse(longName).success).toBe(false);
    const longArguments = followUp();
    longArguments.messages[1].tool_calls[0].function.arguments = 'x'.repeat(1024 * 1024 + 1);
    expect(ChatCompletionRequestSchema.safeParse(longArguments).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] }).success).toBe(false);
  });

  it('bounds recursive schemas and rejects non-JSON extension values', () => {
    const request = followUp();
    let nested: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) nested = { type: 'object', properties: { child: nested } };
    request.tools[0].function.parameters = nested as typeof request.tools[0]['function']['parameters'];
    expect(ChatCompletionRequestSchema.safeParse(request).success).toBe(false);
    request.tools[0].function.parameters = { type: 'object', extension: () => null } as typeof request.tools[0]['function']['parameters'];
    expect(ChatCompletionRequestSchema.safeParse(request).success).toBe(false);
  });
});
