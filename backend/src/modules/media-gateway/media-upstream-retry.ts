import { z } from 'zod';
import type { MediaExecutionEvidence } from 'shared';

export const MediaUpstreamWaitSchema = z.object({
  value: z.string(), notBefore: z.number().finite().nonnegative().nullable(),
}).strict();
type WaitConfiguration = { upstreamWait?: z.infer<typeof MediaUpstreamWaitSchema> };
const responseWaits = new WeakMap<object, string>();

export function updateMediaWait(configuration: unknown, headers: Record<string, string>, now = Date.now()): void {
  const state = configuration as WaitConfiguration;
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (value === undefined) { delete state.upstreamWait; return; }
  const text = value.trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : undefined;
  const date = /^[A-Za-z]{3}, /.test(text) ? Date.parse(text) : NaN;
  const notBefore = delay !== undefined && Number.isSafeInteger(delay) && Number.isSafeInteger(now + delay)
    ? now + delay : Number.isFinite(date) && date >= 0 ? date : null;
  state.upstreamWait = { value, notBefore };
}

export function mediaPollAfter(configuration: unknown, fallback: number): number {
  return Math.max(fallback, ((configuration as WaitConfiguration).upstreamWait?.notBefore ?? 0) - Date.now());
}

/** Response-only metadata keeps transport headers out of the client JSON schema. */
export function withMediaWait<T extends object>(receipt: T, configuration: unknown): T {
  const wait = (configuration as WaitConfiguration).upstreamWait;
  if (wait) responseWaits.set(receipt, wait.value);
  return receipt;
}

export function mediaResponseWait(receipt: object): string | undefined { return responseWaits.get(receipt); }

export function hasFailedMediaQuery(receipt: { execution?: MediaExecutionEvidence }): boolean {
  return receipt.execution?.operation === 'query' && receipt.execution.operationError?.status >= 400;
}
