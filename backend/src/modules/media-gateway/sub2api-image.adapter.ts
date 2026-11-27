import { HttpException, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MediaImageSpecV3, MediaRealAnyQuoteRequest, MediaRealQuoteRequestV3 } from 'shared';
import { IMAGE_ADAPTER_MAX_OUTPUTS, IMAGE_REFERENCE_MAX_BYTES } from 'shared';
import { SettingService } from '../setting/setting.service';
import { isSupportedImageModel } from './image-model-contract';
import { inspectMediaPng } from './media-png';
import { inspectReferenceImage } from './media-reference-image';
import { MediaUpstreamException, mediaFailure, mediaDispatchFailure, readMediaUpstreamError, protectMediaCredential } from '../../common/errors/media-upstream.exception';
import type { MediaUpstreamError } from 'shared';
import { errorMessage, hasBusinessError, sanitizeError } from '../../common/errors/error-diagnostics';
import { upstreamHeaders } from '../../common/errors/upstream-http.exception';
import { IMAGE_CREATE_TIMEOUT_MS, LongdaoReceiptMetadataFields, readLongdaoMedia } from './longdao-media-contract';
import { ComputeProtocolClient } from '../compute-integration/compute-protocol.client';
import type { ComputeMediaIdentity } from '../compute-integration/compute-media.service';

