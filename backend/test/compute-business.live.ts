import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { hash } from 'bcrypt';
import { SETTING_KEYS } from 'shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { ComputeProtocolClient } from '../src/modules/compute-integration/compute-protocol.client';
import { ComputeRemoteAdapter } from '../src/modules/compute-integration/compute-remote.adapter';
import { ComputeIntegrationService } from '../src/modules/compute-integration/compute-integration.service';
import { ComputeIntegrationWorker } from '../src/modules/compute-integration/compute-integration.worker';
import { ComputeAccountingService } from '../src/modules/compute-integration/compute-accounting.service';
import { ComputeConnectionService } from '../src/modules/compute-integration/compute-connection.service';
import { ComputeModelTransportService } from '../src/modules/compute-integration/compute-model-transport.service';
import { ComputeFundsService } from '../src/modules/compute-integration/compute-funds.service';
import { ComputeMediaService } from '../src/modules/compute-integration/compute-media.service';
import { ComputeModelCatalogService } from '../src/modules/compute-integration/compute-model-catalog.service';
import { ComputeReconciliationWorker } from '../src/modules/compute-integration/compute-reconciliation.worker';
import { ComputeCreditService } from '../src/modules/compute-credit/compute-credit.service';
import { ComputeFeeWorker } from '../src/modules/compute-credit/compute-fee.worker';
import { MemberAllowanceService } from '../src/modules/compute-credit/member-allowance.service';
import { MemberAllowanceQueryService } from '../src/modules/compute-credit/member-allowance-query.service';
import { PersonalWalletService } from '../src/modules/personal-wallet/personal-wallet.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { GatewayService } from '../src/modules/gateway/gateway.service';
import { GatewayExecutionService } from '../src/modules/gateway/gateway-execution.service';
import { policySnapshot } from '../src/modules/gateway/gateway-policy.test-fixtures';
import { RedisService } from '../src/redis/redis.service';
import { Sub2apiImageAdapter } from '../src/modules/media-gateway/sub2api-image.adapter';
import { Sub2apiVideoAdapter } from '../src/modules/media-gateway/sub2api-video.adapter';
import { MediaConfigService } from '../src/modules/media-config/media-config.service';
import { MediaVideoConfigService } from '../src/modules/media-config/media-video-config.service';
import { MediaRealBillingService } from '../src/modules/media-gateway/media-real-billing.service';
import { MediaRealService } from '../src/modules/media-gateway/media-real.service';
import { MediaRealStore } from '../src/modules/media-gateway/media-real.store';
import { MediaByteCacheService } from '../src/modules/media-gateway/media-byte-cache.service';
import { MediaVideoRealService } from '../src/modules/media-gateway/media-video-real.service';
import { MediaVideoRealStore } from '../src/modules/media-gateway/media-video-real.store';
import { VideoFileCacheService } from '../src/modules/media-gateway/video-file-cache.service';

