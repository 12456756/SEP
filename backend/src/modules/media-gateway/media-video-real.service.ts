import { HttpException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_MEDIA_REFERENCE_TOTAL_BYTES, MediaVideoCapabilitiesSchema, MediaVideoReferenceUploadQuerySchema, MediaJsonValueSchema } from 'shared';
import { MediaUpstreamException, mediaFailure, retainMediaFailure } from '../../common/errors/media-upstream.exception';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { z } from 'zod';
import { isVideoDurationInRange, parseUsdToCnyRate, SETTING_KEYS, VIDEO_REFERENCE_MAX_BYTES } from 'shared';
import type { MediaVideoGatewayQuoteRequest, MediaVideoGatewayQuoteRequestV3,
  MediaVideoGatewayRequest } from 'shared';
import { MediaVideoAuthorizationSchema, MediaVideoRealProfilesSchema, MediaVideoRealQuoteRequestSchema, MediaVideoRealReceiptSchema, MediaVideoRealRequestSchema } from 'shared';
import type { MediaVideoRealQuoteRequest, MediaVideoRealReceipt, MediaVideoRealRequest } from 'shared';
import type { MediaVideoReferenceUploadQuery } from 'shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import { MediaVideoConfigService } from '../media-config/media-video-config.service';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { clientSubscriptionAccessWhere } from '../client/client-subscription-access';
import { MediaRealBillingService } from './media-real-billing.service';
import { inspectReferenceImage } from './media-reference-image';
import { MediaVideoRealStore, VIDEO_REAL_ADAPTER } from './media-video-real.store';
import type { VideoRealRecord } from './media-video-real.store';
import { Sub2apiVideoAdapter, VideoDispatchError } from './sub2api-video.adapter';
import type { Sub2apiVideoConnection } from './sub2api-video.adapter';
import { VideoFileCacheService } from './video-file-cache.service';
import { videoGatewayError as fail, videoStorageUnavailable } from './media-video-gateway.store';
import type { InspectedVideoReference } from './video-reference-upload.service';
import { closedSubmission, executionEvidence, executionFailure, mediaClientActions, mergeExecutionEvidence, recoverableTaskId, VIDEO_SUBMISSION_BUDGET_MS, MEDIA_SAVE_GRACE_MS,
  type LongdaoMediaResult } from './longdao-media-contract';
import { MediaVideoRecoveryLeaseService, type VideoRecoveryLease } from './media-video-recovery-lease.service';

type VideoRecoveryOwner = Pick<ClientEmploymentClaims, 'enterpriseId' | 'subscriptionId' | 'memberId' | 'sub'>;

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const REFERENCE_TTL = 15 * 60_000;
const OUTPUT_TTL = 24 * 60 * 60_000;
const SUBMISSION_TTL = VIDEO_SUBMISSION_BUDGET_MS + MEDIA_SAVE_GRACE_MS;