const ModelIdSchema = z.string().min(1).max(160).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);
const ModelsSchema = z.object({
  data: z.array(z.object({
    id: ModelIdSchema,
    display_name: z.string().trim().min(1).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(),
  })).max(2000),
});
const PricingSchema = z.object({
  ...LongdaoReceiptMetadataFields,
  object: z.literal('sub2api.image_pricing'), schema_version: z.union([z.literal(1), z.literal(2)]), currency: z.literal('CNY'),
  model: ModelIdSchema, operation: z.enum(['generate', 'edit']), size: z.string(), n: z.number().int(),
  quality: z.string().min(1).max(128), billing_mode: z.enum(['image', 'per_request', 'token']),
  pricing_status: z.enum(['quoted', 'unavailable']), pricing_source: z.string().min(1),
  pricing_authority: z.literal('sub2api_customer_billing').optional(),
  amount_usd: z.unknown().optional().transform(() => null), pricing_version: z.string().max(128),
  quote_scope: z.literal('platform_validation').optional(),
  contract_version: z.literal(1).optional(), enterprise_id: z.string().optional(), exchange_rate: z.string().optional(),
  amount_cny: z.string().regex(/^\d+\.[0-9]{6}$/).nullable().optional(), quote_id: z.string().min(1).max(128).optional(),
  effective_rate_multiplier: z.number().finite().nonnegative(),
  observed_at: z.string().datetime({ offset: true }), expires_at: z.string().datetime({ offset: true }),
});
export type Sub2apiImagePrice = z.infer<typeof PricingSchema>;
const UsageSchema = z.object({
  ...LongdaoReceiptMetadataFields,
  object: z.literal('sub2api.request_usage'), schema_version: z.union([z.literal(1), z.literal(2)]), currency: z.literal('USD'),
  request_id: z.string().min(1).max(256), status: z.enum(['settled', 'pending', 'not_charged', 'unknown']),
  model: ModelIdSchema.nullable().optional(), actual_cost_usd: z.string().regex(/^\d+(?:\.\d{1,12})?$/).nullable(),
  image_count: z.number().int().nonnegative().nullable().optional(),
});
export type Sub2apiImageUsage = z.infer<typeof UsageSchema>;
export interface Sub2apiImageConnection { base: string; key: string; compute?: ComputeMediaIdentity }
export const SUB2API_IMAGE_ADAPTER_VERSION = 'sub2api-image-async-v1';
export class ImageDispatchError extends HttpException {
  readonly upstreamError?: MediaUpstreamError;
  constructor(readonly requestId: string | null, readonly definitelyRejected: boolean,
    readonly safeCode: 'UPSTREAM_FAILED' | 'UPSTREAM_SPEC_UNSUPPORTED' = 'UPSTREAM_FAILED',
    upstreamError?: MediaUpstreamError) {
    upstreamError = mediaDispatchFailure(upstreamError);
    super((upstreamError?.body ?? { error: { code: safeCode === 'UPSTREAM_SPEC_UNSUPPORTED' ? safeCode : definitelyRejected ? safeCode : 'SUBMISSION_UNKNOWN',
      message: '图片上游执行未完成，请查询原请求' } }) as string | Record<string, unknown>, upstreamError?.status >= 400 ? upstreamError.status : 502);
    this.upstreamError = upstreamError;
  }
}
function unavailable(code = 'PRICE_UNAVAILABLE', diagnostic: unknown = 'Image upstream contract could not be verified'): never {
  const details = sanitizeError(diagnostic);
  throw new HttpException({ error: { code, message: errorMessage(details) ?? String(diagnostic), details, origin: 'sep' } }, 503);
}
export function resolveSub2apiImageSpec(input: MediaRealAnyQuoteRequest, stage: 'quote' | 'submit'): MediaImageSpecV3 & { size: string; count: number; quality: string } {
  if ('parameters' in input) return input.parameters as MediaImageSpecV3 & { size: string; count: number; quality: string };
  const requested = (input as MediaRealQuoteRequestV3).requestedSpec;
  const reject = (code: 'MISSING_SPEC' | 'ADAPTER_FIELD_UNMAPPED', field: string, reason: string): never => {
    throw new HttpException({ error: { code, message: reason, field, reason, stage,
      source: code === 'MISSING_SPEC' ? 'request' : 'adapter', recovery: 'revise_request',
      submissionState: 'not_submitted', billingState: 'not_reserved', retryable: false } }, 422);
  };
  const size = requested.size ?? (requested.width !== undefined && requested.height !== undefined
    ? `${requested.width}x${requested.height}` : undefined);
  for (const [field, value] of [['requestedSpec.size', size], ['requestedSpec.count', requested.count], ['requestedSpec.quality', requested.quality]] as const) {
    if (value === undefined) reject('MISSING_SPEC', field, '报价所需计价字段缺失');
  }
  if (requested.count! > IMAGE_ADAPTER_MAX_OUTPUTS) reject('ADAPTER_FIELD_UNMAPPED', 'requestedSpec.count', '当前图片适配器最多可安全接收4个输出');
  if (!/^([1-9]\d*)x([1-9]\d*)$/.test(size!)) {
    if (requested.width !== undefined) reject('ADAPTER_FIELD_UNMAPPED', 'requestedSpec.width', '命名尺寸没有可核验的像素宽高映射');
    if (requested.aspectRatio !== undefined) reject('ADAPTER_FIELD_UNMAPPED', 'requestedSpec.aspectRatio', '命名尺寸没有可核验的比例映射');
  }
  return { ...requested, size: size!, count: requested.count!, quality: requested.quality! };
}
@Injectable()
export class Sub2apiImageAdapter {
  constructor(private readonly settings: SettingService, @Optional() private readonly computeProtocol?: ComputeProtocolClient) {}

  async connectionFingerprint(): Promise<string> {
    const connection = await this.connection();
    return createHash('sha256').update(`${connection.base}\0${connection.key}`).digest('hex');
  }

  async connectionSnapshot(): Promise<{ connection: Sub2apiImageConnection; fingerprint: string }> {
    const connection = await this.connection();
    return { connection, fingerprint: createHash('sha256').update(`${connection.base}\0${connection.key}`).digest('hex') };
  }

  async assertConnectionFingerprint(expected: string): Promise<void> {
    if (await this.connectionFingerprint() !== expected) unavailable('CONFIG_CHANGED');
  }

