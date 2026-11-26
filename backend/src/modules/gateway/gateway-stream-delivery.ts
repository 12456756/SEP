import { createSseErrorDiagnostics } from '../../common/errors/sse-error-diagnostics';

/** Reuse bounded SSE framing and retain only the success marker until validation completes. */
export function createGatewayStreamDelivery() {
  const frames = createSseErrorDiagnostics();
  let terminal: Buffer | undefined;
  function retainTerminal(values: Buffer[]) {
    return values.filter(frame => {
      const data = frame.toString('utf8').split(/\r\n|\r|\n/)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data.trim() !== '[DONE]') return true;
      terminal ??= frame;
      return false;
    });
  }
  return {
    write(chunk: Uint8Array) { return retainTerminal(frames.write(chunk)); },
    finish() { return retainTerminal(frames.finish()); },
    complete() { const frame = terminal; terminal = undefined; return frame; },
  };
}
