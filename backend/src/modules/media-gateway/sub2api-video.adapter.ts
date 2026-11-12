import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MediaVideoUsdSchema } from 'shared';
import { MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayQuoteRequestV3Schema,
  type MediaVideoGatewayQuoteRequest, type MediaVideoGatewayQuoteRequestV3 } from 'shared';
import { SettingService } from '../setting/setting.service';
import { inspectMediaPng } from './media-png';

export interface Sub2apiVideoConnection { base: string; key: string; fingerprint: string }
const ModelIdSchema = z.string().min(1).max(160).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const TaskIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/).refine(id => id !== '.' && id !== '..');
const RequestIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/);
const VideoStatusSchema = z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled']);
const TaskSchema = z.object({
  object: z.literal('video'), id: TaskIdSchema, task_id: TaskIdSchema.optional(),
  model: ModelIdSchema, status: VideoStatusSchema, progress: z.number().finite().min(0).max(100).optional(),
});
const PricingSchema = z.object({
  object: z.literal('sub2api.video_pricing'), schema_version: z.literal(1), currency: z.literal('USD'),
  model: ModelIdSchema, operation: z.enum(['text-to-video', 'image-to-video']),
  resolution: z.string().min(1).max(128), duration_seconds: z.number().int().positive().safe(),
  billing_mode: z.enum(['video', 'per_request']), pricing_status: z.enum(['quoted', 'unavailable']),
  pricing_source: z.string().trim().min(1).max(128), pricing_authority: z.literal('sub2api_customer_billing'),
  amount_usd: MediaVideoUsdSchema.nullable(), pricing_version: z.string().min(1).max(128),
  effective_rate_multiplier: z.number().finite().nonnegative(),
  observed_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
}).strict();
export type Sub2apiVideoPrice = z.infer<typeof PricingSchema>;
const UsageSchema = z.object({
  object: z.literal('sub2api.video_request_usage'), schema_version: z.literal(1), currency: z.literal('USD'),
  request_id: RequestIdSchema, status: z.enum(['settled', 'pending']), model: ModelIdSchema.nullable(),
  actual_cost_usd: MediaVideoUsdSchema.nullable(), video_count: z.number().int().nonnegative().nullable(),
  duration_seconds: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).nullable(), resolution: z.string().min(1).max(128).nullable(),
}).strict();
export type Sub2apiVideoUsage = z.infer<typeof UsageSchema>;
export type Sub2apiVideoTask = z.infer<typeof TaskSchema>;
export type Sub2apiVideoInput = MediaVideoGatewayQuoteRequest | MediaVideoGatewayQuoteRequestV3;

export class VideoDispatchError extends HttpException {
  constructor(readonly requestId: string | null, readonly definitelyRejected: boolean,
    readonly specUnsupported = false) {
    super({ error: {
      code: specUnsupported ? 'UPSTREAM_SPEC_UNSUPPORTED' : definitelyRejected ? 'UPSTREAM_FAILED' : 'SUBMISSION_UNKNOWN',
      message: specUnsupported ? '上游拒绝了请求规格，请查询原请求以确认账务状态' : '视频提交未完成，请查询原请求',
      ...(specUnsupported ? { source: 'upstream', stage: 'submit', reason: '上游明确报告规格参数不支持',
        retryable: false, submissionState: 'unknown', billingState: 'reconciling' } : {}),
    } }, 502);
  }
}
function unavailable(code = 'PRICE_UNAVAILABLE'): never {
  throw new HttpException({ error: { code, message: '视频上游合同暂不可核验' } }, 503);
}
function specError(code: 'MISSING_SPEC' | 'ADAPTER_FIELD_UNMAPPED', field: string, reason: string,
  stage: 'quote' | 'submit'): never {
  const message = code === 'MISSING_SPEC' ? '视频报价缺少必要规格' : '当前适配器无法传递请求规格';
  throw new HttpException({ message, error: { code, message, field, reason, source: 'adapter', stage,
    retryable: false, submissionState: 'not_submitted', billingState: 'not_reserved' } }, 422);
}
const fingerprint = (base: string, key: string) => createHash('sha256').update(base + '\0' + key).digest('hex');
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;

@Injectable()
export class Sub2apiVideoAdapter {
  constructor(private readonly settings: SettingService) {}