@Injectable()
export class MediaVideoRealService {
  private readonly recovering = new Map<string, Promise<VideoRealRecord>>();
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly setting: SettingService,
    private readonly videoConfig: MediaVideoConfigService,
    private readonly adapter: Sub2apiVideoAdapter,
    private readonly cache: VideoFileCacheService,
    private readonly billing: MediaRealBillingService,
    private readonly store: MediaVideoRealStore,
    @Optional() private readonly recoveryLease?: MediaVideoRecoveryLeaseService,
  ) {}

  assertRealEnabled(): void {
    if (this.config.get<string>('MEDIA_VIDEO_REAL_ENABLED') !== 'true') fail(503, 'MEDIA_REAL_DISABLED', '真实视频执行未启用');
  }

  async profiles(claims: ClientEmploymentClaims, protocolVersion = 1) {
    await this.authorize(claims, true);
    if (protocolVersion === 3) {
      const runtime = await this.videoConfig.getRuntimeVideoV3(claims.enterpriseId);
      const profiles = runtime.profiles.filter(profile => profile.authorized);
      if (!profiles.length) fail(403, 'MEDIA_FORBIDDEN', '当前企业无真实视频授权');
      return { mock: false, protocolVersion: 3, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles };
    }
    const runtime = await this.videoConfig.getRuntimeVideo(claims.enterpriseId);
    if (!runtime.executionAvailable || (runtime as { executionMode?: string }).executionMode !== 'real') {
      fail(403, 'MEDIA_FORBIDDEN', '当前企业无真实视频授权');
    }
    const profiles = [];
    for (const profile of runtime.profiles) {
      const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId: profile.profileId } });
      if (row?.kind === 'video' && row.modelId === 'minimax-h3' && row.enabled && row.verified && row.configVersion === profile.configVersion) profiles.push(profile);
    }
    if (!profiles.length) fail(403, 'MEDIA_FORBIDDEN', '当前企业无已验证的真实视频 Profile');
    return MediaVideoRealProfilesSchema.parse({ mock: false, protocolVersion: 1, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles });
  }

  async reference(claims: ClientEmploymentClaims, file?: Express.Multer.File, fields?: unknown) {
    await this.authorize(claims, true);
    const profiles = await this.profiles(claims, 3);
    if (!profiles.profiles.some((profile: any) => profile.operations.includes('image-to-video') && profile.adapter.available && profile.adapter.referenceSupport.maxCount >= 1)) fail(403, 'MEDIA_FORBIDDEN', '无图生视频授权');
    if (fields && Object.keys(fields as object).length) fail(400, 'INVALID_REFERENCE', '参考上传不接受额外字段');
    if (!file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size > VIDEO_REFERENCE_MAX_BYTES) fail(400, 'INVALID_REFERENCE', '需要不超过 10MiB 的 JPEG、PNG 或 WebP 参考图');
    const { mimeType, width, height } = await inspectReferenceImage(file.buffer, VIDEO_REFERENCE_MAX_BYTES, file.mimetype);
    if (!profiles.profiles.some((profile: any) => profile.operations.includes('image-to-video') && profile.adapter.referenceSupport.maxInputBytes >= file.size)) fail(400, 'INVALID_REFERENCE', '参考图超过 Profile 输入限制');
    const expiresAt = new Date(Date.now() + REFERENCE_TTL).toISOString();
    const scope = this.scope(claims);
    const reference = await this.store.saveReference(scope, { mock: false, expiresAt, mimeType,
      sha256: hash(file.buffer), byteLength: file.buffer.length, width, height });
    const stored = await this.cache.saveReference(scope, reference.referenceId, file.buffer, expiresAt);
    if (stored.sha256 !== reference.sha256 || stored.byteLength !== reference.byteLength || stored.width !== reference.width || stored.height !== reference.height) videoStorageUnavailable();
    return reference;
  }

  async prepareVideoReference(claims: ClientEmploymentClaims, raw: MediaVideoReferenceUploadQuery) {
    const input = this.parse(MediaVideoReferenceUploadQuerySchema, raw);
    await this.authorize(claims, true);
    const profile = await this.requireProfile(claims, { ...input, protocolVersion: 3, operation: 'video-to-video', requestedSpec: {} }, true, 'video-upload');
    return { input, capabilities: profile.capabilities, connection: await this.adapter.connection() };
  }

  async videoReference(claims: ClientEmploymentClaims, upload: {
    file: InspectedVideoReference; context: Awaited<ReturnType<MediaVideoRealService['prepareVideoReference']>>; signal: AbortSignal;
  }) {
    const { file, context, signal } = upload;
    const current = await this.prepareVideoReference(claims, context.input);
    if (current.connection.fingerprint !== context.connection.fingerprint) fail(409, 'CONFIG_CHANGED', '视频连接在上传期间发生变化');
    if (signal.aborted) fail(408, 'VIDEO_REFERENCE_UPLOAD_TIMEOUT', '参考视频上传已中断或超时');
    const upstream = await this.adapter.uploadReference(context.connection, file, signal);
    const afterUpload = await this.prepareVideoReference(claims, context.input);
    if (afterUpload.connection.fingerprint !== context.connection.fingerprint) fail(409, 'CONFIG_CHANGED', '视频连接在上传期间发生变化，请重新上传');
    if (signal.aborted) fail(408, 'VIDEO_REFERENCE_UPLOAD_TIMEOUT', '参考视频上传已中断或超时');
    return this.store.saveVideoReference(this.scope(claims), {
      value: { ...context.input, mock: false, kind: 'video', mimeType: file.mimeType, byteLength: file.byteLength,
        sha256: file.sha256, expiresAt: upstream.expires_at },
      upstreamReferenceId: upstream.reference_id, connectionFingerprint: context.connection.fingerprint,
    });
  }

  async quote(claims: ClientEmploymentClaims, raw: MediaVideoRealQuoteRequest) {
    await this.authorize(claims, true);
    const input = this.parse(MediaVideoRealQuoteRequestSchema, raw);
    const profile = await this.requireProfile(claims, input, true, 'video-quote');
    const references = await this.references(claims, input.referenceIds, profile.capabilities.maxInputBytes);
    const connection = await this.adapter.connection();
    const videos = await this.videoReferences(claims, input, profile.capabilities, connection.fingerprint);
    const allIds = this.referenceIds(input);
    const allHashes = [...references.map(r => r.sha256), ...videos.map(r => r.value.sha256)];
    const price = await this.adapter.pricing(connection, input, profile.modelId);
    const dimensions = this.billingDimensions(input);
    if (price.model !== profile.modelId || price.operation !== input.operation || price.duration_seconds !== dimensions.durationSeconds ||
      price.resolution !== dimensions.resolution || price.pricing_status !== 'quoted' || price.amount_usd === null) fail(503, 'PRICE_UNAVAILABLE', '视频报价规格不匹配');
    const rate = parseUsdToCnyRate((await this.setting.getEffectiveValue(SETTING_KEYS.USD_TO_CNY_RATE)) ?? undefined);
    const amountUsd = new Decimal(price.amount_usd);
    const amountCny = amountUsd.mul(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
    if (!amountUsd.isFinite() || amountUsd.lte(0) || new Decimal(amountCny).lte(0) || new Decimal(amountCny).gt('99999999.999999')) fail(503, 'PRICE_UNAVAILABLE', '视频报价金额无效');
    const expiresAt = new Date(Math.min(Date.now() + 60_000, Date.parse(price.expires_at), ...videos.map(r => Date.parse(r.value.expiresAt)))).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) fail(409, 'QUOTE_EXPIRED', '视频报价已过期');
    const funding = await this.billing.quoteFunding(claims, amountCny);
    const semanticSha256 = this.semanticHash(input, allHashes, this.scope(claims));
    await this.authorize(claims, true);
    await this.requireProfile(claims, input, true, 'video-quote');
    return this.store.saveQuote(this.scope(claims), {
      adapter: VIDEO_REAL_ADAPTER, consumedByClientRequestId: null,
      value: { mock: false, expiresAt, semanticSha256, pricingStatus: 'quoted', amountCny, amountUsd: price.amount_usd,
        pricingVersion: price.pricing_version, usdToCnyRate: rate, billingStatus: 'NOT_RESERVED', funding,
        ...('protocolVersion' in input ? { protocolVersion: 3 as const, semanticHashVersion: 3 as const,
          specRevision: input.specRevision, effectiveSpec: input.requestedSpec,
          billingDimensions: { model: profile.modelId, operation: input.operation, ...dimensions } } : {}) },
      configuration: 'protocolVersion' in input
        ? { adapter: VIDEO_REAL_ADAPTER, protocolVersion: 3 as const, semanticHashVersion: 3 as const,
          specRevision: input.specRevision, profileId: input.profileId, configVersion: input.configVersion,
          modelId: profile.modelId, operation: input.operation, maxReferenceCount: profile.capabilities.maxReferenceCount,
          ...(videos.length ? { maxVideoReferenceCount: profile.capabilities.maxVideoReferenceCount,
            videoReferences: videos.map(r => ({ ...r.value, upstreamReferenceId: r.upstreamReferenceId })) } : {}),
          requestedSpec: input.requestedSpec, effectiveSpec: input.requestedSpec,
          parameterSources: input.parameterSources,
          connectionFingerprint: connection.fingerprint, amountCny, amountUsd: price.amount_usd,
          pricingVersion: price.pricing_version, usdToCnyRate: rate }
        : { adapter: VIDEO_REAL_ADAPTER, profileId: input.profileId, configVersion: input.configVersion,
          modelId: 'minimax-h3', operation: input.operation, parameters: (input as MediaVideoGatewayQuoteRequest).parameters, connectionFingerprint: connection.fingerprint,
          amountCny, amountUsd: price.amount_usd, pricingVersion: price.pricing_version, usdToCnyRate: rate },
      referenceIds: allIds, referenceHashes: allHashes,
    });
  }

  async submit(claims: ClientEmploymentClaims, raw: MediaVideoRealRequest): Promise<MediaVideoRealReceipt> {
    // Existing requests can be recovered when the execution switch has been turned off.
    await this.authorize(claims, false);
    const input = this.parse(MediaVideoRealRequestSchema, raw);
    // The supplier contract contains generation fields only; local quote and
    // idempotency identifiers are passed separately, never as quote-schema keys.
    const { clientRequestId, quoteId: _quoteId, ...generationInput } = input;
    const scope = this.scope(claims);
    const prior = await this.store.findByClientId(claims.enterpriseId, input.clientRequestId, scope, true);
    if (prior) {
      await this.requireProfile(claims, prior.configuration, false, 'video-submit', prior.configuration.modelId);
      this.assertReplay(input, prior);
      return this.snapshot(await this.recover(claims, prior));
    }
    await this.authorize(claims, true);
    const profile = await this.requireProfile(claims, input, true, 'video-submit');
    const references = await this.references(claims, input.referenceIds, profile.capabilities.maxInputBytes);
    const currentConnection = input.operation === 'video-to-video' ? await this.adapter.connection() : undefined;
    const videos = await this.videoReferences(claims, input, profile.capabilities, currentConnection?.fingerprint ?? '');
    const allIds = this.referenceIds(input);
    const allHashes = [...references.map(r => r.sha256), ...videos.map(r => r.value.sha256)];
    const quote = await this.store.findQuote(scope, input.quoteId);
    if (!quote) fail(404, 'MEDIA_NOT_FOUND', '视频报价不可用');
    if (Date.parse(quote.value.expiresAt) <= Date.now()) fail(409, 'QUOTE_EXPIRED', '视频报价已过期');
    const semanticSha256 = this.semanticHash(input, allHashes, scope);
    if (semanticSha256 !== quote.value.semanticSha256 || JSON.stringify(allIds) !== JSON.stringify(quote.referenceIds) ||
      !this.sameSpec(input, quote.configuration) || profile.modelId !== quote.configuration.modelId) fail(409, 'IDEMPOTENCY_CONFLICT', '视频请求与冻结报价不一致');
    if (videos.length && (!('protocolVersion' in quote.configuration) || JSON.stringify(quote.configuration.videoReferences) !==
      JSON.stringify(videos.map(r => ({ ...r.value, upstreamReferenceId: r.upstreamReferenceId }))))) fail(409, 'IDEMPOTENCY_CONFLICT', '参考视频与冻结报价不一致');
    const connection = await this.frozenConnection(quote.configuration.connectionFingerprint);
    const bytes = await Promise.all(references.map(r => this.cache.readReference(scope, r.referenceId,
      { sha256: r.sha256, byteLength: r.byteLength, expiresAt: r.expiresAt })));
    const requestId = `sep-video-${randomUUID()}`;
    const claim = await this.store.claim({ enterpriseId: claims.enterpriseId, clientRequestId: input.clientRequestId, scope,
      semanticSha256, referenceIds: allIds, referenceHashes: allHashes,
      submissionDeadline: new Date(Date.now() + SUBMISSION_TTL),
      configuration: { ...quote.configuration, quoteId: input.quoteId, contractVersion: 2, cancelSupported: profile.capabilities.supportsCancel,
        upstreamTaskId: null, upstreamRequestId: requestId,
        dispatchState: 'NOT_DISPATCHED', outputExpiresAt: null },
      receipt: { mock: false, clientRequestId: input.clientRequestId, profileId: input.profileId, configVersion: input.configVersion,
        paymentMode: quote.value.funding.paymentMode ?? 'AUTO',
        operation: input.operation, status: 'SUBMITTING', pollAfterMs: 2000, outputs: [], billingStatus: 'NOT_RESERVED',
        amountCny: quote.value.amountCny, amountUsd: quote.value.amountUsd, errorCode: null,
        ...('protocolVersion' in input ? { protocolVersion: 3 as const, specRevision: input.specRevision,
          semanticHashVersion: 3 as const, effectiveSpec: input.requestedSpec, deliveryStatus: 'unknown' as const,
          billingDimensions: { model: profile.modelId, operation: input.operation, ...this.billingDimensions(input) } } : {}),
        receiptVersion: 2, fileStatus: 'pending', execution: { requestId, taskId: null, submissionStatus: 'submitting',
          generationStatus: null, isFinal: null, observedAt: null, statusSource: null, billing: { status: 'pending', actualCostUsd: null } },
        recovery: { canQuery: true, canCancel: false, canDownload: false } },
    });
    this.assertReplay(input, claim.record);
    if (!claim.created) return this.snapshot(claim.record);
    let record = claim.record;
    try {
      await this.billing.reserve(claims, record.receipt.receiptId, quote.value.amountCny, quote.value.usdToCnyRate, quote.value.funding.paymentMode ?? 'AUTO');
    } catch (error) {
      const insufficient = error instanceof HttpException && error.getStatus() === 402;
      const changed = error instanceof HttpException && (error.getResponse() as { error?: { code?: string } }).error?.code === 'PAYMENT_MODE_CHANGED';
      const notReserved = insufficient || changed;
      record.receipt.status = notReserved || record.receipt.execution ? 'FAILED' : 'SUBMISSION_UNKNOWN';
      record.receipt.billingStatus = notReserved ? 'NOT_RESERVED' : 'RECONCILING';
      record.receipt.errorCode = changed ? 'CONFIG_CHANGED' : insufficient ? 'INSUFFICIENT_FUNDS' : 'BILLING_PENDING';
      record.receipt.billingError = mediaFailure(error);
      if (record.receipt.execution) {
        record.receipt.execution.submissionStatus = 'not_submitted'; record.receipt.execution.operation = 'create';
        record.receipt.fileStatus = 'unavailable';
      }
      if (notReserved && record.receipt.execution) {
        record.receipt.execution.submissionStatus = 'not_submitted'; record.receipt.fileStatus = 'unavailable';
        record.receipt.execution.billing = { status: 'not_charged', actualCostUsd: '0' };
      }
      const failedSave = await this.store.save(this.normalize(record));
      record = failedSave.record;
      if (!failedSave.updated && record.receipt.status === 'FAILED') await this.releaseUnsubmitted(record);
      return this.snapshot(record);
    }
    record.receipt.billingStatus = 'RESERVED';
    let saved = await this.store.save(this.normalize(record));
    if (!saved.updated) {
      // A timeout recovery may have closed dispatch while reserve was committing.
      await this.releaseUnsubmitted(saved.record);
      return this.snapshot((await this.store.findRequest(scope, saved.record.receipt.receiptId)) ?? saved.record);
    }
    record = saved.record;
    // Freeze a dispatch marker before POST. Any crash afterwards can only recover, never resubmit.
    try {
      await this.authorize(claims, true);
      await this.requireProfile(claims, input, true, 'video-submit');
      await this.frozenConnection(record.configuration.connectionFingerprint);
      await this.videoReferences(claims, input, profile.capabilities, connection.fingerprint);
    } catch (error) {
      record.receipt.status = 'FAILED'; record.receipt.errorCode = 'CONFIG_CHANGED';
      if (record.receipt.execution) {
        record.receipt.execution.submissionStatus = 'not_submitted'; record.receipt.execution.operationError = mediaFailure(error);
        record.receipt.execution.billing = { status: 'not_charged', actualCostUsd: '0' };
        record.receipt.fileStatus = 'unavailable';
      }
      saved = await this.store.save(this.normalize(record));
      if (saved.updated) {
        record = saved.record;
        await this.releaseUnsubmitted(record);
      }
      return this.snapshot((await this.store.findRequest(scope, record.receipt.receiptId)) ?? record);
    }
    record.configuration.dispatchState = 'DISPATCHING';
    saved = await this.store.save(this.normalize(record));
    if (!saved.updated) return this.snapshot(saved.record);
    record = saved.record;
    try {
      if (record.configuration.contractVersion === 2) {
        const result = await this.adapter.submitContract(connection, generationInput, profile.modelId, bytes, requestId,
          record.configuration.pricingVersion, ...(videos.length ? [videos.map(r => r.upstreamReferenceId)] : []));
        return this.snapshot(await this.applyContract(record, result));
      }
      const result = await this.adapter.submit(connection, generationInput, profile.modelId, bytes, clientRequestId,
        record.configuration.pricingVersion, ...(videos.length ? [videos.map(r => r.upstreamReferenceId)] : []));
      record.configuration.upstreamTaskId = result.taskId;
      record.configuration.upstreamRequestId = result.requestId;
      record.configuration.dispatchState = 'ACCEPTED';
      record.receipt.status = result.status === 'queued' ? 'QUEUED' : result.status === 'cancelled' ? 'CANCELLED' : result.status === 'failed' ? 'FAILED' : 'RUNNING';
      record.receipt.errorCode = ['FAILED', 'CANCELLED'].includes(record.receipt.status) ? 'UPSTREAM_FAILED' : null;
      if (record.receipt.errorCode && result.error !== undefined) record.receipt.upstreamError = { status: 200, body: { error: result.error } };
      record = await this.saveDispatch(record);
    } catch (error) {
      record.receipt.upstreamError = error instanceof VideoDispatchError && error.upstreamError
        ? error.upstreamError : mediaFailure(error);
      if (error instanceof VideoDispatchError && error.definitelyRejected) {
        record.configuration.dispatchState = 'REJECTED';
        record.configuration.upstreamRequestId = error.requestId;
        record.receipt.status = 'FAILED'; record.receipt.errorCode = 'UPSTREAM_FAILED';
        record = await this.saveDispatch(record);
        await this.releaseUnsubmitted(record);
        if (error.upstreamError) throw new MediaUpstreamException(error.upstreamError);
        return this.snapshot((await this.store.findRequest(scope, record.receipt.receiptId)) ?? record);
      }
      if (record.configuration.contractVersion !== 2) record.configuration.upstreamRequestId = error instanceof VideoDispatchError ? error.requestId : record.configuration.upstreamRequestId;
      record.receipt.status = 'SUBMISSION_UNKNOWN';
      record.receipt.errorCode = error instanceof VideoDispatchError && error.specUnsupported ? 'UPSTREAM_SPEC_UNSUPPORTED' : 'SUBMISSION_UNKNOWN';
      record.receipt.billingStatus = 'RECONCILING';
      record = await this.saveDispatch(record);
      if (record.receipt.execution) {
        record.receipt.execution.operation = 'create';
        record.receipt.execution.submissionStatus = 'unknown';
        record.receipt.execution.operationError = mediaFailure(error);
        record.receipt.execution.taskId ??= recoverableTaskId(error, requestId);
        record.configuration.upstreamTaskId ??= record.receipt.execution.taskId;
        record = (await this.store.save(record)).record;
      }
      if (record.configuration.contractVersion !== 2 && error instanceof VideoDispatchError && error.upstreamError) throw new MediaUpstreamException(error.upstreamError);
      return this.snapshot(record);
    }
    return this.snapshot(record);
  }

  async findByClientId(claims: ClientEmploymentClaims, clientRequestId: string) {
    await this.authorize(claims, false);
    this.parse(ResourceIdSchema, clientRequestId);
    const record = await this.store.findByClientId(claims.enterpriseId, clientRequestId, this.scope(claims));
    if (!record) fail(404, 'MEDIA_NOT_FOUND', '未找到视频回执，不代表上游未接单');
    await this.requireProfile(claims, record.configuration, false, 'video-query', record.configuration.modelId);
    return this.snapshot(await this.recover(claims, record));
  }

  async receipt(claims: ClientEmploymentClaims, receiptId: string) {
    const record = await this.owned(claims, receiptId);
    return this.snapshot(await this.recover(claims, record));
  }

  async content(claims: ClientEmploymentClaims, receiptId: string, outputId: string) {
    const record = await this.owned(claims, receiptId);
    this.parse(ResourceIdSchema, outputId);
    const output = record.receipt.outputs.find(o => o.outputId === outputId);
    if (!output) fail(404, 'MEDIA_NOT_FOUND', '视频输出不存在');
    if (!['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status) || !output.expiresAt || Date.parse(output.expiresAt) <= Date.now()) fail(410, 'RESULT_EXPIRED', '原视频结果已过期，不会重新生成');
    const { metadata, stream } = await this.cache.streamOutput(record.scope, outputId,
      { sha256: output.sha256, byteLength: output.byteLength, expiresAt: output.expiresAt });
    try {
      const audioMatches = 'protocolVersion' in record.configuration
        ? 'actualSpec' in record.receipt && record.receipt.actualSpec?.hasAudio === metadata.hasAudio
        : !this.requiresAudio(record.configuration) || metadata.hasAudio === true;
      if (metadata.byteLength > 256 * 1024 * 1024 || metadata.byteLength !== output.byteLength || metadata.sha256 !== output.sha256 ||
        metadata.width !== output.width || metadata.height !== output.height || metadata.durationSeconds !== output.durationSeconds ||
        metadata.frameRate !== output.frameRate || metadata.mimeType !== output.mimeType ||
        !audioMatches) fail(502, 'OUTPUT_FAILED', '视频输出校验失败');
      await this.authorize(claims, false);
      await this.requireProfile(claims, record.configuration, false, 'video-content', record.configuration.modelId);
      return { output, stream };
    } catch (error) { stream.destroy(); throw error; }
  }

  async cancel(claims: ClientEmploymentClaims, receiptId: string): Promise<MediaVideoRealReceipt> {
    const record = await this.owned(claims, receiptId);
    if (record.configuration.contractVersion !== 2 || !record.configuration.cancelSupported || !record.configuration.upstreamTaskId) fail(409, 'CANCEL_UNSUPPORTED', '原视频不支持取消或尚无可取消的任务编号');
    if (record.receipt.execution?.isFinal || closedSubmission(record.receipt.execution!)) return this.snapshot(record);
    const connection = await this.frozenConnection(record.configuration.connectionFingerprint);
    try {
      const result = await this.adapter.cancelContract(connection, record.receipt.execution!.requestId, record.configuration.upstreamTaskId);
      return this.snapshot(await this.applyContract(record, result));
    } catch (error) {
      record.receipt.execution!.operation = 'cancel';
      record.receipt.execution!.operationError = mediaFailure(error); record.receipt.upstreamError = mediaFailure(error);
      return this.snapshot((await this.store.save(record)).record);
    }
  }

  async recoverPending(scope: string, receiptId: string): Promise<void> {
    const record = await this.store.findRequest(scope, receiptId);
    if (!record) return;
    if (record.receipt.status === 'SUBMITTING' && !record.receipt.upstreamError
      && record.submissionDeadline.getTime() > Date.now()) return;
    const [enterpriseId, subscriptionId, memberId, sub] = this.parse(
      z.string().transform((value, ctx) => {
        try { return JSON.parse(value) as unknown; }
        catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid video owner scope' }); return z.NEVER; }
      }).pipe(z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)])), record.scope);
    if (enterpriseId !== record.enterpriseId) videoStorageUnavailable();
    await this.recover({ enterpriseId, subscriptionId, memberId, sub }, record);
  }

  private async recover(claims: VideoRecoveryOwner, initial: VideoRealRecord): Promise<VideoRealRecord> {
    const execution = initial.receipt.execution;
    const billingFinal = ['SETTLED', 'RELEASED', 'NOT_RESERVED'].includes(initial.receipt.billingStatus);
    if (execution ? billingFinal && (initial.receipt.fileStatus === 'available' || initial.receipt.fileStatus === 'expired'
      || closedSubmission(execution) || ['failed', 'cancelled'].includes(execution.generationStatus!))
      : ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(initial.receipt.status) && billingFinal) return initial;
    const id = initial.receipt.receiptId;
    const pending = this.recovering.get(id);
    if (pending) return pending;
    const work = (async () => {
      let lease: VideoRecoveryLease | null | undefined;
      try { lease = this.recoveryLease ? await this.recoveryLease.acquire(id) : undefined; }
      catch (error) {
        const current = (await this.store.findRequest(initial.scope, id)) ?? initial;
        const failure = mediaFailure(error);
        current.receipt.upstreamError = failure;
        if (current.receipt.execution) {
          current.receipt.execution.operation = 'query'; current.receipt.execution.operationError = failure;
        }
        return (await this.store.save(this.normalize(current))).record;
      }
      if (lease === null) return (await this.store.findRequest(initial.scope, id)) ?? initial;
      try {
        const current = await this.store.findRequest(initial.scope, id);
        if (!current) return initial;
        if (current.receipt.status === 'SUBMITTING' && !current.receipt.upstreamError
          && current.submissionDeadline.getTime() > Date.now()) return current;
        const assertHeld = () => lease?.assertHeld();
        return current.configuration.contractVersion === 2
          ? await this.recoverContract(claims, current, assertHeld)
          : await this.recoverLegacy(claims, current);
      } finally { await lease?.release(); }
    })();
    this.recovering.set(id, work);
    try { return await work; } finally { this.recovering.delete(id); }
  }

  private async recoverLegacy(claims: VideoRecoveryOwner, initial: VideoRealRecord): Promise<VideoRealRecord> {
    let record = structuredClone(initial);
    const terminal = ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(record.receipt.status);
    // Owned/profile authorization runs before recovery; finalized local results
    // must not depend on the availability of the old upstream connection.
    if (terminal && !['RESERVED', 'RECONCILING'].includes(record.receipt.billingStatus)) return record;
    if (record.configuration.dispatchState === 'NOT_DISPATCHED' && record.submissionDeadline.getTime() <= Date.now() &&
      ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'FAILED'].includes(record.receipt.status)) {
      // Claim FAILED by CAS before releasing a reservation: a late original owner
      // then loses its dispatch CAS and cannot POST after funds have been returned.
      record.receipt.status = 'FAILED'; record.receipt.errorCode = 'BILLING_PENDING';
      const closed = await this.store.save(this.normalize(record));
      if (!closed.updated) return closed.record;
      record = closed.record;
      await this.releaseUnsubmitted(record);
      return (await this.store.findRequest(record.scope, record.receipt.receiptId)) ?? record;
    }
    if (record.receipt.status === 'SUBMITTING') {
      if (record.submissionDeadline.getTime() > Date.now()) return record;
      record.receipt.status = 'SUBMISSION_UNKNOWN'; record.receipt.errorCode = 'SUBMISSION_UNKNOWN';
      record.receipt.billingStatus = 'RECONCILING';
      record = (await this.store.save(this.normalize(record))).record;
    }
    if (!record.configuration.upstreamTaskId && !record.configuration.upstreamRequestId) return record;
    const connection = await this.frozenConnection(record.configuration.connectionFingerprint);
    if (record.configuration.upstreamTaskId && ['QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(record.receipt.status)) {
      let downloading = false;
      try {
        const task = await this.adapter.query(connection, record.configuration.upstreamTaskId, record.configuration.modelId);
        if (task.id !== record.configuration.upstreamTaskId || task.model !== record.configuration.modelId) fail(502, 'UPSTREAM_FAILED', '原视频任务身份不匹配');
        delete record.receipt.upstreamError;
        if (task.status === 'completed') {
          if (!record.configuration.outputExpiresAt) {
            record.configuration.outputExpiresAt = new Date(Date.now() + OUTPUT_TTL).toISOString();
            record = (await this.store.save(this.normalize(record))).record;
          }
          // A competing query may have observed a terminal provider failure.
          if (!['QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(record.receipt.status)) return this.reconcile(record, connection);
          if (Date.parse(record.configuration.outputExpiresAt) <= Date.now()) {
            record.receipt.status = 'RESULT_EXPIRED'; record.receipt.errorCode = 'RESULT_EXPIRED';
          } else if (!['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status)) {
            await this.authorize(claims, false);
            await this.requireProfile(claims, record.configuration, false, 'video-query', record.configuration.modelId);
            const outputId = `${record.receipt.receiptId}-output-1`;
            downloading = true;
            const { hasAudio, ...metadata } = await this.cache.saveOutput(record.scope, outputId,
              await this.adapter.rawContent(connection, record.configuration.upstreamTaskId, this.outputFormat(record.configuration)), record.configuration.outputExpiresAt);
            // Real metadata is measured from bytes, never copied from requested settings.
            const matches = this.outputMatches(record.configuration, metadata, hasAudio);
            record.receipt.outputs = [{ ...metadata, outputId, kind: 'video', thumbnailOutputId: null, expiresAt: record.configuration.outputExpiresAt }];
            record.receipt.status = 'SUCCEEDED'; record.receipt.errorCode = null;
            if ('protocolVersion' in record.configuration) {
              (record.receipt as any).actualSpec = { durationSeconds: metadata.durationSeconds, width: metadata.width, height: metadata.height,
                frameRate: metadata.frameRate, mimeType: metadata.mimeType, hasAudio, source: 'measured' };
              (record.receipt as any).deliveryStatus = matches;
              if (matches === 'mismatched') record.receipt.errorCode = 'OUTPUT_SPEC_MISMATCH';
            } else if (matches !== 'matched') fail(502, 'OUTPUT_FAILED', '视频成品与冻结规格不符');
          }
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          record.receipt.status = task.status === 'cancelled' ? 'CANCELLED' : 'FAILED'; record.receipt.errorCode = 'UPSTREAM_FAILED';
          if (task.error !== undefined) record.receipt.upstreamError = { status: 200, body: { error: task.error } };
        } else {
          record.receipt.status = task.status === 'queued' ? 'QUEUED' : 'RUNNING'; record.receipt.errorCode = null;
        }
        record = (await this.store.save(this.normalize(record))).record;
      } catch (error) {
        // Query/download failure keeps the original task and frozen funds. Never POST again.
        if (error instanceof HttpException && !(error instanceof MediaUpstreamException) && [401, 403].includes(error.getStatus())) throw error;
        const current = await this.store.findRequest(record.scope, record.receipt.receiptId);
        if (current && ['QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'].includes(current.receipt.status)) {
          current.receipt.errorCode = downloading ? 'OUTPUT_FAILED' : 'UPSTREAM_FAILED';
          current.receipt.upstreamError = error instanceof MediaUpstreamException ? error.upstreamError : mediaFailure(error);
          record = (await this.store.save(this.normalize(current))).record;
        } else if (current) record = current;
        if (error instanceof MediaUpstreamException) throw error;
      }
    }
    return this.reconcile(record, connection);
  }

  private async reconcile(initial: VideoRealRecord, connection: Sub2apiVideoConnection): Promise<VideoRealRecord> {
    let record = structuredClone(initial);
    if (!['RESERVED', 'RECONCILING'].includes(record.receipt.billingStatus)) return record;
    try {
      const status = await this.billing.status(record.receipt.receiptId);
      if (status === 'RELEASED') {
        record.receipt.billingStatus = 'RELEASED';
      } else if (record.configuration.upstreamRequestId) {
        if (!(await this.store.hasUniqueUpstreamRequest(record))) fail(409, 'BILLING_PENDING', '原视频账单关联不唯一');
        const usage = await this.adapter.usage(connection, record.configuration.upstreamRequestId);
        const dimensions = this.configurationBillingDimensions(record.configuration);
        if (usage.request_id !== record.configuration.upstreamRequestId || usage.status !== 'settled' ||
          usage.model !== record.configuration.modelId || usage.actual_cost_usd === null || usage.video_count !== 1 ||
          usage.duration_seconds !== dimensions.durationSeconds || usage.resolution !== dimensions.resolution) {
          record.receipt.billingStatus = 'RECONCILING';
        } else {
          const actualUsd = new Decimal(usage.actual_cost_usd);
          const actualCny = actualUsd.mul(record.configuration.usdToCnyRate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
          const actualUsdText = actualUsd.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
          record.receipt.billingStatus = 'protocolVersion' in record.configuration
            ? await this.billing.settleNegotiated(record.receipt.receiptId, actualCny, actualUsdText, usage.model, record.configuration.modelId)
            : await this.billing.settleVideo(record.receipt.receiptId, actualCny, actualUsdText, usage.model);
          record.receipt.actualCostCny = actualCny;
        }
      } else {
        record.receipt.billingStatus = 'RECONCILING';
      }
      record = (await this.store.save(this.normalize(record))).record;
    } catch (error) {
      // Missing or contradictory billing evidence is not authorization to release money.
      record.receipt.billingStatus = 'RECONCILING';
      record.receipt.upstreamError = retainMediaFailure(record.receipt.upstreamError, error, 'billing');
      record = (await this.store.save(this.normalize(record))).record;
      if (error instanceof MediaUpstreamException) throw error;
    }
    return record;
  }

  private async releaseUnsubmitted(record: VideoRealRecord) {
    if (!['NOT_DISPATCHED', 'REJECTED'].includes(record.configuration.dispatchState) || record.receipt.status !== 'FAILED') return;
    try {
      const status = await this.billing.status(record.receipt.receiptId).catch(error => {
        // status() uses BILLING_PENDING for an absent journal row; release() then
        // atomically observes absence or refunds the original reservation.
        if (error instanceof HttpException && (error.getResponse() as { error?: { code?: string } }).error?.code === 'BILLING_PENDING') return null;
        throw error;
      });
      if (status === 'SETTLED' || status === 'RECONCILING') {
        record.receipt.billingStatus = 'RECONCILING';
        await this.store.save(this.normalize(record));
        return;
      }
      await this.billing.release(record.receipt.receiptId);
      record.receipt.billingStatus = 'RELEASED';
    } catch (error) {
      record.receipt.billingStatus = 'RECONCILING';
      if (record.receipt.execution) record.receipt.billingError = mediaFailure(error);
      else record.receipt.upstreamError = retainMediaFailure(record.receipt.upstreamError, error, 'release');
    }
    await this.store.save(this.normalize(record));
  }

  private async saveDispatch(desired: VideoRealRecord): Promise<VideoRealRecord> {
    let candidate = structuredClone(desired);
    for (let attempt = 0; attempt < 3; attempt++) {
      let saved: Awaited<ReturnType<MediaVideoRealStore['save']>>;
      try { saved = await this.store.save(this.normalize(candidate)); }
      catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 409 ||
          (error.getResponse() as { error?: { code?: string } }).error?.code !== 'BILLING_PENDING') throw error;
        // Preserve the original task, but never attach another receipt's bill.
        // With no trustworthy billing ID recovery must leave funds reconciling.
        desired = structuredClone(desired);
        desired.configuration.upstreamRequestId = null;
        desired.receipt.billingStatus = 'RECONCILING'; desired.receipt.errorCode = 'BILLING_PENDING';
        candidate.configuration.upstreamRequestId = null;
        candidate.receipt.billingStatus = 'RECONCILING'; candidate.receipt.errorCode = 'BILLING_PENDING';
        continue;
      }
      if (saved.updated) return saved.record;
      const current = saved.record;
      if (!['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(current.receipt.status)) return current;
      if (current.configuration.upstreamTaskId && desired.configuration.upstreamTaskId && current.configuration.upstreamTaskId !== desired.configuration.upstreamTaskId) videoStorageUnavailable();
      candidate = { ...current, configuration: { ...current.configuration, upstreamTaskId: desired.configuration.upstreamTaskId ?? current.configuration.upstreamTaskId,
        upstreamRequestId: desired.configuration.upstreamRequestId ?? current.configuration.upstreamRequestId, dispatchState: desired.configuration.dispatchState },
        receipt: { ...desired.receipt, billingStatus: ['SETTLED', 'RELEASED'].includes(current.receipt.billingStatus) ? current.receipt.billingStatus : desired.receipt.billingStatus } };
    }
    return videoStorageUnavailable();
  }

  private async owned(claims: ClientEmploymentClaims, receiptId: string) {
    await this.authorize(claims, false);
    this.parse(ResourceIdSchema, receiptId);
    const record = await this.store.findRequest(this.scope(claims), receiptId);
    if (!record) fail(404, 'MEDIA_NOT_FOUND', '视频回执不存在');
    await this.requireProfile(claims, record.configuration, false, 'video-query', record.configuration.modelId);
    return record;
  }

  private async authorize(claims: VideoRecoveryOwner, execution: boolean) {
    if (execution) this.assertRealEnabled();
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { id: claims.memberId, enterpriseId: claims.enterpriseId, userId: claims.sub, user: { status: 'ACTIVE' }, enterprise: { status: 'ACTIVE' } }, select: { departmentId: true },
    }).catch(cause => videoStorageUnavailable(cause));
    if (!member) fail(403, 'MEDIA_FORBIDDEN', '成员无视频访问权限');
    const subscription = await this.prisma.subscription.findFirst({ where: clientSubscriptionAccessWhere({
      enterpriseId: claims.enterpriseId, memberId: claims.memberId, departmentId: member.departmentId, role: 'MEMBER',
    }, claims.subscriptionId), select: { id: true } }).catch(cause => videoStorageUnavailable(cause));
    if (!subscription) fail(403, 'MEDIA_FORBIDDEN', '订阅已失效或视频授权已撤销');
  }

  private async requireProfile(claims: VideoRecoveryOwner,
    input: (Pick<MediaVideoGatewayQuoteRequest, 'profileId' | 'configVersion' | 'operation' | 'parameters'> |
      Pick<MediaVideoGatewayQuoteRequestV3, 'protocolVersion' | 'profileId' | 'configVersion' | 'operation' | 'requestedSpec'>) & { referenceIds?: string[]; videoReferenceIds?: string[] }, execution: boolean,
    stage: 'video-upload' | 'video-quote' | 'video-submit' | 'video-query' | 'video-content', frozenModelId?: string) {
    const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId: input.profileId } });
    const v3 = 'protocolVersion' in input;
    // Existing V3 tasks retain their frozen spec after capability edits. Grants and model identity still apply.
    const recovering = v3 && !execution && frozenModelId !== undefined;
    if (!row || row.kind !== 'video' || (!v3 && row.modelId !== 'minimax-h3') ||
      (recovering ? row.modelId !== frozenModelId : row.configVersion !== input.configVersion ||
        !row.enabled || !row.verified || row.executionMode !== 'async-query' || !row.operations.includes(input.operation))) {
      fail(409, 'CONFIG_CHANGED', '原视频 Profile 已变更或撤销', { field: 'profileId', stage, recovery: 'refresh_capabilities' });
    }
    const config = await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId: claims.enterpriseId } });
    const raw = config?.mediaPolicy as Record<string, unknown> | null;
    const parsed = MediaVideoAuthorizationSchema.safeParse(raw?.video ?? {});
    if (!parsed.success) fail(403, 'MEDIA_FORBIDDEN', '企业视频授权无效');
    const policy = parsed.data;
    if (!policy.enabledProfileIds.includes(input.profileId)) fail(403, 'MEDIA_FORBIDDEN', '企业视频授权已撤销', { field: 'profileId', stage, recovery: 'refresh_capabilities' });
    const capabilities = this.parse(MediaVideoCapabilitiesSchema, row.capabilities);
    if (execution && input.operation === 'video-to-video' && (!capabilities.supportsVideoToVideo
      || !capabilities.maxVideoReferenceCount || !capabilities.maxVideoReferenceBytes || !capabilities.videoReferenceMimeTypes?.length
      || (input.videoReferenceIds?.length ?? 0) > capabilities.maxVideoReferenceCount)) {
      fail(422, 'INVALID_REFERENCE', '当前 Profile 不支持视频生视频或参考视频数量超限', { field: 'videoReferenceIds', stage, recovery: 'revise_request' });
    }
    if (execution && input.operation === 'image-to-video' && input.referenceIds &&
      (!capabilities.supportsImageToVideo || input.referenceIds.length > capabilities.maxReferenceCount)) {
      fail(422, 'INVALID_REFERENCE', `参考图数量超过当前 Profile 上限 ${capabilities.maxReferenceCount}`, {
        field: 'referenceIds', stage, recovery: 'revise_request',
      });
    }
    const parameters = v3 ? null : (input as Pick<MediaVideoGatewayQuoteRequest, 'parameters'>).parameters;
    const duration = v3 ? (input as Pick<MediaVideoGatewayQuoteRequestV3, 'requestedSpec'>).requestedSpec.durationSeconds : parameters.durationSeconds;
    if (execution && !isVideoDurationInRange(duration, capabilities.durationRange)) {
      fail(400, 'INVALID_PARAMETER', `视频时长须为 ${capabilities.durationRange.minimum} 至 ${capabilities.durationRange.maximum} 秒`, {
        field: v3 ? 'requestedSpec.durationSeconds' : 'parameters.durationSeconds', stage, recovery: 'revise_request',
        submissionState: 'not_submitted', billingState: 'not_reserved',
      });
    }
    if (!v3 && (parameters.durationSeconds !== 4 || parameters.resolution !== '720p' || parameters.aspectRatio !== '16:9' || parameters.frameRate !== 24 || !parameters.audio || parameters.outputFormat !== 'video/mp4' ||
      !capabilities.durationsSeconds.includes(4) || !capabilities.resolutions.includes('720p') || !capabilities.aspectRatios.includes('16:9') ||
      !capabilities.frameRates.includes(24) || !capabilities.supportsAudio || !capabilities.outputFormats.includes('video/mp4') ||
      input.operation === 'text-to-video' && !capabilities.supportsTextToVideo || input.operation === 'image-to-video' &&
      (!capabilities.supportsImageToVideo || capabilities.maxReferenceCount < 1))) fail(400, 'INVALID_PARAMETER', '视频 Profile 不支持冻结规格', { field: 'parameters', stage, recovery: 'revise_request' });
    if (execution) {
      const runtime = v3 && 'getRuntimeVideoV3' in this.videoConfig
        ? await (this.videoConfig as MediaVideoConfigService & { getRuntimeVideoV3(enterpriseId: string): Promise<any> }).getRuntimeVideoV3(claims.enterpriseId)
        : await this.videoConfig.getRuntimeVideo(claims.enterpriseId);
      if (!runtime.executionAvailable || (runtime as { executionMode?: string }).executionMode !== 'real' ||
        !runtime.profiles.some((profile: any) => profile.profileId === input.profileId && profile.configVersion === input.configVersion &&
          profile.operations.includes(input.operation) && (!v3 || profile.authorized && profile.adapter?.available && profile.adapter.operations.includes(input.operation)))) {
        fail(v3 ? 503 : 403, v3 ? 'ADAPTER_UNAVAILABLE' : 'MEDIA_FORBIDDEN', v3 ? '当前视频适配器未就绪' : '当前运行时未授权真实视频');
      }
    }
    return { modelId: row.modelId, capabilities };
  }

  private async references(claims: ClientEmploymentClaims, ids: string[], maxBytes: number) {
    const references = await Promise.all(ids.map(async id => {
      const reference = await this.store.findReference(this.scope(claims), id);
      if (!reference) fail(404, 'MEDIA_NOT_FOUND', '视频参考图不存在');
      if (Date.parse(reference.expiresAt) <= Date.now()) fail(410, 'REFERENCE_EXPIRED', '视频参考图已过期');
      if (reference.byteLength > maxBytes) fail(400, 'INVALID_REFERENCE', '参考图超过 Profile 限制');
      return reference;
    }));
    if (references.reduce((total, reference) => total + reference.byteLength, 0) > MAX_MEDIA_REFERENCE_TOTAL_BYTES) {
      fail(413, 'INVALID_REFERENCE', '参考图总大小超过 100 MiB');
    }
    return references;
  }

  private async frozenConnection(expected: string) {
    const connection = await this.adapter.connection();
    if (connection.fingerprint !== expected) fail(409, 'CONFIG_CHANGED', '视频连接已变更，原任务不得切换路由');
    return connection;
  }

  private referenceIds(input: MediaVideoRealQuoteRequest): string[] {
    return [...input.referenceIds, ...('protocolVersion' in input ? input.videoReferenceIds ?? [] : [])];
  }

  private async videoReferences(claims: ClientEmploymentClaims, input: MediaVideoRealQuoteRequest,
    capabilities: { maxVideoReferenceBytes?: number; videoReferenceMimeTypes?: string[] }, connectionFingerprint: string) {
    const ids = 'protocolVersion' in input ? input.videoReferenceIds ?? [] : [];
    return Promise.all(ids.map(async id => {
      const reference = await this.store.findVideoReference(this.scope(claims), id);
      if (!reference) fail(404, 'MEDIA_NOT_FOUND', '参考视频不存在或不属于当前用户和订阅');
      if (Date.parse(reference.value.expiresAt) <= Date.now()) fail(410, 'REFERENCE_EXPIRED', '参考视频已过期，请重新上传');
      if (reference.value.profileId !== input.profileId || reference.value.configVersion !== input.configVersion
        || reference.connectionFingerprint !== connectionFingerprint) fail(409, 'CONFIG_CHANGED', '参考视频的 Profile 或算力连接已变更，请重新上传');
      if (reference.value.byteLength > (capabilities.maxVideoReferenceBytes ?? 0)
        || !capabilities.videoReferenceMimeTypes?.includes(reference.value.mimeType)) fail(422, 'INVALID_REFERENCE', '参考视频超过当前 Profile 大小或格式限制');
      return reference;
    }));
  }

  private normalize(record: VideoRealRecord): VideoRealRecord {
    const active = ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'QUEUED', 'RUNNING'].includes(record.receipt.status);
    record.receipt.pollAfterMs = active ? 2000 : null;
    record.receipt.recovery = { canCancel: false, canQuery: active || ['RESERVED', 'RECONCILING'].includes(record.receipt.billingStatus),
      canDownload: ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status) && record.receipt.outputs.some(o => !!o.expiresAt && Date.parse(o.expiresAt) > Date.now()) };
    if (record.receipt.execution) {
      record.receipt.clientActions = mediaClientActions(record.receipt.execution, record.receipt.fileStatus ?? 'pending',
        ['RESERVED', 'RECONCILING'].includes(record.receipt.billingStatus));
      record.receipt.recovery.canQuery = record.receipt.clientActions.shouldPoll;
      record.receipt.recovery.canCancel = !!record.configuration.cancelSupported && active && !!record.configuration.upstreamTaskId && record.receipt.execution.isFinal !== true;
      record.receipt.pollAfterMs = record.receipt.clientActions.shouldPoll
        ? record.receipt.clientActions.pollPurpose === 'billing' ? 15000 : 3000 : null;
    }
    return record;
  }

  private async applyContract(initial: VideoRealRecord, result: LongdaoMediaResult, assertHeld = () => {}): Promise<VideoRealRecord> {
    assertHeld();
    let record = structuredClone(initial);
    const incoming = executionEvidence(result);
    if (incoming.submissionStatus === 'unobserved') {
      record.receipt.execution = mergeExecutionEvidence(record.receipt.execution!, incoming);
      record.receipt.upstreamError = incoming.operationError;
      return (await this.store.save(this.normalize(record))).record;
    }
    const execution = mergeExecutionEvidence(record.receipt.execution!, incoming);
    if (!closedSubmission(execution) && result.contract.model && result.contract.model !== record.configuration.modelId ||
        execution.submissionStatus === 'accepted' && !execution.taskId) {
      record.configuration.upstreamTaskId ??= execution.taskId;
      record.receipt.execution!.taskId ??= execution.taskId;
      record.receipt.execution!.operationError = { status: 502, body: MediaJsonValueSchema.parse({ error: { code: 'UPSTREAM_FAILED', message: '视频回执模型或任务编号无效', details: result.contract } }) };
      record.receipt.upstreamError = record.receipt.execution!.operationError;
      return (await this.store.save(this.normalize(record))).record;
    }
    record.receipt.execution = execution;
    if (execution.taskId) record.configuration.upstreamTaskId = execution.taskId;
    record.receipt.upstreamError = executionFailure(execution, result.httpStatus);
    if (closedSubmission(execution)) {
      record.configuration.dispatchState = 'REJECTED'; record.receipt.status = 'FAILED';
      record.receipt.fileStatus = 'unavailable'; record.receipt.errorCode = 'UPSTREAM_FAILED';
    } else if (execution.generationStatus === 'failed' || execution.generationStatus === 'cancelled') {
      record.receipt.status = execution.generationStatus === 'failed' ? 'FAILED' : 'CANCELLED';
      record.receipt.fileStatus = 'unavailable'; record.receipt.errorCode = 'UPSTREAM_FAILED';
    } else if (!record.receipt.outputs.length) {
      record.receipt.status = execution.submissionStatus === 'submitting' ? 'SUBMITTING'
        : execution.submissionStatus === 'unknown' ? 'SUBMISSION_UNKNOWN' : execution.generationStatus === 'queued' ? 'QUEUED' : 'RUNNING';
      if (execution.submissionStatus === 'accepted') {
        record.configuration.dispatchState = 'ACCEPTED';
        if (record.receipt.errorCode === 'SUBMISSION_UNKNOWN') record.receipt.errorCode = null;
      }
    }
    const revision = record.revision;
    const saved = await this.store.save(this.normalize(record));
    record = saved.record;
    if (!saved.updated || record.revision !== revision + 1) return record;
    try {
      const billingStatus = await this.billing.status(record.receipt.receiptId);
      if (billingStatus === 'SETTLED' || billingStatus === 'RELEASED') {
        record.receipt.billingStatus = billingStatus; delete record.receipt.billingError;
        return (await this.store.save(this.normalize(record))).record;
      }
      if (execution.billing.status === 'not_charged') {
        assertHeld();
        await this.billing.release(record.receipt.receiptId); record.receipt.billingStatus = 'RELEASED';
      } else if (execution.billing.status === 'settled') {
        if (execution.generationStatus !== 'completed' || !await this.store.hasUniqueUpstreamRequest(record)) fail(409, 'BILLING_PENDING', '视频收费证据与原任务不一致');
        const usage = await this.adapter.usage(await this.frozenConnection(record.configuration.connectionFingerprint), execution.requestId);
        const dimensions = this.configurationBillingDimensions(record.configuration);
        if (usage.status !== 'settled' || usage.request_id !== execution.requestId || usage.model !== record.configuration.modelId ||
            usage.video_count !== 1 || usage.actual_cost_usd === null || usage.duration_seconds !== dimensions.durationSeconds ||
            usage.resolution !== dimensions.resolution || !new Decimal(usage.actual_cost_usd).eq(execution.billing.actualCostUsd!)) fail(409, 'BILLING_PENDING', '视频金额证据与冻结规格不一致');
        const usd = new Decimal(usage.actual_cost_usd);
        const cny = usd.mul(record.configuration.usdToCnyRate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
        assertHeld();
        record.receipt.billingStatus = await this.billing.settleNegotiated(record.receipt.receiptId, cny,
          usd.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6), usage.model, record.configuration.modelId);
        if (record.receipt.billingStatus === 'SETTLED') record.receipt.actualCostCny = cny;
      } else record.receipt.billingStatus = 'RECONCILING';
      delete record.receipt.billingError;
    } catch (error) { record.receipt.billingStatus = 'RECONCILING'; record.receipt.billingError = mediaFailure(error); }
    return (await this.store.save(this.normalize(record))).record;
  }

  private async recoverContract(claims: VideoRecoveryOwner, initial: VideoRealRecord, assertHeld = () => {}): Promise<VideoRealRecord> {
    assertHeld();
    let record = structuredClone(initial);
    if ((closedSubmission(record.receipt.execution!) || ['failed', 'cancelled'].includes(record.receipt.execution!.generationStatus!)) && record.receipt.billingStatus === 'RELEASED' ||
        ['available', 'expired'].includes(record.receipt.fileStatus!) && ['SETTLED', 'RELEASED'].includes(record.receipt.billingStatus)) return record;
    if (record.configuration.dispatchState === 'NOT_DISPATCHED') {
      if (record.submissionDeadline.getTime() > Date.now()) return record;
      record.receipt.status = 'FAILED'; record.receipt.errorCode = 'BILLING_PENDING';
      record.receipt.execution!.submissionStatus = 'not_submitted';
      record.receipt.fileStatus = 'unavailable'; record.receipt.execution!.billing = { status: 'not_charged', actualCostUsd: '0' };
      const closed = await this.store.save(this.normalize(record));
      if (closed.updated) await this.releaseUnsubmitted(closed.record);
      return (await this.store.findRequest(record.scope, record.receipt.receiptId)) ?? closed.record;
    }
    try {
      if (record.receipt.execution!.billing.status === 'not_charged' && record.receipt.execution!.generationStatus !== 'completed') {
        try {
          assertHeld();
          await this.billing.release(record.receipt.receiptId);
          record.receipt.billingStatus = 'RELEASED'; delete record.receipt.billingError;
        } catch (error) { record.receipt.billingStatus = 'RECONCILING'; record.receipt.billingError = mediaFailure(error); }
        return (await this.store.save(this.normalize(record))).record;
      }
      const connection = await this.frozenConnection(record.configuration.connectionFingerprint);
      if (record.receipt.execution!.generationStatus !== 'completed' || !['SETTLED', 'RELEASED'].includes(record.receipt.billingStatus)) {
        assertHeld();
        const result = await this.adapter.queryContract(connection, record.receipt.execution!.requestId,
          closedSubmission(record.receipt.execution!) ? null : record.configuration.upstreamTaskId);
        record = await this.applyContract(record, result, assertHeld);
      }
      if (record.receipt.execution?.generationStatus === 'completed' && record.configuration.upstreamTaskId && !record.receipt.outputs.length) {
        try {
          await this.authorize(claims, false);
          await this.requireProfile(claims, record.configuration, false, 'video-content', record.configuration.modelId);
          const outputId = `${record.receipt.receiptId}-output-1`;
          record.configuration.outputExpiresAt ??= new Date(Date.now() + OUTPUT_TTL).toISOString();
          record = (await this.store.save(this.normalize(record))).record;
          if (Date.parse(record.configuration.outputExpiresAt) <= Date.now()) {
            record.receipt.status = 'RESULT_EXPIRED'; record.receipt.fileStatus = 'expired';
          } else {
            assertHeld();
            const { hasAudio, ...metadata } = await this.cache.saveOutput(record.scope, outputId,
              await this.adapter.rawContent(connection, record.configuration.upstreamTaskId!, this.outputFormat(record.configuration)), record.configuration.outputExpiresAt);
            record.receipt.outputs = [{ ...metadata, outputId, kind: 'video', thumbnailOutputId: null, expiresAt: record.configuration.outputExpiresAt }];
            if (!('protocolVersion' in record.receipt) && this.outputMatches(record.configuration, metadata, hasAudio) !== 'matched') {
              record.receipt.outputs = []; fail(502, 'OUTPUT_SPEC_MISMATCH', '视频成品规格与请求不一致');
            }
            record.receipt.status = 'SUCCEEDED'; record.receipt.fileStatus = 'available'; record.receipt.errorCode = null;
            if (record.receipt.execution!.operation === 'download') {
              delete record.receipt.execution!.operationError;
              record.receipt.upstreamError = executionFailure(record.receipt.execution!, 200);
            }
            if ('protocolVersion' in record.receipt) {
              record.receipt.actualSpec = { durationSeconds: metadata.durationSeconds, width: metadata.width, height: metadata.height,
                frameRate: metadata.frameRate, mimeType: metadata.mimeType, hasAudio, source: 'measured' };
              record.receipt.deliveryStatus = this.outputMatches(record.configuration, metadata, hasAudio);
              if (record.receipt.deliveryStatus === 'mismatched') record.receipt.errorCode = 'OUTPUT_SPEC_MISMATCH';
            }
          }
        } catch (error) {
          record.receipt.fileStatus = 'download_failed'; record.receipt.errorCode = 'OUTPUT_FAILED';
          record.receipt.execution!.operation = 'download';
          record.receipt.execution!.operationError = mediaFailure(error); record.receipt.upstreamError = mediaFailure(error);
        }
        record = (await this.store.save(this.normalize(record))).record;
      }
    } catch (error) {
      record.receipt.execution!.operation = 'query';
      record.receipt.execution!.operationError = mediaFailure(error); record.receipt.upstreamError = mediaFailure(error);
      record = (await this.store.save(this.normalize(record))).record;
    }
    return record;
  }

  private snapshot(input: VideoRealRecord): MediaVideoRealReceipt {
    const record = this.normalize(structuredClone(input));
    if (['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(record.receipt.status) && record.receipt.outputs.length && record.receipt.outputs.every(o => !o.expiresAt || Date.parse(o.expiresAt) <= Date.now())) {
      record.receipt.status = 'RESULT_EXPIRED'; record.receipt.errorCode = 'RESULT_EXPIRED';
      if (record.receipt.execution) record.receipt.fileStatus = 'expired';
      this.normalize(record);
    }
    return MediaVideoRealReceiptSchema.parse(record.receipt);
  }

  private assertReplay(input: MediaVideoRealRequest, record: VideoRealRecord) {
    if (record.configuration.quoteId !== input.quoteId) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同视频报价');
    if (record.semanticSha256 !== this.semanticHash(input, record.referenceHashes, record.scope)) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键请求语义哈希不匹配');
    if (JSON.stringify(record.referenceIds) !== JSON.stringify(this.referenceIds(input))) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键参考素材不匹配');
  }

  private semanticHash(input: MediaVideoRealQuoteRequest, referenceHashes: string[], scope = '') {
    if ('protocolVersion' in input) return hash(JSON.stringify({ semanticHashVersion: 3, protocolVersion: 3,
      scope, adapter: VIDEO_REAL_ADAPTER, adapterVersion: '3',
      profileId: input.profileId, configVersion: input.configVersion, operation: input.operation, specRevision: input.specRevision,
      referenceIds: input.referenceIds.map((id, index) => ({ id, hash: referenceHashes[index] })), briefSha256: hash(input.creativeBrief), requestedSpec: input.requestedSpec,
      ...(input.videoReferenceIds?.length ? { videoReferenceIds: input.videoReferenceIds.map((id, index) => ({ id, hash: referenceHashes[input.referenceIds.length + index] })) } : {}),
      parameterSources: input.parameterSources ? Object.fromEntries(Object.entries(input.parameterSources).sort(([a], [b]) => a.localeCompare(b))) : null,
      omittedSpecFields: ['durationSeconds', 'aspectRatio', 'resolution', 'width', 'height', 'frameRate', 'audio', 'outputFormat']
        .filter(field => !(field in input.requestedSpec)) }));
    return hash(JSON.stringify({ profileId: input.profileId, configVersion: input.configVersion, operation: input.operation,
      referenceIds: input.referenceIds, referenceHashes, briefSha256: hash(input.creativeBrief), parameters: (input as MediaVideoGatewayQuoteRequest).parameters }));
  }

  private billingDimensions(input: MediaVideoRealQuoteRequest) {
    if (!('protocolVersion' in input)) {
      const parameters = (input as MediaVideoGatewayQuoteRequest).parameters;
      return { durationSeconds: parameters.durationSeconds, resolution: parameters.resolution };
    }
    if (input.requestedSpec.durationSeconds === undefined) fail(400, 'MISSING_SPEC', '视频报价缺少 durationSeconds', { field: 'requestedSpec.durationSeconds', stage: 'video-quote' });
    const resolution = input.requestedSpec.resolution ?? (input.requestedSpec.width !== undefined && input.requestedSpec.height !== undefined
      ? `${input.requestedSpec.width}x${input.requestedSpec.height}` : undefined);
    if (!resolution) fail(400, 'MISSING_SPEC', '视频报价缺少 resolution 或 width/height', { field: 'requestedSpec.resolution', stage: 'video-quote' });
    return { durationSeconds: input.requestedSpec.durationSeconds, resolution };
  }

  private configurationBillingDimensions(configuration: VideoRealRecord['configuration']) {
    return 'protocolVersion' in configuration
      ? { durationSeconds: configuration.effectiveSpec.durationSeconds!, resolution: configuration.effectiveSpec.resolution ?? `${configuration.effectiveSpec.width}x${configuration.effectiveSpec.height}` }
      : { durationSeconds: (configuration as any).parameters.durationSeconds, resolution: (configuration as any).parameters.resolution };
  }

  private sameSpec(input: MediaVideoRealRequest, configuration: VideoRealRecord['configuration']): boolean {
    return 'protocolVersion' in input && 'protocolVersion' in configuration
      ? input.specRevision === configuration.specRevision && JSON.stringify(input.requestedSpec) === JSON.stringify(configuration.requestedSpec)
      : !('protocolVersion' in input) && !('protocolVersion' in configuration) &&
        JSON.stringify((input as MediaVideoGatewayRequest).parameters) === JSON.stringify((configuration as any).parameters);
  }

  private requiresAudio(configuration: VideoRealRecord['configuration']): boolean {
    return 'protocolVersion' in configuration ? configuration.effectiveSpec.audio === true : (configuration as any).parameters.audio;
  }

  private outputFormat(configuration: VideoRealRecord['configuration']): string {
    return 'protocolVersion' in configuration ? configuration.effectiveSpec.outputFormat ?? 'video/mp4' : (configuration as any).parameters.outputFormat;
  }

  private outputMatches(configuration: VideoRealRecord['configuration'], metadata: { byteLength: number; mimeType: string; durationSeconds: number; width: number; height: number; frameRate: number }, hasAudio: boolean | null): 'matched' | 'mismatched' | 'unknown' {
    if (!('protocolVersion' in configuration)) return this.acceptableH3Output(metadata) && (!(configuration as any).parameters.audio || hasAudio === true) ? 'matched' : 'mismatched';
    const spec = configuration.effectiveSpec;
    const ratio = spec.aspectRatio?.split(':').map(Number);
    const expectedResolution = spec.resolution?.match(/^([1-9]\d*)p$/i);
    const unknown = spec.audio === undefined || hasAudio === null || spec.resolution !== undefined && !expectedResolution;
    // Container duration may include a final partial frame; allow at most one measured video frame.
    const durationTolerance = 1 / metadata.frameRate + 1e-6;
    // sub2api selects fps upstream, so requested frameRate is not a delivery constraint.
    const matches = metadata.byteLength > 0 && metadata.byteLength <= 256 * 1024 * 1024 &&
      (spec.outputFormat === undefined || metadata.mimeType === spec.outputFormat) &&
      (spec.durationSeconds === undefined || Math.abs(metadata.durationSeconds - spec.durationSeconds) <= durationTolerance) &&
      (spec.width === undefined || metadata.width === spec.width && metadata.height === spec.height) &&
      (ratio === undefined || BigInt(metadata.width) * BigInt(ratio[1]) === BigInt(metadata.height) * BigInt(ratio[0])) &&
      (!expectedResolution || Math.min(metadata.width, metadata.height) === Number(expectedResolution[1])) &&
      (spec.audio === undefined || hasAudio === null || spec.audio === hasAudio);
    return !matches ? 'mismatched' : unknown ? 'unknown' : 'matched';
  }

  private acceptableH3Output(metadata: { byteLength: number; mimeType: string; durationSeconds: number; width: number; height: number; frameRate: number }): boolean {
    // A6's observed minimax-h3 768P response is 1344x768 even though the
    // compatibility request also carries size=1280x720. Keep measured metadata.
    // The relay reports a 4s request for observed 15s H3 outputs. Accept this
    // provider variant while retaining measured duration and frozen 4s billing.
    const durationMatches = [4, 15].some(seconds => Math.abs(metadata.durationSeconds - seconds) <= 0.5);
    const dimensionsMatch = metadata.width === 1280 && metadata.height === 720 ||
      metadata.width === 1344 && metadata.height === 768;
    return metadata.byteLength > 0 && metadata.byteLength <= 256 * 1024 * 1024 && metadata.mimeType === 'video/mp4' &&
      durationMatches && dimensionsMatch && Math.abs(metadata.frameRate - 24) <= 0.1;
  }
  private scope(claims: VideoRecoveryOwner) { return JSON.stringify([claims.enterpriseId, claims.subscriptionId, claims.memberId, claims.sub]); }
  private parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail(400, 'INVALID_PARAMETER', '视频参数无效', { cause: exceptionDetails(parsed.error) });
    return parsed.data;
  }
}
