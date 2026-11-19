import { StringDecoder } from 'node:string_decoder';
import { BadGatewayException } from '@nestjs/common';
import { hasBusinessError, sanitizeError, redactErrorText } from './error-diagnostics';

/** Successful SSE frames are unchanged; only failure payloads pass through redaction. */
export function createSseErrorDiagnostics(secrets: readonly string[] = []) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let diagnostic: unknown;
  function frame(raw: string): Buffer {
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new BadGatewayException({
      message: 'Upstream SSE event exceeds 8 MiB', code: 'UPSTREAM_EVENT_TOO_LARGE', origin: 'sep' });
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    let value: unknown;
    try { value = JSON.parse(data); } catch { /* Non-JSON frames may be vendor error events. */ }
    if (!hasBusinessError(value) && !/^event:\s*(?:error|response\.failed|response\.error)\s*$/m.test(raw)) return Buffer.from(raw);
    const failure = sanitizeError(value ?? data, secrets);
    diagnostic = failure;
    const metadata = lines.filter(line => line && !line.startsWith('data:')).map(line => redactErrorText(line, secrets)).join('\n');
    return Buffer.from(metadata + '\ndata: ' + JSON.stringify(failure) + '\n\n');
  }
  function parse(final: boolean): Buffer[] {
    const result: Buffer[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      const end = match.index + match[0].length;
      result.push(frame(buffer.slice(0, end)));
      buffer = buffer.slice(end);
    }
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new BadGatewayException({
      message: 'Upstream SSE event exceeds 8 MiB', code: 'UPSTREAM_EVENT_TOO_LARGE', origin: 'sep' });
    if (final && buffer) { result.push(frame(buffer)); buffer = ''; }
    return result;
  }
  return {
    write(chunk: Uint8Array): Buffer[] { buffer += decoder.write(Buffer.from(chunk)); return parse(false); },
    finish(): Buffer[] { buffer += decoder.end(); return parse(true); },
    error(): unknown { return diagnostic; },
  };
}