  async discoverModels(connection?: Sub2apiImageConnection): Promise<Array<{ modelId: string; displayName: string }>> {
    const result = await this.call('/models', { method: 'GET' }, 15_000, 1024 * 1024, false, undefined, connection);
    const parsed = ModelsSchema.safeParse(result.value);
    if (!parsed.success) unavailable('PRICE_UNAVAILABLE', { message: 'Image model catalog validation failed', errors: parsed.error.issues });
    // The shared catalog is not evidence that a model supports image operations.
    const models = new Map<string, { modelId: string; displayName: string }>();
    for (const model of parsed.data.data) {
      if (!models.has(model.id)) models.set(model.id, {
        modelId: model.id, displayName: (model.display_name ?? model.id).slice(0, 80),
      });
    }
    return [...models.values()].sort((a, b) => a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
  }

  async pricing(input: MediaRealAnyQuoteRequest, modelId = 'gpt-image-2', snapshot?: Sub2apiImageConnection, validation = false): Promise<Sub2apiImagePrice> {
    // V1/V2 requests retain the historical model allow-list. V3 carries the
    // negotiated spec and may target an explicitly configured upstream model.
    if ('parameters' in input && !isSupportedImageModel(modelId)) unavailable();
    const spec = resolveSub2apiImageSpec(input, 'quote');
    const body = { model: modelId, operation: input.operation, size: spec.size, n: spec.count, quality: spec.quality };
    if (validation && !this.computeProtocol) unavailable('PRICE_UNAVAILABLE', '人民币报价校验需要配置算力平台服务签名');
    const result = validation ? { value: await this.computeProtocol.json('/api/v1/sep/validation/image/pricing', { method: 'POST', body }) }
      : await this.call('/sub2api/images/pricing', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }, 15_000, 64 * 1024, false, undefined, snapshot);
    const parsed = PricingSchema.safeParse(result.value);
    if (!parsed.success) unavailable('PRICE_UNAVAILABLE', { message: 'Image quote response validation failed', errors: parsed.error.issues });
    const price = parsed.data;
    if (price.model !== modelId || price.operation !== input.operation || price.size !== spec.size ||
      price.n !== spec.count || price.quality !== spec.quality || price.pricing_status !== 'quoted' ||
      price.billing_mode === 'token' || (validation
        ? price.currency !== 'CNY' || price.contract_version !== 1 || price.quote_scope !== 'platform_validation' || price.amount_cny == null
        : snapshot?.compute ? price.currency !== 'CNY' || price.contract_version !== 1 || price.enterprise_id !== snapshot.compute.enterpriseId || price.amount_cny == null || !price.quote_id || price.quote_id !== price.pricing_version
          : price.contract_version !== 1 || price.quote_scope !== 'platform_validation' || price.amount_cny == null) || Date.parse(price.expires_at) <= Date.now() ||
      Date.parse(price.expires_at) > Date.now() + 120_000 || Date.parse(price.observed_at) > Date.now() + 5000 ||
      (/fallback|default|unknown/i.test(price.pricing_source) &&
        !(price.pricing_source === 'fallback' && price.pricing_authority === 'sub2api_customer_billing'))) unavailable('PRICE_UNAVAILABLE', {
          message: 'Image quote is unavailable, expired or does not match the requested model/specification', quote: price,
          expected: { modelId, operation: input.operation, size: spec.size, n: spec.count, quality: spec.quality } });
    return price;
  }

