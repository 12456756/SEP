import { HttpException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ComputeConnectionService } from '../compute-integration/compute-connection.service';
import { ComputeMediaService, type ComputeMediaSnapshot } from '../compute-integration/compute-media.service';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingService } from '../setting/setting.service';
import { MediaConfigService } from '../media-config/media-config.service';
import { clientSubscriptionAccessWhere } from '../client/client-subscription-access';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { MAX_MEDIA_REFERENCE_TOTAL_BYTES, effectiveImageLimits, IMAGE_REFERENCE_MAX_BYTES, MediaAuthorizationSchema, MediaCapabilitiesSchema } from 'shared';
import type { MediaImageSpecV3, MediaRealAnyQuoteRequest, MediaRealAnyRequest, MediaRealQuoteRequestV3, MediaRealReceipt, MediaRealErrorCode, MediaUpstreamError } from 'shared';
import { MediaJsonValueSchema, MediaRealAnyQuoteRequestSchema, MediaRealAnyRequestSchema, MediaRealAnyReceiptSchema } from 'shared';
import { inspectReferenceImage } from './media-reference-image';
import { MediaByteCacheService } from './media-byte-cache.service';
import { MediaRealBillingService } from './media-real-billing.service';
import { MediaRealStore, RealRequestRecord, realMediaStorageUnavailable } from './media-real.store';
import { ImageDispatchError, resolveSub2apiImageSpec, SUB2API_IMAGE_ADAPTER_VERSION, Sub2apiImageAdapter } from './sub2api-image.adapter';
import { isSupportedImageModel } from './image-model-contract';
import { mediaRealSemanticHash } from './media-real-semantics';
import { MediaUpstreamException, mediaFailure, mediaOperationException, retainMediaFailure } from '../../common/errors/media-upstream.exception';
import { exceptionDetails } from '../../common/errors/error-diagnostics';
import { hasFailedMediaQuery, mediaPollAfter, updateMediaWait, withMediaWait } from './media-upstream-retry';
import { closedSubmission, executionEvidence, executionFailure, IMAGE_SUBMISSION_BUDGET_MS, MEDIA_SAVE_GRACE_MS, mediaClientActions, mediaOperationFailure, mergeExecutionEvidence, recoverableTaskId,
  type LongdaoMediaResult } from './longdao-media-contract';

const REFERENCE_TTL = 15 * 60_000;
const QUOTE_TTL = 60_000;
const OUTPUT_TTL = 24 * 60 * 60_000;
type MediaErrorDetails = { cause?: unknown; field?: string; stage?: 'image-authorization' | 'image-quote' | 'image-submit' | 'image-query' | 'image-content' | 'quote' | 'submit'; recovery?: string;
  source?: 'request' | 'adapter' | 'platform'; reason?: string; submissionState?: 'not_submitted'; billingState?: 'not_reserved'; retryable?: boolean };