  async connection(): Promise<Sub2apiVideoConnection> {
    try {
      const { baseUrl, apiKey: key } = await this.settings.getMediaConnection('video');
      let base = baseUrl;
      const url = new URL(base ?? '');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !key?.trim() || /[^\x21-\x7e]/.test(key)) unavailable();
      base = url.href.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
      return { base, key, fingerprint: fingerprint(base, key) };
    } catch { unavailable(); }
  }

  async discover(connection: Sub2apiVideoConnection): Promise<Array<{ modelId: string; displayName: string }>> {
    const result = await this.json(connection, '/models', { method: 'GET' }, 'PRICE_UNAVAILABLE', 1024 * 1024);
    const parsed = z.object({ data: z.array(z.object({
      id: ModelIdSchema, display_name: z.string().trim().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(),
    })).max(2000) }).safeParse(result.value);
    if (!parsed.success) unavailable();
    const models = new Map<string, { modelId: string; displayName: string }>();
    for (const model of parsed.data.data) if (!models.has(model.id)) {
      models.set(model.id, { modelId: model.id, displayName: (model.display_name ?? model.id).slice(0, 80) });
    }
    // Catalog presence alone never enables generation or changes the requested model.
    return [...models.values()].sort((a, b) => a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
  }

  async pricing(connection: Sub2apiVideoConnection, input: Sub2apiVideoInput, modelId: string): Promise<Sub2apiVideoPrice> {
    const dimensions = this.pricingDimensions(input, modelId, 'quote');
    const result = await this.json(connection, '/sub2api/videos/pricing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, operation: input.operation,
        resolution: dimensions.resolution, duration_seconds: dimensions.durationSeconds }),
    });
    const parsed = PricingSchema.safeParse(result.value);
    if (!parsed.success) unavailable();
    const price = parsed.data;
    const now = Date.now();
    if (price.model !== modelId || price.operation !== input.operation || price.resolution !== dimensions.resolution ||
      price.duration_seconds !== dimensions.durationSeconds || price.pricing_status !== 'quoted' || price.amount_usd === null ||
      /public|fallback|default|unknown/i.test(price.pricing_source) ||
      Date.parse(price.observed_at) > now + 5000 || Date.parse(price.expires_at) <= now ||
      Date.parse(price.expires_at) > now + 120_000 || Date.parse(price.expires_at) <= Date.parse(price.observed_at) ||
      Date.parse(price.expires_at) - Date.parse(price.observed_at) > 120_000) unavailable();
    return price;
  }

  async usage(connection: Sub2apiVideoConnection, requestId: string): Promise<Sub2apiVideoUsage> {
    if (!RequestIdSchema.safeParse(requestId).success) unavailable('BILLING_PENDING');
    const result = await this.json(connection, `/sub2api/videos/usage?request_id=${encodeURIComponent(requestId)}`,
      { method: 'GET' }, 'BILLING_PENDING');
    const parsed = UsageSchema.safeParse(result.value);
    if (!parsed.success) unavailable('BILLING_PENDING');
    const value = parsed.data;
    if (value.request_id !== requestId ||
      value.status === 'pending' && value.actual_cost_usd !== null ||
      value.status === 'settled' && (value.actual_cost_usd === null || value.model === null ||
        value.video_count === null || value.video_count < 1 || value.duration_seconds === null || value.resolution === null)) {
      unavailable('BILLING_PENDING');
    }
    return value;
  }

  async submit(connection: Sub2apiVideoConnection, input: Sub2apiVideoInput, modelId: string,
    references: Buffer[], clientRequestId: string, pricingVersion: string): Promise<{ taskId: string; requestId: string; status: Sub2apiVideoTask['status'] }> {
    this.assertInput(input, modelId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(clientRequestId)) unavailable('INVALID_REQUEST');
    if (references.length !== input.referenceIds.length) unavailable('INVALID_REFERENCE');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(pricingVersion ?? '')) unavailable('PRICE_UNAVAILABLE');
    const fields = this.submitFields(input, modelId);
    let body: BodyInit;
    const headers: Record<string, string> = { 'X-Client-Request-ID': clientRequestId, 'Idempotency-Key': clientRequestId,
      'X-Video-Pricing-Version': pricingVersion, 'X-Video-Operation': input.operation };
    if (input.operation === 'text-to-video') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fields);
    } else {
      try { inspectMediaPng(references[0], 10 * 1024 * 1024); }
      catch { unavailable('INVALID_REFERENCE'); }
      const form = new FormData();
      form.append('input_reference', new Blob([new Uint8Array(references[0])], { type: 'image/png' }), 'reference.png');
      for (const [name, value] of Object.entries(fields)) form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      body = form;
    }
    // Idempotency-Key is correlation only, not proof that a supplier deduplicates POSTs.
    const result = await this.json(connection, '/videos', { method: 'POST', body, headers }, 'UPSTREAM_FAILED', 64 * 1024,
      true, 'protocolVersion' in input);
    const task = TaskSchema.safeParse(result.value);
    if (!task.success || !result.requestId || task.data.model !== modelId ||
      task.data.task_id !== undefined && task.data.task_id !== task.data.id) throw new VideoDispatchError(result.requestId, false);
    return { taskId: task.data.id, requestId: result.requestId, status: task.data.status };
  }

  async query(connection: Sub2apiVideoConnection, taskId: string, modelId: string): Promise<Sub2apiVideoTask> {
    if (!TaskIdSchema.safeParse(taskId).success || !ModelIdSchema.safeParse(modelId).success) unavailable('UPSTREAM_FAILED');
    const result = await this.json(connection, `/videos/${encodeURIComponent(taskId)}`, { method: 'GET' }, 'UPSTREAM_FAILED');
    const task = TaskSchema.safeParse(result.value);
    if (!task.success || task.data.id !== taskId || task.data.model !== modelId ||
      task.data.task_id !== undefined && task.data.task_id !== taskId) unavailable('UPSTREAM_FAILED');
    return task.data;
  }

  /** Caller owns cancellation and file validation. Enforce the byte cap even without Content-Length. */
  async rawContent(connection: Sub2apiVideoConnection, taskId: string, outputFormat = 'video/mp4'): Promise<Response> {
    if (!TaskIdSchema.safeParse(taskId).success) unavailable('OUTPUT_FAILED');
    if (outputFormat !== 'video/mp4') unavailable('ADAPTER_FIELD_UNMAPPED');
    let response: Response;
    try {
      response = await this.fetch(connection, `/videos/${encodeURIComponent(taskId)}/content`, { method: 'GET',
        headers: { Accept: `${outputFormat}, application/octet-stream` } }, 180_000);
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const rawLength = response.headers.get('content-length');
      if (response.status !== 200 || !response.body || ![outputFormat, 'application/octet-stream'].includes(mime) ||
        rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)) ||
          Number(rawLength) < 1 || Number(rawLength) > MAX_CONTENT_BYTES)) throw new Error();
    } catch {
      await response?.body?.cancel().catch(() => {});
      unavailable('OUTPUT_FAILED');
    }
    const reader = response.body.getReader();
    const expectedLength = response.headers.get('content-length');
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            if (!bytes || expectedLength !== null && bytes !== Number(expectedLength)) throw new Error();
            reader.releaseLock(); controller.close(); return;
          }
          bytes += part.value.byteLength;
          if (bytes > MAX_CONTENT_BYTES || expectedLength !== null && bytes > Number(expectedLength)) throw new Error();
          controller.enqueue(part.value);
        } catch {
          await reader.cancel().catch(() => {}); reader.releaseLock();
          controller.error(new HttpException({ error: { code: 'OUTPUT_FAILED', message: '视频下载未完成' } }, 502));
        }
      },
      async cancel() {
        try { await reader.cancel(); }
        catch { throw new HttpException({ error: { code: 'OUTPUT_FAILED', message: '视频下载未完成' } }, 502); }
        finally { reader.releaseLock(); }
      },
    });
    const headers = new Headers({ 'Content-Type': response.headers.get('content-type').split(';')[0].trim().toLowerCase() });
    if (expectedLength !== null) headers.set('Content-Length', expectedLength);
    return new Response(stream, { headers });
  }

  private assertInput(input: Sub2apiVideoInput, modelId: string): void {
    if (!ModelIdSchema.safeParse(modelId).success) unavailable('ADAPTER_UNAVAILABLE');
    if ('protocolVersion' in input) {
      if (!MediaVideoGatewayQuoteRequestV3Schema.safeParse(input).success) unavailable('INVALID_PARAMETER');
      this.pricingDimensions(input, modelId, 'submit');
      return;
    }
    const parsed = MediaVideoGatewayQuoteRequestSchema.safeParse(input);
    if (!parsed.success || modelId !== 'minimax-h3') unavailable('UNSUPPORTED_VIDEO_SPEC');
    const parameters = parsed.data.parameters;
    if (parameters.durationSeconds !== 4 || parameters.resolution !== '720p' || parameters.aspectRatio !== '16:9' ||
      parameters.audio !== true || parameters.frameRate !== 24 || parameters.outputFormat !== 'video/mp4') unavailable('UNSUPPORTED_VIDEO_SPEC');
  }

  private pricingDimensions(input: Sub2apiVideoInput, modelId: string, stage: 'quote' | 'submit' = 'submit'): { durationSeconds: number; resolution: string } {
    this.assertModel(modelId);
    if (!('protocolVersion' in input)) {
      this.assertInput(input, modelId);
      const parameters = (input as MediaVideoGatewayQuoteRequest).parameters;
      return { durationSeconds: parameters.durationSeconds, resolution: parameters.resolution };
    }
    const spec = input.requestedSpec;
    if (spec.outputFormat !== undefined && spec.outputFormat !== 'video/mp4') {
      specError('ADAPTER_FIELD_UNMAPPED', 'requestedSpec.outputFormat', '当前视频下载与文件校验适配器仅实现 video/mp4', stage);
    }
    if (spec.durationSeconds === undefined) specError('MISSING_SPEC', 'requestedSpec.durationSeconds', '上游报价合同需要明确时长', stage);
    const resolution = spec.resolution ?? (spec.width !== undefined && spec.height !== undefined ? `${spec.width}x${spec.height}` : undefined);
    if (!resolution) specError('MISSING_SPEC', 'requestedSpec.resolution', '上游报价合同需要 resolution 或完整 width/height', stage);
    return { durationSeconds: spec.durationSeconds, resolution };
  }

  private submitFields(input: Sub2apiVideoInput, modelId: string): Record<string, unknown> {
    if (!('protocolVersion' in input)) return { model: modelId, prompt: input.creativeBrief, seconds: 4, size: '1280x720',
      resolution: '720p', generate_audio: true, metadata: { resolution: '768P', ratio: '16:9' } };
    const dimensions = this.pricingDimensions(input, modelId);
    const spec = input.requestedSpec;
    const fields: Record<string, unknown> = { model: modelId, prompt: input.creativeBrief,
      seconds: dimensions.durationSeconds, resolution: dimensions.resolution };
    if (spec.width !== undefined && spec.height !== undefined) fields.size = `${spec.width}x${spec.height}`;
    if (spec.aspectRatio !== undefined) fields.aspect_ratio = spec.aspectRatio;
    // sub2api does not support selecting fps; retain it only in the original request.
    if (spec.audio !== undefined) fields.generate_audio = spec.audio;
    if (spec.outputFormat !== undefined) fields.output_format = spec.outputFormat;
    return fields;
  }

  private assertModel(modelId: string): void {
    if (!ModelIdSchema.safeParse(modelId).success) unavailable('ADAPTER_UNAVAILABLE');
  }

  private async fetch(connection: Sub2apiVideoConnection, path: string, options: RequestInit, timeout = 15_000): Promise<Response> {
    const url = new URL(connection.base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/v1') || !connection.key || /[^\x21-\x7e]/.test(connection.key) ||
      connection.fingerprint !== fingerprint(connection.base, connection.key)) throw new Error();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${connection.key}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    return fetch(connection.base + path, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  }

  private async json(connection: Sub2apiVideoConnection, path: string, options: RequestInit,
    code = 'PRICE_UNAVAILABLE', maxBytes = 64 * 1024, dispatch = false, v3Dispatch = false): Promise<{ value: unknown; requestId: string | null }> {
    let requestId: string | null = null;
    let response: Response;
    try {
      response = await this.fetch(connection, path, options, dispatch ? 180_000 : 15_000);
      // The middleware creates its own correlation ID; the supplier's X-Request-ID is unrelated.
      const clientId = response.headers.get('x-client-request-id');
      if (clientId && RequestIdSchema.safeParse(`client:${clientId}`).success) requestId = `client:${clientId}`;
      const rejectedBeforeDispatch = dispatch && response.status === 409 && response.headers.get('x-video-dispatch') === 'rejected';
      const specificationRejection = dispatch && v3Dispatch && [400, 422].includes(response.status);
      if (!response.ok && !rejectedBeforeDispatch && !specificationRejection) {
        // sub2api passes supplier HTTP errors through, so status alone cannot prove
        // that a POST was rejected before provider execution. Keep billing reserved
        // for reconciliation until the gateway exposes a provenance marker.
        if (dispatch) throw new VideoDispatchError(requestId, false);
        unavailable(code);
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) throw new Error();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error();
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > maxBytes) throw new Error();
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (specificationRejection) {
        const rejected = z.object({ error: z.object({ code: z.enum([
          'unsupported_spec', 'unsupported_parameter', 'unsupported_resolution', 'unsupported_duration',
        ]) }) }).safeParse(value);
        throw new VideoDispatchError(requestId, false, rejected.success);
      }
      if (rejectedBeforeDispatch) {
        const rejected = z.object({ error: z.object({ code: z.literal('video_pricing_changed') }) }).safeParse(value);
        throw new VideoDispatchError(requestId, rejected.success);
      }
      return { value, requestId };
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (dispatch) throw error instanceof VideoDispatchError ? error : new VideoDispatchError(requestId, false);
      unavailable(code);
    }
  }
}
