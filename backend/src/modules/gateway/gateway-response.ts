import { BadGatewayException } from '@nestjs/common';
import type { ChatCompletionUsage } from 'shared';
import { sanitizeError } from '../../common/errors/error-diagnostics';

export function gatewayUpstreamError(code: string, message: string, diagnostic?: unknown) {
  return new BadGatewayException({
    error: { code, message, type: 'api_error', source: 'upstream', param: null,
      ...(diagnostic !== undefined ? { diagnostic: sanitizeError(diagnostic) } : {}) },
  });
}

/** PostgreSQL token columns are signed Ints; never persist unchecked provider data. */
export function validGatewayUsage(value: unknown): ChatCompletionUsage | null {
  if (!value || typeof value !== 'object') return null;
  const { prompt_tokens: input, completion_tokens: output } = value as ChatCompletionUsage;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)) return null;
  const total = input + output;
  if (!Number.isSafeInteger(total)) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Accept ordinary assistant results and tool turns, but never incomplete choices. */
export function validGatewayCompletion(value: unknown): boolean {
  if (!isRecord(value) || value.error || !Array.isArray(value.choices) || !value.choices.length) return false;
  return value.choices.every((choice: unknown) => {
    if (!isRecord(choice) || typeof choice.finish_reason !== 'string' || !choice.finish_reason.trim()) return false;
    const message = choice.message;
    if (!isRecord(message) || message.role !== 'assistant') return false;
    const calls = message.tool_calls;
    const validTools = Array.isArray(calls) && calls.length > 0 && calls.every((call: unknown) =>
      isRecord(call) && typeof call.id === 'string' && !!call.id && call.type === 'function' &&
      isRecord(call.function) && typeof call.function.name === 'string' && !!call.function.name &&
      typeof call.function.arguments === 'string');
    if (calls != null && !(Array.isArray(calls) && (calls.length === 0 || validTools))) return false;
    if (choice.finish_reason === 'tool_calls' && !validTools) return false;
    return typeof message.content === 'string' ||
      (message.content == null && (validTools || typeof message.refusal === 'string' || choice.finish_reason === 'content_filter'));
  });
}

export async function readGatewayJson(response: Response, maxBytes: number, secrets: readonly string[] = []): Promise<unknown> {
  if (!response.body) throw gatewayUpstreamError('UPSTREAM_INVALID_JSON', 'sub2api 响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw gatewayUpstreamError('UPSTREAM_RESPONSE_TOO_LARGE', 'sub2api 响应超过平台大小限制');
      chunks.push(value);
    }
    const data = Buffer.concat(chunks, length).toString('utf8');
    try { return JSON.parse(data); }
    catch (error) { throw gatewayUpstreamError('UPSTREAM_INVALID_JSON', 'sub2api 返回了无效 JSON',
      sanitizeError({ cause: error, body: data, upstreamStatus: response.status }, secrets)); }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof BadGatewayException) throw error;
    throw gatewayUpstreamError('UPSTREAM_BODY_ERROR', 'sub2api 响应读取失败',
      sanitizeError({ cause: error, body: Buffer.concat(chunks).toString('utf8'), upstreamStatus: response.status }, secrets));
  } finally {
    reader.releaseLock();
  }
}
