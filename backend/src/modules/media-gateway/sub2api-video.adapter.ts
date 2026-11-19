import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MediaUpstreamException, mediaFailure, mediaDispatchFailure, readMediaUpstreamError, protectMediaCredential } from '../../common/errors/media-upstream.exception';
import type { MediaUpstreamError } from 'shared';
import { MediaJsonValueSchema, MediaVideoUsdSchema, VIDEO_OUTPUT_FORMAT, VIDEO_REFERENCE_MAX_BYTES } from 'shared';
import { MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayQuoteRequestV3Schema,
  type MediaVideoGatewayQuoteRequest, type MediaVideoGatewayQuoteRequestV3 } from 'shared';
import { SettingService } from '../setting/setting.service';
import { inspectReferenceImage } from './media-reference-image';
import { errorMessage, sanitizeError, hasBusinessError } from '../../common/errors/error-diagnostics';
import { upstreamHeaders } from '../../common/errors/upstream-http.exception';

export interface Sub2apiVideoConnection { base: string; key: string; fingerprint: string }
const ModelIdSchema = z.string().min(1).max(160).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const TaskIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/).refine(id => id !== '.' && id !== '..');
const RequestIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/);
const VideoStatusSchema = z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled']);
const TaskSchema = z.object({
  object: z.literal('video'), id: TaskIdSchema, task_id: TaskIdSchema.optional(),
  model: ModelIdSchema, status: VideoStatusSchema, progress: z.number().finite().min(0).max(100).optional(),
  error: MediaJsonValueSchema.optional(),
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
  diagnostic: z.string().optional(),
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
  readonly upstreamError?: MediaUpstreamError;
  constructor(readonly requestId: string | null, readonly definitelyRejected: boolean,
    readonly specUnsupported = false, upstreamError?: MediaUpstreamError) {
    upstreamError = mediaDispatchFailure(upstreamError);
    super((upstreamError?.body ?? { error: {
      code: specUnsupported ? 'UPSTREAM_SPEC_UNSUPPORTED' : definitelyRejected ? 'UPSTREAM_FAILED' : 'SUBMISSION_UNKNOWN',
      message: specUnsupported ? '上游拒绝了请求规格，请查询原请求以确认账务状态' : '视频提交未完成，请查询原请求',
      ...(specUnsupported ? { source: 'upstream', stage: 'submit', reason: '上游明确报告规格参数不支持',
        retryable: false, submissionState: 'unknown', billingState: 'reconciling' } : {}),
    } }) as string | Record<string, unknown>, upstreamError?.status >= 400 ? upstreamError.status : 502);
    this.upstreamError = upstreamError;
  }
}
function unavailable(code = 'PRICE_UNAVAILABLE', diagnostic: unknown = 'Video upstream contract could not be verified'): never {
  const details = sanitizeError(diagnostic);
  throw new HttpException({ error: { code, message: errorMessage(details) ?? String(diagnostic), details, origin: 'sep' } }, 503);
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
    } catch (error) { if (error instanceof HttpException) throw error; unavailable('PRICE_UNAVAILABLE', error); }
  }

  async discover(connection: Sub2apiVideoConnection): Promise<Array<{ modelId: string; displayName: string }>> {
    const result = await this.json(connection, '/models', { method: 'GET' }, 'PRICE_UNAVAILABLE', 1024 * 1024);
    const parsed = z.object({ data: z.array(z.object({
      id: ModelIdSchema, display_name: z.string().trim().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(),
    })).max(2000) }).safeParse(result.value);
    if (!parsed.success) unavailable('PRICE_UNAVAILABLE', { message: 'Video model catalog validation failed', errors: parsed.error.issues });
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
    if (!parsed.success) unavailable('PRICE_UNAVAILABLE', { message: 'Video quote response validation failed', errors: parsed.error.issues });
    const price = parsed.data;
    const now = Date.now();
    if (price.model !== modelId || price.operation !== input.operation || price.resolution !== dimensions.resolution ||
      price.duration_seconds !== dimensions.durationSeconds || price.pricing_status !== 'quoted' || price.amount_usd === null ||
      /public|fallback|default|unknown/i.test(price.pricing_source) ||
      Date.parse(price.observed_at) > now + 5000 || Date.parse(price.expires_at) <= now ||
      Date.parse(price.expires_at) > now + 120_000 || Date.parse(price.expires_at) <= Date.parse(price.observed_at) ||
      Date.parse(price.expires_at) - Date.parse(price.observed_at) > 120_000) unavailable('PRICE_UNAVAILABLE', {
        message: price.diagnostic ?? 'Video quote is unavailable, expired or does not match the requested model/specification',
        quote: price, expected: { modelId, operation: input.operation, ...dimensions } });
    return price;
  }

  async usage(connection: Sub2apiVideoConnection, requestId: string): Promise<Sub2apiVideoUsage> {
    if (!RequestIdSchema.safeParse(requestId).success) unavailable('BILLING_PENDING');
    const result = await this.json(connection, `/sub2api/videos/usage?request_id=${encodeURIComponent(requestId)}`,
      { method: 'GET' }, 'BILLING_PENDING');
    const parsed = UsageSchema.safeParse(result.value);
    if (!parsed.success) unavailable('BILLING_PENDING', { message: 'Video usage response validation failed', errors: parsed.error.issues });
    const value = parsed.data;
    if (value.request_id !== requestId ||
      value.status === 'pending' && value.actual_cost_usd !== null ||
      value.status === 'settled' && (value.actual_cost_usd === null || value.model === null ||
        value.video_count === null || value.video_count < 1 || value.duration_seconds === null || value.resolution === null)) {
      unavailable('BILLING_PENDING', { message: 'Video usage evidence does not match the original request or settlement state', usage: value });
    }
    return value;
  }

  async submit(connection: Sub2apiVideoConnection, input: Sub2apiVideoInput, modelId: string,
    references: Buffer[], clientRequestId: string, pricingVersion: string): Promise<{ taskId: string; requestId: string; status: Sub2apiVideoTask['status']; error?: Sub2apiVideoTask['error'] }> {
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
      const form = new FormData();
      for (const [index, bytes] of references.entries()) {
        const { mimeType, extension } = await inspectReferenceImage(bytes, VIDEO_REFERENCE_MAX_BYTES);
        form.append('input_reference', new Blob([new Uint8Array(bytes)], { type: mimeType }), `reference-${index}.${extension}`);
      }
      for (const [name, value] of Object.entries(fields)) form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      body = form;
    }
    // Idempotency-Key is correlation only, not proof that a supplier deduplicates POSTs.
    const result = await this.json(connection, '/videos', { method: 'POST', body, headers }, 'UPSTREAM_FAILED', 64 * 1024,
      true, 'protocolVersion' in input);
    const task = TaskSchema.safeParse(result.value);
    if (!task.success || !result.requestId || task.data.model !== modelId ||
      task.data.task_id !== undefined && task.data.task_id !== task.data.id) throw new VideoDispatchError(result.requestId, false, false,
        { status: 502, body: { error: { message: 'Video submission response has an invalid task identity, model or request ID',
          origin: 'sep', stage: 'submit-validation', details: task.success ? sanitizeError(task.data) : sanitizeError(task.error.issues) } } });
    return { taskId: task.data.id, requestId: result.requestId, status: task.data.status,
      ...(task.data.error !== undefined ? { error: protectMediaCredential({ status: 200, body: task.data.error }, connection.key).body } : {}) };
  }

  async query(connection: Sub2apiVideoConnection, taskId: string, modelId: string): Promise<Sub2apiVideoTask> {
    if (!TaskIdSchema.safeParse(taskId).success || !ModelIdSchema.safeParse(modelId).success) unavailable('UPSTREAM_FAILED');
    const result = await this.json(connection, `/videos/${encodeURIComponent(taskId)}`, { method: 'GET' }, 'UPSTREAM_FAILED');
    const task = TaskSchema.safeParse(result.value);
    if (!task.success || task.data.id !== taskId || task.data.model !== modelId ||
      task.data.task_id !== undefined && task.data.task_id !== taskId) unavailable('UPSTREAM_FAILED', {
        message: 'Video query response does not match the original task/model or task schema',
        details: task.success ? task.data : task.error.issues });
    return task.data.error === undefined ? task.data : { ...task.data,
      error: protectMediaCredential({ status: 200, body: task.data.error }, connection.key).body };
  }

  /** Caller owns cancellation and file validation. Enforce the byte cap even without Content-Length. */
  async rawContent(connection: Sub2apiVideoConnection, taskId: string, outputFormat: string = VIDEO_OUTPUT_FORMAT): Promise<Response> {
    if (!TaskIdSchema.safeParse(taskId).success) unavailable('OUTPUT_FAILED');
    if (outputFormat !== VIDEO_OUTPUT_FORMAT) unavailable('ADAPTER_FIELD_UNMAPPED');
    let response: Response;
    try {
      response = await this.fetch(connection, `/videos/${encodeURIComponent(taskId)}/content`, { method: 'GET',
        headers: { Accept: `${outputFormat}, application/octet-stream` } }, 180_000);
      if (!response.ok) throw new MediaUpstreamException(protectMediaCredential(await readMediaUpstreamError(response), connection.key));
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const rawLength = response.headers.get('content-length');
      if (response.status !== 200 || !response.body || ![outputFormat, 'application/octet-stream'].includes(mime) ||
        rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)) ||
          Number(rawLength) < 1 || Number(rawLength) > MAX_CONTENT_BYTES)) throw new Error('Invalid upstream video content type or length');
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof MediaUpstreamException) throw error;
      throw new MediaUpstreamException(protectMediaCredential(mediaFailure(error), connection.key));
    }
    const reader = response.body.getReader();
    const expectedLength = response.headers.get('content-length');
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            if (!bytes || expectedLength !== null && bytes !== Number(expectedLength)) throw new Error('Upstream video content length mismatch');
            reader.releaseLock(); controller.close(); return;
          }
          bytes += part.value.byteLength;
          if (bytes > MAX_CONTENT_BYTES || expectedLength !== null && bytes > Number(expectedLength)) throw new Error('Upstream video content exceeds byte limit');
          controller.enqueue(part.value);
        } catch (error) {
          await reader.cancel().catch(() => {}); reader.releaseLock();
          controller.error(new MediaUpstreamException(protectMediaCredential(mediaFailure(error), connection.key)));
        }
      },
      async cancel() {
        try { await reader.cancel(); }
        catch (error) { throw new MediaUpstreamException(protectMediaCredential(mediaFailure(error), connection.key)); }
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
    if (spec.outputFormat !== undefined && spec.outputFormat !== VIDEO_OUTPUT_FORMAT) {
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
      connection.fingerprint !== fingerprint(connection.base, connection.key)) throw new Error('Invalid frozen media connection');
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
      if (!response.ok) {
        const upstreamError = protectMediaCredential(await readMediaUpstreamError(response), connection.key);
        const rejected = z.object({ error: z.object({ code: z.string() }) }).safeParse(upstreamError.body);
        const originalCode = rejected.success ? rejected.data.error.code : undefined;
        // sub2api passes supplier HTTP errors through, so status alone cannot prove
        // that a POST was rejected before provider execution. Keep billing reserved
        // for reconciliation until the gateway exposes a provenance marker.
        if (dispatch) throw new VideoDispatchError(requestId,
          rejectedBeforeDispatch && originalCode === 'video_pricing_changed',
          specificationRejection && ['unsupported_spec', 'unsupported_parameter', 'unsupported_resolution', 'unsupported_duration'].includes(originalCode ?? ''), upstreamError);
        throw new MediaUpstreamException(upstreamError);
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) throw new Error('Upstream response must contain a JSON body');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error(`Invalid upstream response length (limit ${maxBytes} bytes)`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > maxBytes) throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (hasBusinessError(value) && !(value?.object === 'video' && ['failed', 'cancelled'].includes(value.status))) {
        const failure = protectMediaCredential({ status: response.status, body: value, headers: upstreamHeaders(response) }, connection.key);
        if (dispatch) throw new VideoDispatchError(requestId, false, false, failure);
        throw new MediaUpstreamException(failure);
      }
      return { value, requestId };
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      const failure = protectMediaCredential(mediaFailure(error), connection.key);
      if (dispatch) throw error instanceof VideoDispatchError ? error : new VideoDispatchError(requestId, false, false, failure);
      if (error instanceof HttpException) throw error;
      throw new MediaUpstreamException(failure);
    }
  }
}