const error = (status: number, code: MediaRealErrorCode, message: string, details: MediaErrorDetails = {}): never => {
  throw new HttpException({ error: { code, message, type: status >= 500 ? 'server_error' : 'invalid_request_error', source: 'platform', param: null, ...details } }, status);
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class MediaRealService {
  private readonly recovering = new Map<string, Promise<RealRequestRecord>>();
  private reconciling = false;
  private reconcileAfterId: string | undefined;
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly setting: SettingService,
    private readonly mediaConfig: MediaConfigService,
    private readonly adapter: Sub2apiImageAdapter,
    private readonly cache: MediaByteCacheService,
    private readonly billing: MediaRealBillingService,
    private readonly store: MediaRealStore,
    @Optional() private readonly connections?: ComputeConnectionService,
    @Optional() private readonly computeMedia?: ComputeMediaService,
  ) {}

  async assertRealEnabled(enterpriseId?: string) {
    if (this.config.get<string>('MEDIA_GATEWAY_REAL_ENABLED') !== 'true') error(503, 'MEDIA_REAL_DISABLED', '真实图片执行尚未启用');
    if (!enterpriseId || !this.connections || !this.computeMedia) throw new ServiceUnavailableException({
      code: 'COMPUTE_ENTERPRISE_CONTEXT_REQUIRED', message: '图片调用缺少企业算力连接，无法使用企业凭证',
    });
    await this.connections.resolve(enterpriseId, 'image');
  }

  async profiles(claims: ClientEmploymentClaims, protocolVersion: 1 | 3 = 1) {
    await this.authorize(claims);
    if (protocolVersion === 3) return this.mediaConfig.getRuntimeMediaV3(claims.enterpriseId);
    return { mock: false, protocolVersion: 1, persistence: 'database', profiles: (await this.allowedProfiles(claims.enterpriseId, 1)) };
  }

  async uploadReference(claims: ClientEmploymentClaims, file?: Express.Multer.File, fields?: unknown) {
    await this.authorize(claims);
    if (fields && Object.keys(fields as object).length) error(400, 'INVALID_REFERENCE', '参考上传不接受额外字段');
    if (!file || !Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length) error(400, 'INVALID_REFERENCE', '需要 JPEG、PNG 或 WebP 文件');
    const { mimeType, width, height } = await inspectReferenceImage(file.buffer, IMAGE_REFERENCE_MAX_BYTES, file.mimetype);
    const expiresAt = new Date(Date.now() + REFERENCE_TTL).toISOString();
    const reference = await this.store.saveReference(this.scope(claims), {
      mock: false, expiresAt, mimeType, byteLength: file.buffer.length, sha256: sha(file.buffer), width, height,
    });
    await this.cache.put('reference', this.scope(claims), reference.referenceId, file.buffer, expiresAt);
    return reference;
  }

  async quote(claims: ClientEmploymentClaims, raw: MediaRealAnyQuoteRequest) {
    await this.authorize(claims);
    const dto = this.parse(MediaRealAnyQuoteRequestSchema, raw);
    const effectiveSpec = resolveSub2apiImageSpec(dto, 'quote');
    const adapterInput = this.adapterInput(dto, effectiveSpec);
    const referenceHashes = await this.referenceHashes(claims, dto.referenceIds);
    const profile = await this.requireProfile(claims.enterpriseId, dto, 'image-quote');
    const enterpriseConnection = await this.computeMedia.connection(claims.enterpriseId, 'image');
    const snapshot = { connection: enterpriseConnection, fingerprint: enterpriseConnection.fingerprint };
    const price = await this.adapter.pricing(adapterInput, profile.modelId, snapshot.connection);
    const rate = null;
    const amountCny = price.amount_cny!;
    if (new Decimal(amountCny).lt(0)) error(503, 'PRICE_UNAVAILABLE', '图片报价金额无效');
    const funding = await this.billing.quoteFunding(claims, amountCny);
    const expiresAt = new Date(Math.min(Date.now() + QUOTE_TTL, Date.parse(price.expires_at))).toISOString();
    const semanticSha256 = this.semanticHash(dto, referenceHashes, this.scope(claims));
    return this.store.saveQuote(this.scope(claims), {
      mock: false, expiresAt, semanticSha256, pricingStatus: 'quoted', amountCny,
      pricingVersion: price.pricing_version, billingStatus: 'NOT_RESERVED', funding,
      ...(!('parameters' in dto) ? { protocolVersion: 3 as const, semanticHashVersion: 3 as const,
        specRevision: (dto as MediaRealQuoteRequestV3).specRevision, profileId: profile.profileId, configVersion: profile.configVersion,
        modelId: profile.modelId, adapterVersion: SUB2API_IMAGE_ADAPTER_VERSION, amountUsd: null,
        connectionFingerprint: snapshot!.fingerprint,
        effectiveSpec, billingDimensions: { size: effectiveSpec.size!, count: effectiveSpec.count!, quality: effectiveSpec.quality! },
        normalizationNotes: this.normalizationNotes(dto, effectiveSpec) } : {}),
    }, rate, snapshot.fingerprint, { ...enterpriseConnection.snapshot, quoteId: price.quote_id });
  }

  async submit(claims: ClientEmploymentClaims, raw: MediaRealAnyRequest): Promise<MediaRealReceipt> {
    await this.authorize(claims, false);
    const dto = this.parse(MediaRealAnyRequestSchema, raw);
    const effectiveSpec = resolveSub2apiImageSpec(dto, 'submit');
    const adapterInput = this.adapterInput(dto, effectiveSpec);
    const prior = await this.store.findByClientId(claims.enterpriseId, dto.clientRequestId);
    if (prior) {
      if (prior.scope !== this.scope(claims) || prior.semanticSha256 !== this.semanticHash(dto, prior.referenceHashes, this.scope(claims)) || JSON.stringify(prior.referenceIds) !== JSON.stringify(dto.referenceIds) || prior.quoteId !== dto.quoteId) error(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同图片请求');
      return this.snapshot(await this.reconcile(prior));
    }
    await this.authorize(claims);
    const hashes = await this.referenceHashes(claims, dto.referenceIds);
    const semanticSha256 = this.semanticHash(dto, hashes, this.scope(claims));
    const profile = await this.requireProfile(claims.enterpriseId, dto, 'image-submit');
    const quote = await this.store.findQuote(dto.quoteId);
    if (!quote || quote.scope !== this.scope(claims)) error(404, 'MEDIA_NOT_FOUND', '报价不可用');
    if (!quote.compute) error(409, 'CONFIG_CHANGED', '原图片报价未绑定企业凭证，请重新报价');
    if (Date.parse(quote.value.expiresAt) <= Date.now()) error(409, 'QUOTE_EXPIRED', '报价已过期，请重新报价');
    if (quote.value.semanticSha256 !== semanticSha256) error(409, 'IDEMPOTENCY_CONFLICT', '请求内容与报价不一致');
    if ((await this.connections?.isEnterpriseMode(claims.enterpriseId) ?? false) !== !!quote.compute) error(409, 'CONFIG_CHANGED', '企业计费模式已变化，请重新报价');
    if (!('parameters' in dto)) {
      if (!quote.connectionFingerprint) error(409, 'UPGRADE_REQUIRED', 'V3 报价缺少连接快照，请重新报价');
      const frozen = quote.value;
      if (!('protocolVersion' in frozen) || frozen.protocolVersion !== 3 ||
        frozen.modelId !== profile.modelId || frozen.adapterVersion !== SUB2API_IMAGE_ADAPTER_VERSION ||
        frozen.profileId !== profile.profileId || frozen.configVersion !== profile.configVersion ||
        frozen.connectionFingerprint !== quote.connectionFingerprint || !isDeepStrictEqual(frozen.effectiveSpec, effectiveSpec)) {
        error(409, 'CONFIG_CHANGED', '图片报价配置已变化，请重新报价', { field: 'quoteId', stage: 'image-submit', recovery: 'revise_request' });
      }
      const own = await this.computeMedia.connection(claims.enterpriseId, 'image', quote.compute);
      const snapshot = { connection: own, fingerprint: own.fingerprint };
      if (snapshot.fingerprint !== quote.connectionFingerprint) error(409, 'CONFIG_CHANGED', '图片连接已变化，请重新报价', {
        field: 'connectionFingerprint', stage: 'image-submit', recovery: 'revise_request',
      });
    }

    const referenceRows = await Promise.all(dto.referenceIds.map(id => this.store.findReference(id)));
    if (referenceRows.some(row => !row || row.scope !== this.scope(claims))) error(404, 'MEDIA_NOT_FOUND', '参考图不可用');
    const referenceBytes = await Promise.all(dto.referenceIds.map((id, index) => this.cache.get('reference', this.scope(claims), id, {
      sha256: hashes[index], byteLength: referenceRows[index]!.value.byteLength, expiresAt: referenceRows[index]!.value.expiresAt,
    })));
    const rate = quote.usdToCnyRate;
    const nowReceipt: Omit<MediaRealReceipt, 'receiptId'> = {
      paymentMode: quote.value.funding.paymentMode ?? 'AUTO',
      mock: false, clientRequestId: dto.clientRequestId, profileId: dto.profileId, configVersion: dto.configVersion,
      executionMode: 'async-query', status: 'SUBMITTING', pollAfterMs: 3000, outputs: [], billingStatus: 'NOT_RESERVED',
      errorCode: null, outputErrors: [], recovery: { canQuery: true, canCancel: false, canDownload: false },
      ...(!('parameters' in dto) ? { protocolVersion: 3 as const, semanticHashVersion: 3 as const, effectiveSpec,
        specRevision: (dto as MediaRealQuoteRequestV3).specRevision,
        acceptance: { status: 'unknown' as const, mismatchedFields: [], unknownFields: ['actualSpec'] } } : {}),
    };
    const requestId = `sep-image-${randomUUID()}`;
    const enterpriseConnection = await this.computeMedia.connection(claims.enterpriseId, 'image', quote.compute);
    const connectionSnapshot = { connection: enterpriseConnection, fingerprint: enterpriseConnection.fingerprint };
    if (quote.connectionFingerprint && quote.connectionFingerprint !== connectionSnapshot.fingerprint) error(409, 'CONFIG_CHANGED', '图片连接已变化，请重新报价');
    const claim = await this.store.claim({
      enterpriseId: claims.enterpriseId, clientRequestId: dto.clientRequestId, quoteId: dto.quoteId,
      scope: this.scope(claims), semanticSha256, referenceIds: dto.referenceIds, referenceHashes: hashes,
      count: effectiveSpec.count!, configuration: !('parameters' in dto) ? {
        protocolVersion: 3, semanticHashVersion: 3, specRevision: (dto as MediaRealQuoteRequestV3).specRevision,
        profileId: profile.profileId, configVersion: profile.configVersion, modelId: profile.modelId,
        operation: dto.operation, requestedSpec: (dto as MediaRealQuoteRequestV3).requestedSpec, effectiveSpec,
        parameterSources: (dto as MediaRealQuoteRequestV3).parameterSources,
        connectionFingerprint: quote.connectionFingerprint, adapterVersion: SUB2API_IMAGE_ADAPTER_VERSION,
        compute: quote.compute, asyncProtocol: 'longdao-image-v2', dispatchState: 'NOT_DISPATCHED',
      } : { profileId: profile.profileId, configVersion: profile.configVersion,
        modelId: profile.modelId, operation: dto.operation, parameters: dto.parameters, compute: quote.compute, asyncProtocol: 'longdao-image-v2',
        dispatchState: 'NOT_DISPATCHED', connectionFingerprint: connectionSnapshot.fingerprint },
      receipt: { ...nowReceipt, receiptId: 'pending', receiptVersion: 2, fileStatus: 'pending', execution: {
        requestId, taskId: null, submissionStatus: 'submitting', generationStatus: null, isFinal: null,
        observedAt: null, statusSource: null, billing: { status: 'pending', actualCostCny: null },
      } }, upstreamRequestId: requestId,
      submissionDeadline: new Date(Date.now() + IMAGE_SUBMISSION_BUDGET_MS + MEDIA_SAVE_GRACE_MS),
    });
    if (!claim.created) {
      if (claim.record.scope !== this.scope(claims) || claim.record.semanticSha256 !== semanticSha256 || claim.record.quoteId !== dto.quoteId) error(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同图片请求');
      return this.snapshot(claim.record);
    }
    let record = claim.record;
    const receiptId = record.id;
    let reservationAttempted = false;
    try {
      if (quote.compute) await this.computeMedia.begin(claims.enterpriseId, 'image', receiptId, quote.compute, profile.modelId);
      reservationAttempted = true;
      await this.billing.reserve(claims, receiptId, quote.value.amountCny, rate, quote.value.funding.paymentMode ?? 'AUTO');
    } catch (failure) {
      const insufficient = failure instanceof HttpException && failure.getStatus() === 402;
      const changed = failure instanceof HttpException && (failure.getResponse() as { error?: { code?: string } }).error?.code === 'PAYMENT_MODE_CHANGED';
      const notReserved = !reservationAttempted || insufficient || changed;
      record.receipt.status = 'FAILED';
      record.receipt.billingStatus = notReserved ? 'NOT_RESERVED' : 'RECONCILING';
      record.receipt.errorCode = !reservationAttempted || changed ? 'CONFIG_CHANGED' : insufficient ? 'INSUFFICIENT_FUNDS' : 'BILLING_PENDING';
      record.receipt.recovery = { canQuery: !notReserved, canCancel: false, canDownload: false };
      record.receipt.billingError = mediaFailure(failure);
      record.receipt.execution!.submissionStatus = 'not_submitted';
      record.receipt.execution!.operation = 'create'; record.receipt.fileStatus = 'unavailable';
      if (notReserved && record.receipt.execution) {
        await this.computeMedia.closeUnsent(claims.enterpriseId, 'image', receiptId);
        record.receipt.execution.submissionStatus = 'not_submitted'; record.receipt.fileStatus = 'unavailable';
        record.receipt.execution.billing = { status: 'not_charged', actualCostCny: '0.000000' };
      }
      return this.snapshot(await this.store.save(record));
    }
    record.receipt.billingStatus = 'RESERVED';
    const reserved = await this.store.saveGuarded(record);
    record = reserved.record;
    if (!reserved.updated) {
      if (closedSubmission(record.receipt.execution!)) {
        try { await this.billing.release(record.id); record.receipt.billingStatus = 'RELEASED'; }
        catch (failure) { record.receipt.billingStatus = 'RECONCILING'; record.receipt.billingError = mediaFailure(failure); }
        record = await this.store.save(record);
      }
      return this.snapshot(record);
    }
    let dispatchStarted = false;
    let operationFailure: MediaUpstreamError | undefined;
    try {
      if (!('parameters' in dto)) {
        await this.authorize(claims);
        const currentProfile = await this.requireProfile(claims.enterpriseId, dto, 'image-submit');
        if (currentProfile.modelId !== profile.modelId) error(409, 'CONFIG_CHANGED', '图片模型已变化，请重新报价');
      }
      const own = await this.computeMedia.connection(claims.enterpriseId, 'image', quote.compute, receiptId);
      const dispatchConnection = { connection: own, fingerprint: own.fingerprint };
      if (!('parameters' in dto) && dispatchConnection!.fingerprint !== quote.connectionFingerprint) {
        error(409, 'CONFIG_CHANGED', '图片连接已变化，请重新报价', { field: 'connectionFingerprint', stage: 'image-submit', recovery: 'revise_request' });
      }
      (record.configuration as Record<string, unknown>).dispatchState = 'DISPATCHING';
      const dispatch = await this.store.saveGuarded(record);
      record = dispatch.record;
      if (!dispatch.updated || record.receipt.status !== 'SUBMITTING') return this.snapshot(record);
      if (quote.compute) await this.computeMedia.markDispatch(claims.enterpriseId, 'image', receiptId);
      dispatchStarted = true;
      const result = await this.adapter.submitAsync(adapterInput, referenceBytes, profile.modelId, requestId,
        dispatchConnection?.connection ?? connectionSnapshot.connection);
      operationFailure = mediaOperationFailure(result);
      record = await this.applyAsyncResult(record, result);
    } catch (failure) {
      if (failure instanceof ImageDispatchError && failure.upstreamError) record.receipt.upstreamError = failure.upstreamError;
      else record.receipt.upstreamError = mediaFailure(failure);
      if (!dispatchStarted || failure instanceof ImageDispatchError && failure.definitelyRejected) {
        if (!dispatchStarted) await this.computeMedia.closeUnsent(claims.enterpriseId, 'image', receiptId);
        record.receipt.status = 'FAILED'; record.receipt.errorCode = !dispatchStarted ? 'CONFIG_CHANGED' : (failure as ImageDispatchError).safeCode;
        record.receipt.fileStatus = 'unavailable';
        try {
          await this.billing.release(receiptId);
          record.receipt.billingStatus = 'RELEASED';
        } catch (releaseError) {
          record.receipt.billingStatus = 'RECONCILING';
          record.receipt.billingError = mediaFailure(releaseError);
        }
        record.receipt.recovery = { canQuery: record.receipt.billingStatus === 'RECONCILING', canCancel: false, canDownload: false };
      } else {
        record.receipt.status = 'SUBMISSION_UNKNOWN'; record.receipt.billingStatus = 'RECONCILING';
        record.receipt.errorCode = failure instanceof ImageDispatchError && failure.safeCode === 'UPSTREAM_SPEC_UNSUPPORTED'
          ? failure.safeCode : 'SUBMISSION_UNKNOWN';
        record.receipt.recovery = { canQuery: true, canCancel: false, canDownload: record.receipt.outputs.length > 0 };
        if (failure instanceof ImageDispatchError) record.upstreamRequestId = failure.requestId;
      }
      if (record.receipt.execution) {
        record.receipt.execution.operation = 'create';
        record.receipt.execution.submissionStatus = dispatchStarted ? 'unknown' : 'not_submitted';
        record.receipt.execution.operationError = mediaFailure(failure);
        record.receipt.execution.taskId ??= recoverableTaskId(failure, requestId);
        if (!dispatchStarted) record.receipt.execution.billing = { status: 'not_charged', actualCostCny: '0.000000' };
      }
      record = await this.saveExecution(record);
      if (failure instanceof MediaUpstreamException || failure instanceof ImageDispatchError && failure.upstreamError) {
        throw mediaOperationException(record.receipt.upstreamError!, record.receipt);
      }
      return this.snapshot(record);
    }

    if (operationFailure) throw mediaOperationException(operationFailure, record.receipt);
    return this.snapshot(record);
  }

  async findByClientId(claims: ClientEmploymentClaims, id: string) {
    await this.authorize(claims, false);
    const record = await this.store.findByClientId(claims.enterpriseId, id);
    if (!record || record.scope !== this.scope(claims)) error(404, 'MEDIA_NOT_FOUND', '请求不存在');
    return this.snapshot(await this.reconcile(record));
  }

  async receipt(claims: ClientEmploymentClaims, id: string) {
    await this.authorize(claims, false);
    const record = await this.owned(claims, id);
    return this.snapshot(await this.reconcile(record));
  }

  async content(claims: ClientEmploymentClaims, receiptId: string, outputId: string) {
    await this.authorize(claims, false);
    const record = await this.owned(claims, receiptId);
    const output = record.receipt.outputs.find((item) => item.outputId === outputId);
    if (!output) return error(404, 'MEDIA_NOT_FOUND', '结果不可用');
    if (!output.expiresAt || Date.parse(output.expiresAt) <= Date.now()) return error(410, 'RESULT_EXPIRED', '图片结果已过期，不会自动重新生成');
    const bytes = await this.cache.get('output', record.scope, outputId, {
      sha256: output.sha256, byteLength: output.byteLength, expiresAt: output.expiresAt,
    });
    return { output, bytes };
  }

  async cancel(claims: ClientEmploymentClaims, id: string) {
    await this.authorize(claims, false); await this.owned(claims, id);
    error(409, 'CANCEL_UNSUPPORTED', '当前真实图片协议不支持取消');
  }

  private async authorize(claims: ClientEmploymentClaims, execution = true) {
    if (execution) await this.connections?.assertEnterpriseModeSupported(claims.enterpriseId);
    if (execution) await this.assertRealEnabled(claims.enterpriseId);
    const member = await this.prisma.enterpriseMember.findFirst({
      where: { id: claims.memberId, enterpriseId: claims.enterpriseId, userId: claims.sub, user: { status: 'ACTIVE' }, enterprise: { status: 'ACTIVE' } },
      select: { departmentId: true },
    }).catch(cause => realMediaStorageUnavailable(cause));
    if (!member) error(403, 'MEDIA_FORBIDDEN', '当前成员无媒体访问权限');
    const subscription = await this.prisma.subscription.findFirst({ where: clientSubscriptionAccessWhere({
      enterpriseId: claims.enterpriseId, memberId: claims.memberId, departmentId: member.departmentId, role: 'MEMBER',
    }, claims.subscriptionId), select: { id: true } }).catch(cause => realMediaStorageUnavailable(cause));
    if (!subscription) error(403, 'MEDIA_FORBIDDEN', '订阅已失效或授权已撤销');
  }

  private async allowedProfiles(enterpriseId: string, protocolVersion: 1 | 3) {
    const runtime = protocolVersion === 3
      ? await this.mediaConfig.getRuntimeMediaV3(enterpriseId)
      : await this.mediaConfig.getRuntimeMedia(enterpriseId);
    if (!runtime.executionAvailable) return [];
    return runtime.profiles.filter(profile => profile.operations.some(op => ['generate', 'edit'].includes(op)));
  }

  private async requireProfile(enterpriseId: string, dto: MediaRealAnyQuoteRequest, stage: 'image-quote' | 'image-submit') {
    const v3 = !('parameters' in dto);
    const candidates = v3 ? (await this.mediaConfig.getRuntimeMediaV3(enterpriseId)).profiles
      : await this.allowedProfiles(enterpriseId, 1);
    const profile = candidates.find(item => item.profileId === dto.profileId && item.configVersion === dto.configVersion);
    if (v3 && !profile) {
      const config = await this.prisma.enterpriseModelConfig.findUnique({ where: { enterpriseId }, select: { mediaPolicy: true } });
      const authorization = MediaAuthorizationSchema.safeParse(config?.mediaPolicy ?? {});
      if (!authorization.success || !authorization.data.enabledProfileIds.includes(dto.profileId)) error(403, 'MEDIA_FORBIDDEN', '当前企业未授权此图片 Profile', {
        field: 'profileId', stage, recovery: 'refresh_capabilities',
      });
    }
    if (!profile) error(409, 'CONFIG_CHANGED', '图片 Profile 或企业策略已变更', { field: 'profileId', stage, recovery: 'refresh_capabilities' });
    if (!profile.operations.includes(dto.operation)) error(409, 'CONFIG_CHANGED', '图片操作不受当前 Profile 支持', { field: 'operation', stage, recovery: 'revise_request' });
    if (!v3 && 'capabilities' in profile && !profile.capabilities.sizes.includes(dto.parameters.size)) error(409, 'CONFIG_CHANGED', '图片尺寸不受当前 Profile 支持', { field: 'parameters.size', stage, recovery: 'revise_request' });
    if (!v3 && 'capabilities' in profile && dto.parameters.count > profile.capabilities.maxOutputs) error(409, 'CONFIG_CHANGED', '图片输出数量超过当前 Profile 能力', { field: 'parameters.count', stage, recovery: 'revise_request' });
    if (v3 && 'adapter' in profile && !profile.authorized) error(403, 'MEDIA_FORBIDDEN', '当前企业未授权此图片 Profile', {
      field: 'profileId', stage, recovery: 'refresh_capabilities',
    });
    if (v3 && 'adapter' in profile && (!profile.adapter.available || !profile.adapter.operations.includes(dto.operation))) {
      error(503, 'ADAPTER_UNAVAILABLE', '图片适配器当前不可执行', { field: 'profileId', stage, recovery: 'refresh_capabilities' });
    }
    const row = await this.prisma.mediaModelProfile.findUnique({ where: { profileId: dto.profileId } });
    if (!row || row.configVersion !== dto.configVersion || (!v3 && !isSupportedImageModel(row.modelId)) || !row.enabled || !row.verified) error(409, 'CONFIG_CHANGED', '当前 Profile 未通过真实图片配置校验', { field: 'profileId', stage, recovery: 'refresh_capabilities' });
    const capabilities = MediaCapabilitiesSchema.safeParse(row.capabilities);
    if (!capabilities.success) error(503, 'ADAPTER_UNAVAILABLE', '图片能力配置无效，请联系管理员', { field: 'profileId', stage });
    const limits = effectiveImageLimits(capabilities.data);
    const count = 'parameters' in dto ? dto.parameters.count : (dto as MediaRealQuoteRequestV3).requestedSpec.count;
    if (count !== undefined && count > Math.min(1, limits.maxOutputs)) {
        error(400, 'UNSUPPORTED_MEDIA_PARAMETERS', `生成数量不能超过当前配置上限 ${Math.min(1, limits.maxOutputs)} 张`, {
        field: v3 ? 'requestedSpec.count' : 'parameters.count', stage, recovery: 'revise_request',
        submissionState: 'not_submitted', billingState: 'not_reserved',
      });
    }
    if (dto.operation === 'edit' && (dto.referenceIds.length < 1 || dto.referenceIds.length > Math.min(4, limits.maxReferenceCount))) {
      error(422, 'INVALID_REFERENCE', `当前配置需要 1 至 ${Math.min(4, limits.maxReferenceCount)} 张参考图`, {
        field: 'referenceIds', stage, recovery: 'revise_request', submissionState: 'not_submitted', billingState: 'not_reserved',
      });
    }
    return { ...profile, modelId: row.modelId };
  }

  private adapterInput(dto: MediaRealAnyQuoteRequest, effectiveSpec: MediaImageSpecV3 & { size: string; count: number; quality: string }): MediaRealAnyQuoteRequest {
    return !('parameters' in dto) ? { ...dto, requestedSpec: effectiveSpec } : dto;
  }

  private normalizationNotes(dto: MediaRealAnyQuoteRequest, effectiveSpec: MediaImageSpecV3 & { size: string; count: number; quality: string }): string[] {
    if ('parameters' in dto) return [];
    return (dto as MediaRealQuoteRequestV3).requestedSpec.size === undefined && effectiveSpec.width !== undefined
      ? ['width/height 等价规范化为 size 传递给图片适配器'] : [];
  }

  private applyActualSpec(record: RealRequestRecord, effectiveSpec: MediaImageSpecV3 & { size: string; count: number; quality: string }): void {
    if (!('protocolVersion' in record.receipt)) return;
    const dimensions = new Set(record.receipt.outputs.map(output => `${output.width}x${output.height}`));
    const actualSpec: MediaImageSpecV3 = { count: record.receipt.outputs.length };
    if (dimensions.size === 1) actualSpec.size = [...dimensions][0];
    record.receipt.actualSpec = actualSpec;
    const mismatchedFields: string[] = [];
    const unknownFields: string[] = ['quality'];
    if (actualSpec.count !== effectiveSpec.count) mismatchedFields.push('count');
    const numericSize = /^([1-9]\d*)x([1-9]\d*)$/.test(effectiveSpec.size);
    if (numericSize && [...dimensions].some(size => size !== effectiveSpec.size)) mismatchedFields.push('size');
    else if (!numericSize || dimensions.size === 0) unknownFields.push('size');
    record.receipt.acceptance = { status: mismatchedFields.length ? 'mismatched' : unknownFields.length ? 'unknown' : 'matched', mismatchedFields, unknownFields };
  }

  private async referenceHashes(claims: ClientEmploymentClaims, ids: string[]) {
    const references = await Promise.all(ids.map(async id => {
      const row = await this.store.findReference(id);
      if (!row || row.scope !== this.scope(claims)) error(404, 'MEDIA_NOT_FOUND', '参考图不可用');
      if (Date.parse(row.value.expiresAt) <= Date.now()) error(410, 'REFERENCE_EXPIRED', '参考图已过期');
      return row.value;
    }));
    if (references.reduce((total, reference) => total + reference.byteLength, 0) > MAX_MEDIA_REFERENCE_TOTAL_BYTES) {
      error(413, 'INVALID_REFERENCE', '参考图总大小超过 100 MiB');
    }
    return references.map(reference => reference.sha256);
  }

  private async owned(claims: ClientEmploymentClaims, id: string) {
    const record = await this.store.findRequest(id);
    if (!record || record.scope !== this.scope(claims)) error(404, 'MEDIA_NOT_FOUND', '请求不存在');
    return record;
  }

  private semanticHash(dto: MediaRealAnyQuoteRequest, referenceHashes: string[], scope: string) {
    return mediaRealSemanticHash(dto, referenceHashes, !('parameters' in dto)
      ? { scope, adapter: 'sub2api-image-v3' } : undefined);
  }

  private snapshot(record: RealRequestRecord): MediaRealReceipt {
    const result = structuredClone(record.receipt);
    if (!result.execution && result.status === 'SUBMITTING' && record.submissionDeadline.getTime() <= Date.now()) {
      result.status = 'SUBMISSION_UNKNOWN'; result.errorCode = 'SUBMISSION_UNKNOWN'; result.billingStatus = 'RECONCILING';
    }
    result.recovery.canQuery = ['RESERVED', 'RECONCILING'].includes(result.billingStatus) || result.status === 'SUBMISSION_UNKNOWN';
    if (result.outputs.length && result.outputs.every(output => !output.expiresAt || Date.parse(output.expiresAt) <= Date.now())) {
      result.status = 'RESULT_EXPIRED'; result.errorCode = 'RESULT_EXPIRED'; result.recovery.canDownload = false;
      if (result.execution) result.fileStatus = 'expired';
    }
    if (result.execution) {
      result.receiptVersion = 2;
      result.clientActions = mediaClientActions(result.execution, result.fileStatus ?? 'pending', ['RESERVED', 'RECONCILING'].includes(result.billingStatus));
      result.recovery.canQuery = result.clientActions.shouldPoll;
      result.recovery.canDownload = result.fileStatus === 'available' && result.outputs.length > 0;
      result.pollAfterMs = result.clientActions.shouldPoll
        ? mediaPollAfter(record.configuration, result.clientActions.pollPurpose === 'billing' ? 15000 : 3000) : null;
    }
    return withMediaWait(MediaRealAnyReceiptSchema.parse(result), record.configuration);
  }

  private async saveExecution(desired: RealRequestRecord): Promise<RealRequestRecord> {
    let candidate = structuredClone(desired);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.store.save(candidate);
      if (current.revision === candidate.revision + 1 &&
        current.upstreamRequestId === candidate.upstreamRequestId &&
        isDeepStrictEqual(MediaRealAnyReceiptSchema.parse(current.receipt), MediaRealAnyReceiptSchema.parse(candidate.receipt))) return current;
      if (!['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(current.receipt.status)) return current;
      if (current.upstreamRequestId && desired.upstreamRequestId && current.upstreamRequestId !== desired.upstreamRequestId) realMediaStorageUnavailable();
      // A timeout sweep may win CAS while the original dispatch is still receiving bytes.
      candidate = { ...current, upstreamRequestId: desired.upstreamRequestId ?? current.upstreamRequestId,
        receipt: desired.receipt.status === 'SUBMITTING' ? structuredClone(current.receipt) : structuredClone(desired.receipt) };
      if (['SETTLED', 'RELEASED'].includes(current.receipt.billingStatus)) candidate.receipt.billingStatus = current.receipt.billingStatus;
    }
    return realMediaStorageUnavailable();
  }

  private async reconcile(record: RealRequestRecord): Promise<RealRequestRecord> {
    if (record.receipt.execution) {
      const pending = this.recovering.get(record.id);
      if (pending) return pending;
      const work = this.recoverAsync(record);
      this.recovering.set(record.id, work);
      try { return await work; } finally { this.recovering.delete(record.id); }
    }
    if (!['RESERVED', 'RECONCILING'].includes(record.receipt.billingStatus) || record.receipt.status === 'SUBMITTING') return record;
    try {
      const configuration = record.configuration as { compute?: ComputeMediaSnapshot; modelId?: string };
      const billingStatus = await this.billing.status(record.id);
      if (billingStatus === 'SETTLED' || billingStatus === 'RELEASED') {
        record.receipt.billingStatus = billingStatus;
        if (billingStatus === 'RELEASED' && record.receipt.status === 'SUBMISSION_UNKNOWN' && record.receipt.errorCode === 'BILLING_PENDING') record.receipt.status = 'FAILED';
        return this.store.save(record);
      }
      if (record.receipt.status === 'FAILED' && (['UPSTREAM_FAILED', 'UPSTREAM_SPEC_UNSUPPORTED'].includes(record.receipt.errorCode) ||
        record.receipt.errorCode === 'CONFIG_CHANGED' && !record.upstreamRequestId)) {
        await this.billing.release(record.id);
        record.receipt.billingStatus = 'RELEASED';
        return this.store.save(record);
      }
      if (configuration.compute) {
        if (await this.computeMedia.closeUnsent(record.enterpriseId, 'image', record.id)) {
          await this.billing.release(record.id);
          record.receipt.status = 'FAILED'; record.receipt.billingStatus = 'RELEASED'; record.receipt.errorCode = 'BILLING_PENDING';
          record.receipt.recovery = { canQuery: false, canCancel: false, canDownload: false };
          return this.store.save(record);
        }
        const fee = await this.computeMedia.fee(record.enterpriseId, 'image', record.id);
        record.receipt.billingStatus = fee?.feeStatus === 'FINAL'
          ? await this.billing.settleCompute(record.id, fee.id, configuration.modelId) : 'RECONCILING';
        return this.store.save(record);
      }
      if ((record.receipt.status === 'FAILED' && (['UPSTREAM_FAILED', 'UPSTREAM_SPEC_UNSUPPORTED'].includes(record.receipt.errorCode) ||
        record.receipt.errorCode === 'CONFIG_CHANGED' && !record.upstreamRequestId)) ||
        (record.receipt.status === 'SUBMISSION_UNKNOWN' && record.receipt.errorCode === 'BILLING_PENDING' && billingStatus === 'RESERVED')) {
        await this.billing.release(record.id);
        record.receipt.status = 'FAILED';
        record.receipt.billingStatus = 'RELEASED';
        return this.store.save(record);
      }
      if (!record.upstreamRequestId) return record;
      throw new ServiceUnavailableException({ code: 'COMPUTE_ORIGINAL_CREDENTIAL_REQUIRED',
        message: '原图片任务未绑定企业凭证，无法自动查询，请核对原任务账务' });
    } catch (failure) {
      if (failure instanceof MediaUpstreamException) throw failure;
      record.receipt.upstreamError = retainMediaFailure(record.receipt.upstreamError, failure, 'billing');
      return this.store.save(record);
    }
  }

  @Cron('*/1 * * * *')
  async reconcilePending(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const page = await this.store.pendingRequests(20, this.reconcileAfterId);
      const candidates = page.records;
      this.reconcileAfterId = page.afterId;
      for (let record of candidates) {
        try {
          // Async generation is driven by explicit client queries, never a cron POST/poll.
          if (record.receipt.execution) continue;
          if (record.receipt.status === 'SUBMITTING') {
            if (record.submissionDeadline.getTime() > Date.now()) continue;
            record.receipt = this.snapshot(record);
            record = await this.store.save(record);
          }
          await this.reconcile(record);
        } catch (error) {
          Logger.warn({ event: 'image_reconciliation_failed', receiptId: record.receipt.receiptId, error: exceptionDetails(error) }, 'MediaRealService');
          // Leave the original request and frozen funds intact for the next bounded pass.
        }
      }
    } catch (error) {
      Logger.warn({ event: 'image_reconciliation_scan_failed', error: exceptionDetails(error) }, 'MediaRealService');
      // Storage outages must not trigger a new execution or a speculative refund.
    } finally {
      this.reconciling = false;
    }
  }

  private async recoverAsync(record: RealRequestRecord): Promise<RealRequestRecord> {
    const retryQuery = hasFailedMediaQuery(record.receipt);
    if (!retryQuery && record.receipt.billingStatus === 'NOT_RESERVED' && closedSubmission(record.receipt.execution!)) return record;
    if (!retryQuery && ((closedSubmission(record.receipt.execution!) || ['failed', 'cancelled'].includes(record.receipt.execution!.generationStatus!)) && record.receipt.billingStatus === 'RELEASED' ||
        ['available', 'expired'].includes(record.receipt.fileStatus!) && ['SETTLED', 'RELEASED'].includes(record.receipt.billingStatus))) return record;
    let operationFailure: MediaUpstreamError | undefined;
    try {
      if (!retryQuery && (record.configuration as { compute?: ComputeMediaSnapshot }).compute
        && (record.configuration as { dispatchState?: string }).dispatchState !== 'NOT_DISPATCHED'
        && record.receipt.execution!.billing.status === 'not_charged'
        && (closedSubmission(record.receipt.execution!) || record.receipt.execution!.isFinal)) {
        return this.settleAsyncBilling(record);
      }
      const original = record.configuration as { compute?: ComputeMediaSnapshot; dispatchState?: string };
      if (!retryQuery && record.receipt.execution!.billing.status === 'not_charged' && record.receipt.execution!.generationStatus !== 'completed'
        && (!original.compute || original.dispatchState === 'NOT_DISPATCHED'
          && await this.computeMedia.closeUnsent(record.enterpriseId, 'image', record.id))) {
        try {
          await this.billing.release(record.id);
          record.receipt.billingStatus = 'RELEASED'; delete record.receipt.billingError;
        } catch (failure) { record.receipt.billingStatus = 'RECONCILING'; record.receipt.billingError = mediaFailure(failure); }
        return this.store.save(record);
      }
      const configuration = record.configuration as { connectionFingerprint?: string; dispatchState?: string; compute?: ComputeMediaSnapshot };
      if (configuration.dispatchState === 'NOT_DISPATCHED') {
        if (record.submissionDeadline.getTime() > Date.now()) return record;
        if (configuration.compute && !await this.computeMedia.closeUnsent(record.enterpriseId, 'image', record.id)) return record;
        record.receipt.status = 'FAILED'; record.receipt.execution!.submissionStatus = 'not_submitted';
        record.receipt.fileStatus = 'unavailable'; record.receipt.execution!.billing = { status: 'not_charged', actualCostCny: '0.000000' };
        const closed = await this.store.saveGuarded(record);
        if (!closed.updated) return closed.record;
        record = closed.record;
        await this.billing.release(record.id);
        record.receipt.billingStatus = 'RELEASED';
        return this.store.save(record);
      }
      if (!configuration.compute) error(409, 'CONFIG_CHANGED', '原图片任务缺少企业凭证，不能使用平台凭证恢复');
      const own = await this.computeMedia.connection(record.enterpriseId, 'image', configuration.compute, record.id);
      const snapshot = { connection: own, fingerprint: own.fingerprint };
      if (!configuration.connectionFingerprint || configuration.connectionFingerprint !== snapshot.fingerprint) error(409, 'CONFIG_CHANGED', '原图片连接已变更，不能使用其他 Key 恢复任务');
      if (retryQuery || record.receipt.execution!.generationStatus !== 'completed' || !['SETTLED', 'RELEASED'].includes(record.receipt.billingStatus)) {
        const result = await this.adapter.queryAsync(snapshot.connection, record.receipt.execution!.requestId,
          closedSubmission(record.receipt.execution!) ? null : record.receipt.execution!.taskId);
        operationFailure = mediaOperationFailure(result);
        record = await this.applyAsyncResult(record, result);
      }
      if (!operationFailure && record.receipt.execution?.generationStatus === 'completed' && record.receipt.execution.taskId && !record.receipt.outputs.length) {
        try {
          const config = record.configuration as { outputExpiresAt?: string };
          config.outputExpiresAt ??= new Date(Date.now() + OUTPUT_TTL).toISOString();
          record = await this.store.save(record);
          if (Date.parse(config.outputExpiresAt) <= Date.now()) {
            record.receipt.status = 'RESULT_EXPIRED'; record.receipt.fileStatus = 'expired';
            return this.store.save(record);
          }
          const { bytes, metadata } = await this.adapter.contentAsync(snapshot.connection, record.receipt.execution!.taskId!);
          const outputId = `${record.id}_0`;
          const expiresAt = config.outputExpiresAt;
          await this.cache.put('output', record.scope, outputId, bytes, expiresAt);
          record.receipt.outputs = [{ outputId, kind: 'image', mimeType: metadata.mimeType, width: metadata.width,
            height: metadata.height, byteLength: bytes.length, sha256: sha(bytes), expiresAt }];
          record.receipt.status = 'SUCCEEDED'; record.receipt.fileStatus = 'available'; record.receipt.errorCode = null;
          if (record.receipt.execution!.operation === 'download') {
            delete record.receipt.execution!.operationError;
            record.receipt.upstreamError = executionFailure(record.receipt.execution!, 200);
            updateMediaWait(record.configuration, {});
          }
          const spec = (record.configuration as { effectiveSpec?: ReturnType<typeof resolveSub2apiImageSpec> }).effectiveSpec;
          if (spec) this.applyActualSpec(record, spec);
        } catch (failure) {
          if (failure instanceof MediaUpstreamException) operationFailure ??= mediaFailure(failure);
          record.receipt.fileStatus = 'download_failed'; record.receipt.errorCode = 'OUTPUT_FAILED';
          record.receipt.execution!.operationError = mediaFailure(failure);
          record.receipt.execution!.operation = 'download';
          record.receipt.upstreamError = mediaFailure(failure);
        }
        record = await this.store.save(record);
      }
    } catch (failure) {
      if (failure instanceof MediaUpstreamException) operationFailure ??= mediaFailure(failure);
      record.receipt.execution!.operation = 'query';
      record.receipt.execution!.operationError = mediaFailure(failure);
      record.receipt.upstreamError = mediaFailure(failure);
      record = await this.store.save(record);
    }
    if (operationFailure) throw mediaOperationException(operationFailure, record.receipt);
    return record;
  }

  private async applyAsyncResult(record: RealRequestRecord, result: LongdaoMediaResult): Promise<RealRequestRecord> {
    updateMediaWait(record.configuration, result.headers);
    const incoming = executionEvidence(result);
    if (incoming.submissionStatus === 'unobserved') {
      record.receipt.execution = mergeExecutionEvidence(record.receipt.execution!, incoming);
      record.receipt.upstreamError = incoming.operationError;
      return this.store.save(record);
    }
    const execution = mergeExecutionEvidence(record.receipt.execution!, incoming);
    const expectedModel = (record.configuration as { modelId?: string }).modelId;
    if (!closedSubmission(execution) && result.contract.model && result.contract.model !== expectedModel ||
        execution.submissionStatus === 'accepted' && !execution.taskId) {
      record.receipt.execution!.taskId ??= execution.taskId;
      record.receipt.execution!.operationError = { status: 502, body: MediaJsonValueSchema.parse({ error: { code: 'UPSTREAM_FAILED', message: '图片回执模型或任务编号无效', details: result.contract } }) };
      record.receipt.upstreamError = record.receipt.execution!.operationError;
      return this.store.save(record);
    }
    record.receipt.execution = execution;
    record.receipt.upstreamError = executionFailure(execution, result.httpStatus);
    if (closedSubmission(execution) || execution.generationStatus === 'failed' || execution.generationStatus === 'cancelled') {
      record.receipt.status = execution.generationStatus === 'cancelled' ? 'CANCELLED' : 'FAILED';
      record.receipt.fileStatus = 'unavailable'; record.receipt.errorCode = 'UPSTREAM_FAILED';
    } else if (execution.submissionStatus === 'submitting') record.receipt.status = 'SUBMITTING';
    else if (execution.submissionStatus === 'unknown') record.receipt.status = 'SUBMISSION_UNKNOWN';
    else {
      record.receipt.status = record.receipt.outputs.length ? 'SUCCEEDED' : 'RUNNING';
      if (record.receipt.errorCode === 'SUBMISSION_UNKNOWN') record.receipt.errorCode = null;
    }
    const observed = await this.store.saveGuarded(record);
    record = observed.record;
    if (!observed.updated) return record;
    return this.settleAsyncBilling(record);
  }

  private async settleAsyncBilling(record: RealRequestRecord): Promise<RealRequestRecord> {
    const execution = record.receipt.execution!;
    const expectedModel = (record.configuration as { modelId?: string }).modelId;
    try {
      const billingStatus = await this.billing.status(record.id);
      if (billingStatus === 'SETTLED' || billingStatus === 'RELEASED') {
        record.receipt.billingStatus = billingStatus;
        delete record.receipt.billingError;
        return this.store.save(record);
      }
      const compute = (record.configuration as { compute?: ComputeMediaSnapshot }).compute;
      if (compute && execution.billing.status !== 'pending') {
        const fee = await this.computeMedia.fee(record.enterpriseId, 'image', record.id);
        record.receipt.billingStatus = fee?.feeStatus === 'FINAL'
          ? await this.billing.settleCompute(record.id, fee.id, expectedModel!) : 'RECONCILING';
      } else if (compute) {
        record.receipt.billingStatus = 'RECONCILING';
      } else if (execution.billing.status === 'not_charged') {
        await this.billing.release(record.id);
        record.receipt.billingStatus = 'RELEASED';
      } else if (execution.billing.status === 'settled') {
        error(409, 'BILLING_PENDING', '原图片任务缺少企业执行记录，需核对原任务费用单');
      } else record.receipt.billingStatus = 'RECONCILING';
      delete record.receipt.billingError;
    } catch (failure) {
      record.receipt.billingStatus = 'RECONCILING'; record.receipt.billingError = mediaFailure(failure);
    }
    return this.store.save(record);
  }

  private scope(claims: ClientEmploymentClaims) { return JSON.stringify([claims.enterpriseId, claims.sub, claims.memberId, claims.subscriptionId]); }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    try { return schema.parse(value); }
    catch (cause) { error(400, 'INVALID_PARAMETER', '图片请求参数无效', { cause: exceptionDetails(cause) }); }
  }

}