export async function runComputeBusinessFixture(db: PrismaService, config: ConfigService, protocol: ComputeProtocolClient,
  remote: ComputeRemoteAdapter, service: ComputeIntegrationService, models: { chat: string; image: string; video: string },
  directory: string, fixtureIds: string[], referenceBytes: Buffer) {
  const stamp = Date.now().toString();
  const company = await db.enterprise.create({ data: { name: `SEP业务联调-${stamp}`, members: { create: { role: 'ENTERPRISE_ADMIN',
    user: { create: { email: `sep-business-${stamp}@example.test`, authCredentials: { create: {
      type: 'LOCAL_PASSWORD', passwordHash: await hash('SepBusinessFixture2026!', 10),
    } } } } } } }, include: { members: true } });
  const enterpriseId = company.id, userId = company.members[0].userId, memberId = company.members[0].id;
  fixtureIds.push(enterpriseId);
  const scoped = new Proxy(db, { get(target, property) {
    if (property === 'computeIntegrationJob') return { ...target.computeIntegrationJob,
      findMany: (args: any) => target.computeIntegrationJob.findMany({ ...args, where: { ...args.where, enterpriseId } }) };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const funds = new ComputeFundsService(service), worker = new ComputeIntegrationWorker(scoped, remote, service, funds);
  const deliverAccounting = async () => {
    let pending: unknown;
    for (let i = 0; i < 100; i++) {
      await worker.deliver();
      const jobs = await db.computeIntegrationJob.findMany({ where: { enterpriseId,
        kind: { in: ['PROVISION', 'SETTLEMENT', 'TRANSFER'] }, status: { not: 'SUCCEEDED' } },
        select: { kind: true, status: true, attempts: true, lastErrorCode: true, lastErrorMessage: true } });
      if (!jobs.length) return;
      pending = jobs;
      assert.ok(!jobs.some(job => job.status === 'BLOCKED'), JSON.stringify(jobs));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Accounting jobs did not finish: ${JSON.stringify(pending)}`);
  };
  await service.prepare(enterpriseId); await deliverAccounting();
  const employee = await db.digitalEmployee.create({ data: { name: `live-${stamp}`, description: 'fixture', industry: 'fixture', position: 'fixture', systemPrompt: 'fixture' } });
  const subscription = await db.subscription.create({ data: { enterpriseId, employeeId: employee.id, templateVersion: '1',
    grants: { create: { memberId } } } });
  await db.subscriptionCredit.create({ data: { enterpriseId, employeeId: employee.id, subscriptionId: subscription.id, grantedCNY: '0.100000' } });
  await db.enterpriseWallet.create({ data: { enterpriseId, balance: 10 } });
  await db.personalWallet.create({ data: { userId, balance: 10 } });
  await service.completeConnection(enterpriseId);
  const wallet = new WalletService(db, service, funds), personal = new PersonalWalletService(db);
  const allowance = new MemberAllowanceService(db, personal, wallet, new MemberAllowanceQueryService(db));
  const noLocalPrices = { getSnapshot: () => { throw new Error('Unexpected local pricing'); } };
  const credit = new ComputeCreditService(db, wallet, personal, {} as any, allowance, { afterCharge: async () => undefined } as any, noLocalPrices as any, service);
  const transfer = await wallet.reserveForCompute(enterpriseId, 1, userId);
  assert.equal(transfer.syncStatus, 'PENDING');
  await assert.rejects(allowance.topUp(enterpriseId, userId, { amountCNY: 0.3 } as any, userId));
  await deliverAccounting();
  assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '1.000000');
  await allowance.topUp(enterpriseId, userId, { amountCNY: 0.3 } as any, userId);

  const settings: any = { getEffectiveValue: async (key: string) => {
    if ([SETTING_KEYS.SUB2API_BASE_URL, SETTING_KEYS.MEDIA_BASE_URL, SETTING_KEYS.MEDIA_VIDEO_BASE_URL].includes(key as any)) return protocol.origin() + '/v1';
    if (key === SETTING_KEYS.SUB2API_DEFAULT_MODEL) return models.chat;
    throw new Error(`Unexpected platform credential/price read: ${key}`);
  } };
  const accounting = new ComputeAccountingService(db), transport = new ComputeModelTransportService(db, accounting, protocol);
  const connections = new ComputeConnectionService(settings, service, protocol, transport);
  const catalog = new ComputeModelCatalogService(db, connections, protocol);
  const gateway = new GatewayService(db, config, settings, credit, {} as any, connections);
  const journal = new GatewayExecutionService(db, credit, config, service);
  const claims: any = { sub: userId, enterpriseId, memberId, subscriptionId: subscription.id };
  const authorization = await gateway.validateAndAuthorize(claims, models.chat);
  const policy = policySnapshot(), requestId = randomUUID();
  const execution = await journal.start(claims, authorization.employeeId, models.chat, requestId, policy);
  const response = await gateway.forwardChatCompletion({ model: models.chat, messages: [{ role: 'user', content: 'fixture' }] }, policy, requestId, undefined,
    { ...claims, userId, employeeId: employee.id, gatewayId: execution.id });
  const completion: any = await gateway.readCompletion(response);
  await journal.saveUsage(execution.id, completion.usage); await journal.finish(execution.id, { done: true });
  await db.computeIntegrationJob.updateMany({ where: { enterpriseId, kind: 'FEE' }, data: { nextRunAt: new Date(0) } });
  const fees = new ComputeFeeWorker(scoped, remote, accounting, credit);
  for (let i = 0; i < 30; i++) {
    await fees.recover();
    if ((await db.gatewayExecution.findUniqueOrThrow({ where: { id: execution.id } })).status === 'SETTLED') break;
    await new Promise(resolve => setTimeout(resolve, 100));
    await db.computeIntegrationJob.updateMany({ where: { enterpriseId, kind: 'FEE', status: 'PENDING' }, data: { nextRunAt: new Date(0) } });
  }
  assert.equal((await db.gatewayExecution.findUniqueOrThrow({ where: { id: execution.id } })).status, 'SETTLED');
  await deliverAccounting();
  assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '1.000000');
  console.log('PASS: existing gateway authorization, journal, signed generation, authoritative CNY charge and real free-right transaction');

  config.set('MEDIA_GATEWAY_REAL_ENABLED', 'true'); config.set('MEDIA_VIDEO_REAL_ENABLED', 'true');
  config.set('REDIS_URL', 'redis://127.0.0.1:26380/0');
  const redis = new RedisService(config); redis.onModuleInit();
  const previousCache = process.env.MEDIA_VIDEO_CACHE_DIR;
  process.env.MEDIA_VIDEO_CACHE_DIR = join(directory, 'business-video-cache');
  try {
    const imageProfile = `live-img-${stamp}`, videoProfile = `live-vid-${stamp}`, version = `cfg_${stamp}`;
    const videoCapabilities = { supportsTextToVideo: true, supportsImageToVideo: true, supportsAudio: false,
      durationsSeconds: [6], resolutions: ['720p'], aspectRatios: ['16:9'], frameRates: [24], outputFormats: ['video/mp4'],
      maxInputBytes: 5242880, maxReferenceCount: 1, supportsTaskQuery: true, supportsCancel: false, resultRetentionSeconds: 86400 };
    // Repair only old resources owned by this isolated repeatable fixture.
    await db.mediaModelProfile.updateMany({ where: { profileId: { startsWith: 'live-vid-' }, displayName: 'fixture video' }, data: { capabilities: videoCapabilities } });
    await db.mediaModelProfile.create({ data: { profileId: imageProfile, displayName: 'fixture image', modelId: models.image, configVersion: version,
      operations: ['generate', 'edit'],
      capabilities: { sizes: ['1024x1024'], maxOutputs: 1, maxReferenceCount: 1, supportsReferenceImage: true }, enabled: true, verified: true } });
    await db.mediaModelProfile.create({ data: { profileId: videoProfile, kind: 'video', displayName: 'fixture video', modelId: models.video, configVersion: version,
      operations: ['text-to-video', 'image-to-video'], executionMode: 'async-query', capabilities: videoCapabilities, enabled: true, verified: true } });
    await db.enterpriseModelConfig.create({ data: { enterpriseId, defaultChatModel: models.chat, mediaPolicy: {
      enabledProfileIds: [imageProfile], defaultProfileId: imageProfile, video: { enabledProfileIds: [videoProfile], defaultProfileId: videoProfile },
    } } });
    const imageAdapter = new Sub2apiImageAdapter(settings, protocol), videoAdapter = new Sub2apiVideoAdapter(settings, protocol);
    const media = new ComputeMediaService(db, connections, service, accounting, remote, protocol);
    const billing = new MediaRealBillingService(db, service), files = new VideoFileCacheService();
    const imageConfig = new MediaConfigService(db, settings, {} as any, catalog, config, imageAdapter);
    const videoConfig = new MediaVideoConfigService(db, {} as any, config, catalog, videoAdapter, files, undefined, settings);
    const image = new MediaRealService(config, db, settings, imageConfig, imageAdapter, new MediaByteCacheService(redis), billing, new MediaRealStore(db), connections, media);
    const input = { protocolVersion: 3 as const, specRevision: 1, profileId: imageProfile, configVersion: version, operation: 'generate' as const,
      referenceIds: [], creativeBrief: 'fixture', requestedSpec: { size: '1024x1024', quality: 'medium', count: 1 } };
    const quote = await image.quote(claims, input);
    assert.equal((quote as any).amountUsd, null);
    const imageReceipt = await image.submit(claims, { ...input, quoteId: quote.quoteId, clientRequestId: `img_${stamp}` });
    let result = imageReceipt;
    for (let i = 0; i < 30 && result.billingStatus !== 'SETTLED'; i++) { await new Promise(resolve => setTimeout(resolve, 100)); result = await image.receipt(claims, imageReceipt.receiptId); }
    assert.equal(result.billingStatus, 'SETTLED'); assert.ok(result.outputs.length);
    await deliverAccounting();
    console.log('PASS: existing real image quote/submit/receipt path with enterprise Key, actual source holds/refunds and CNY split settlement');
    const imageReference = await image.uploadReference(claims, { buffer: referenceBytes, size: referenceBytes.length, mimetype: 'image/png' } as any);
    const edit = { ...input, operation: 'edit' as const, referenceIds: [imageReference.referenceId] };
    const editQuote = await image.quote(claims, edit);
    let edited = await image.submit(claims, { ...edit, quoteId: editQuote.quoteId, clientRequestId: `edit_${stamp}` });
    for (let i = 0; i < 30 && edited.billingStatus !== 'SETTLED'; i++) { await new Promise(resolve => setTimeout(resolve, 100)); edited = await image.receipt(claims, edited.receiptId); }
    assert.equal(edited.billingStatus, 'SETTLED'); assert.ok(edited.outputs.length);
    await deliverAccounting();
    console.log('PASS: signed image-edit multipart bytes preserve references and settle actual CNY');

    const video = new MediaVideoRealService(config, db, settings, videoConfig, videoAdapter, files, billing, new MediaVideoRealStore(db), connections, media);
    const videoInput = { protocolVersion: 3 as const, specRevision: 1, profileId: videoProfile, configVersion: version, operation: 'text-to-video' as const,
      referenceIds: [], creativeBrief: 'fixture', requestedSpec: { durationSeconds: 6, resolution: '720p', aspectRatio: '16:9', frameRate: 24, audio: false, outputFormat: 'video/mp4' } };
    const videoQuote = await video.quote(claims, videoInput);
    assert.equal(videoQuote.usdToCnyRate, null);
    let videoReceipt = await video.submit(claims, { ...videoInput, quoteId: videoQuote.quoteId, clientRequestId: `vid_${stamp}` });
    for (let i = 0; i < 30 && (videoReceipt.billingStatus !== 'SETTLED' || videoReceipt.status !== 'SUCCEEDED'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); videoReceipt = await video.receipt(claims, videoReceipt.receiptId);
    }
    assert.equal(videoReceipt.billingStatus, 'SETTLED'); assert.equal(videoReceipt.status, 'SUCCEEDED');
    const videoReference = await video.reference(claims, { buffer: referenceBytes, size: referenceBytes.length, mimetype: 'image/png' } as any);
    const imageVideo = { ...videoInput, operation: 'image-to-video' as const, referenceIds: [videoReference.referenceId] };
    const imageVideoQuote = await video.quote(claims, imageVideo);
    let imageVideoReceipt = await video.submit(claims, { ...imageVideo, quoteId: imageVideoQuote.quoteId, clientRequestId: `iv_${stamp}` });
    for (let i = 0; i < 30 && (imageVideoReceipt.billingStatus !== 'SETTLED' || imageVideoReceipt.status !== 'SUCCEEDED'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); imageVideoReceipt = await video.receipt(claims, imageVideoReceipt.receiptId);
    }
    assert.equal(imageVideoReceipt.billingStatus, 'SETTLED'); assert.equal(imageVideoReceipt.status, 'SUCCEEDED');
    await deliverAccounting();
    assert.equal(await db.computeIntegrationSettlement.count({ where: { enterpriseId, status: { not: 'COMMITTED' } } }), 0);
    console.log('PASS: existing real video quote/submit/query/content-cache path, personal funding and remote paid settlement');
    await wallet.releaseFromCompute(enterpriseId, 0.2, userId); await deliverAccounting();
    assert.equal((await wallet.getBalance(enterpriseId)).computeReservedCNY.toFixed(6), '0.500000');
    assert.equal((await remote.balance(enterpriseId)).total_paid_cny, '0.500000');
    assert.equal((await new ComputeReconciliationWorker(db, remote).account(enterpriseId)).status, 'MATCHED');
    console.log('PASS: actual enterprise wallet return and continuous ledger reconciliation at the same remote watermark');
  } finally {
    await redis.onModuleDestroy();
    if (previousCache === undefined) delete process.env.MEDIA_VIDEO_CACHE_DIR; else process.env.MEDIA_VIDEO_CACHE_DIR = previousCache;
  }
}