  async usage(requestId: string, snapshot?: Sub2apiImageConnection): Promise<Sub2apiImageUsage> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(requestId)) unavailable('BILLING_PENDING');
    const result = await this.call(`/sub2api/usage?request_id=${encodeURIComponent(requestId)}`, { method: 'GET' }, 15_000, 64 * 1024, false, undefined, snapshot);
    const parsed = UsageSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.request_id !== requestId ||
      (parsed.data.status === 'settled' && (parsed.data.actual_cost_usd === null || parsed.data.model == null ||
        (parsed.data.schema_version === 1 && parsed.data.image_count == null) ||
        (parsed.data.image_count != null && (parsed.data.image_count < 1 || parsed.data.image_count > 4)))) ||
      (['pending', 'unknown'].includes(parsed.data.status) && parsed.data.actual_cost_usd !== null) ||
      (parsed.data.status === 'not_charged' && !/^0(?:\.0+)?$/.test(parsed.data.actual_cost_usd ?? ''))) unavailable('BILLING_PENDING', {
        message: 'Image usage response is invalid or does not match the original request/settlement state',
        details: parsed.success ? parsed.data : parsed.error.issues });
    return parsed.data;
  }

  async submitAsync(input: MediaRealAnyQuoteRequest, references: Buffer[], modelId: string,
    requestId: string, connection: Sub2apiImageConnection) {
    const spec = resolveSub2apiImageSpec(input, 'submit');
    if (spec.count !== 1 || input.referenceIds.length > 4) unavailable('UNSUPPORTED_MEDIA_PARAMETERS', 'Asynchronous images require n=1 and at most four references');
    let body: BodyInit;
    const headers = { 'X-Client-Request-ID': requestId, 'Idempotency-Key': requestId };
    const fields = { model: modelId, prompt: input.creativeBrief, n: 1, size: spec.size, quality: spec.quality, response_format: 'url' };
    if (input.operation === 'generate') {
      body = JSON.stringify(fields);
      headers['Content-Type'] = 'application/json';
    } else {
      if (!references.length || references.length !== input.referenceIds.length) unavailable('INVALID_REFERENCE');
      const form = new FormData();
      for (const [index, bytes] of references.entries()) {
        const { mimeType, extension } = await inspectReferenceImage(bytes, IMAGE_REFERENCE_MAX_BYTES);
        form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mimeType }), `reference-${index}.${extension}`);
      }
      for (const [field, value] of Object.entries(fields)) form.append(field, String(value));
      body = form;
    }
    const response = await this.asyncFetch(connection,
      `/images/${input.operation === 'generate' ? 'generations' : 'edits'}/async`, { method: 'POST', headers, body }, IMAGE_CREATE_TIMEOUT_MS);
    return readLongdaoMedia(response, connection.key, requestId, undefined, true);
  }

  async queryAsync(connection: Sub2apiImageConnection, requestId: string, taskId?: string | null) {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(requestId) || taskId && !/^[A-Za-z0-9_.:-]{1,256}$/.test(taskId)) unavailable('INVALID_PARAMETER');
    const path = `/images/tasks/${encodeURIComponent(taskId ?? requestId)}${taskId ? '' : '?id_type=request_id'}`;
    const response = await this.asyncFetch(connection, path, { method: 'GET' }, IMAGE_CREATE_TIMEOUT_MS);
    return readLongdaoMedia(response, connection.key, requestId, taskId);
  }

  async contentAsync(connection: Sub2apiImageConnection, taskId: string) {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(taskId)) unavailable('OUTPUT_FAILED');
    const response = await this.asyncFetch(connection, `/images/tasks/${encodeURIComponent(taskId)}/content`,
      { method: 'GET' }, IMAGE_CREATE_TIMEOUT_MS);
    if (!response.ok) throw new MediaUpstreamException(protectMediaCredential(await readMediaUpstreamError(response), connection.key));
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const expectedLength = response.headers.get('content-length');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType ?? '') || !response.body ||
        expectedLength !== null && (!/^\d+$/.test(expectedLength) || !Number.isSafeInteger(Number(expectedLength)) ||
          Number(expectedLength) < 1 || Number(expectedLength) > 20 * 1024 * 1024)) {
      await response.body?.cancel(); unavailable('OUTPUT_FAILED', 'Longdao image content has an invalid MIME type');
    }
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 20 * 1024 * 1024) unavailable('OUTPUT_FAILED', 'Image output exceeds 20 MiB');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (expectedLength !== null && length !== Number(expectedLength)) unavailable('OUTPUT_FAILED', 'Longdao image content length does not match the response header');
    const metadata = await inspectReferenceImage(bytes, 20 * 1024 * 1024, mimeType);
    return { bytes, metadata };
  }

  async execute(
    input: MediaRealAnyQuoteRequest,
    references: Buffer[],
    onRequestId?: (requestId: string) => Promise<void>,
    modelId = 'gpt-image-2',
    snapshot?: Sub2apiImageConnection,
  ): Promise<{ requestId: string; images: Buffer[] }> {
    if ('parameters' in input && !isSupportedImageModel(modelId)) unavailable();
    const spec = resolveSub2apiImageSpec(input, 'submit');
    let body: BodyInit; let headers: Record<string, string> = {};
    if (input.operation === 'generate') {
      body = JSON.stringify({ model: modelId, prompt: input.creativeBrief, n: spec.count,
        size: spec.size, quality: spec.quality, response_format: 'b64_json' });
      headers = { 'Content-Type': 'application/json' };
    } else {
      if (!references.length || references.length !== input.referenceIds.length) unavailable('INVALID_REFERENCE');
      const form = new FormData();
      for (const [index, bytes] of references.entries()) {
        const { mimeType, extension } = await inspectReferenceImage(bytes, IMAGE_REFERENCE_MAX_BYTES);
        form.append('image[]', new Blob([new Uint8Array(bytes)], { type: mimeType }), `reference-${index}.${extension}`);
      }
      for (const [key, value] of Object.entries({ model: modelId, prompt: input.creativeBrief,
        n: String(spec.count), size: spec.size, quality: spec.quality, response_format: 'b64_json' })) form.append(key, value);
      body = form;
    }
    const result = await this.call(`/images/${input.operation === 'generate' ? 'generations' : 'edits'}`, { method: 'POST', headers, body }, 180_000, 140 * 1024 * 1024, true, onRequestId, snapshot, !('parameters' in input));
    if (!result.requestId) throw new ImageDispatchError(null, false, 'UPSTREAM_FAILED',
      mediaFailure(new HttpException({ error: { message: 'Image response is missing a valid billing correlation/request ID', origin: 'sep' } }, 502)));
    const value = z.object({ model: ModelIdSchema.optional(),
      data: z.array(z.object({ b64_json: z.string().min(1) })).min(1).max(IMAGE_ADAPTER_MAX_OUTPUTS) }).safeParse(result.value);
    if (!value.success || (value.data.model !== undefined && value.data.model !== modelId) ||
      ('parameters' in input && value.data.data.length > spec.count)) throw new ImageDispatchError(result.requestId, false, 'UPSTREAM_FAILED',
        mediaFailure(new HttpException({ error: { message: 'Image response schema, model or output count does not match the request',
          origin: 'sep', details: value.success ? { model: value.data.model, count: value.data.data.length } : value.error.issues } }, 502)));
    const images: Buffer[] = [];
    try {
      for (const item of value.data.data) {
        if (item.b64_json.length > Math.ceil(25 * 1024 * 1024 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.b64_json)) throw new Error('Image base64 output is invalid or exceeds the size limit');
        const bytes = Buffer.from(item.b64_json, 'base64');
        const dimensions = inspectMediaPng(bytes);
        if ('parameters' in input) {
          const expected = spec.size.match(/^([1-9]\d*)x([1-9]\d*)$/);
          if (expected && (dimensions.width !== Number(expected[1]) || dimensions.height !== Number(expected[2]))) throw new Error(`Image dimensions ${dimensions.width}x${dimensions.height} do not match requested ${spec.size}`);
        }
        images.push(bytes);
      }
    } catch (error) { throw new ImageDispatchError(result.requestId, false, 'UPSTREAM_FAILED', mediaFailure(error)); }
    return { requestId: result.requestId, images };
  }

  private async connection() {
    try {
      const { baseUrl, apiKey } = await this.settings.getMediaConnection('image');
      return this.normalizeConnection({ base: baseUrl, key: apiKey });
    } catch (error) { if (error instanceof HttpException) throw error; unavailable('PRICE_UNAVAILABLE', error); }
  }

  private async asyncFetch(connection: Sub2apiImageConnection, path: string, options: RequestInit, timeout: number) {
    const frozen = this.normalizeConnection(connection);
    if (!frozen.compute || !this.computeProtocol) unavailable('CONFIG_CHANGED', '图片任务缺少企业凭证或签名上下文');
    try {
      return await this.computeProtocol.fetchSigned(frozen.base + path, {
        ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      }, { ...frozen.compute, apiKey: frozen.key });
    } catch (failure) {
      throw new MediaUpstreamException(protectMediaCredential(mediaFailure(failure), frozen.key));
    }
  }

  private normalizeConnection(connection: Sub2apiImageConnection): Sub2apiImageConnection {
    try {
      const url = this.computeProtocol ? this.computeProtocol.validateAddress(connection.base) : new URL(connection.base);
      if ((!this.computeProtocol && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !connection.key || /[^\x21-\x7e]/.test(connection.key)) unavailable();
      return { ...connection, base: url.href.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1', key: connection.key };
    } catch (error) { if (error instanceof HttpException) throw error; unavailable('PRICE_UNAVAILABLE', error); }
  }

  private async call(path: string, options: RequestInit, timeout: number, maxBytes: number, dispatch = false, onRequestId?: (requestId: string) => Promise<void>, snapshot?: Sub2apiImageConnection, classifySpec = false): Promise<{ value: unknown; requestId: string | null }> {
    const connection = snapshot ? this.normalizeConnection(snapshot) : await this.connection();
    let requestId: string | null = null;
    try {
      const requestOptions = { ...options, headers: {
        ...options.headers, Authorization: `Bearer ${connection.key}`, Accept: 'application/json',
      }, redirect: 'error' as const, signal: AbortSignal.timeout(timeout) };
      const response = connection.compute ? await this.computeProtocol.fetchSigned(connection.base + path, requestOptions,
        { ...connection.compute, apiKey: connection.key }) : await fetch(connection.base + path, requestOptions);
      // sub2api bills by its client correlation ID; X-Request-ID may belong to the upstream.
      const clientId = response.headers.get('x-client-request-id');
      const rawId = clientId === null ? response.headers.get('x-request-id') : `client:${clientId}`;
      requestId = rawId && /^[A-Za-z0-9_.:-]{1,256}$/.test(rawId) && clientId !== '' ? rawId : null;
      if (requestId && onRequestId) {
        try { await onRequestId(requestId); }
        catch (error) {
          await response.body?.cancel().catch(() => {});
          // Persistence failure cannot establish that upstream work was rejected.
          throw new ImageDispatchError(requestId, false, 'UPSTREAM_FAILED', { status: 502, body: { error: {
            code: 'SUBMISSION_UNKNOWN', origin: 'sep', stage: 'request-id-persistence',
            message: errorMessage(mediaFailure(error).body) ?? 'Request ID persistence failed', cause: mediaFailure(error).body,
          } } });
        }
      }
      if (!response.ok) {
        const upstreamError = protectMediaCredential(await readMediaUpstreamError(response), connection.key);
        const rejected = z.object({ error: z.object({ code: z.string() }) }).safeParse(upstreamError.body);
        const unsupported = dispatch && classifySpec && [400, 422].includes(response.status) && rejected.success &&
          ['unsupported_spec', 'unsupported_parameter', 'unsupported_size', 'unsupported_quality'].includes(rejected.data.error.code);
        // V3 supplier errors do not prove that no upstream execution or billing occurred.
        // Keep the historical rejection contract isolated to legacy requests.
        if (dispatch) throw new ImageDispatchError(requestId, !connection.compute && !classifySpec && [400, 401, 403, 404, 413, 422, 429].includes(response.status), unsupported ? 'UPSTREAM_SPEC_UNSUPPORTED' : 'UPSTREAM_FAILED', upstreamError);
        throw new MediaUpstreamException(upstreamError);
      }
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error('Upstream response must contain a JSON body');
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.length; if (length > maxBytes) throw new Error(`Upstream response exceeds ${maxBytes} bytes`); chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (hasBusinessError(value)) {
        const failure = protectMediaCredential({ status: response.status, body: value, headers: upstreamHeaders(response) }, connection.key);
        if (dispatch) throw new ImageDispatchError(requestId, false, 'UPSTREAM_FAILED', failure);
        throw new MediaUpstreamException(failure);
      }
      return { value, requestId };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const failure = protectMediaCredential(mediaFailure(error), connection.key);
      if (dispatch) throw new ImageDispatchError(requestId, false, 'UPSTREAM_FAILED', failure);
      throw new MediaUpstreamException(failure);
    }
  }
}
