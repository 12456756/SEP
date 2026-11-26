import { HttpException } from '@nestjs/common';
import { MediaVideoRealReceiptSchema } from 'shared';
import { MediaUpstreamException } from '../../common/errors/media-upstream.exception';
import { MediaVideoRealService } from './media-video-real.service';
import { MediaVideoRealStore } from './media-video-real.store';
import { contractResult } from './longdao-media.test-support';
import { MediaVideoRecoveryLeaseService } from './media-video-recovery-lease.service';
import { capabilities, fingerprint, input, outputMetadata, scope, videoBytes, videoClaims, videoRealPrisma } from './media-video-real.test-support';

const value = { protocolVersion: 3 as const, profileId: input.profileId, configVersion: input.configVersion,
  operation: input.operation, referenceIds: [], creativeBrief: 'Product video', specRevision: 1,
  requestedSpec: { durationSeconds: 4, resolution: '720p', aspectRatio: '16:9', frameRate: 30, audio: true, outputFormat: 'video/mp4' } };

function harness(recoveryLease?: MediaVideoRecoveryLeaseService) {
  const db = videoRealPrisma();
  const store = new MediaVideoRealStore(db as never);
  const connection = { base: 'https://relay.invalid/v1', key: 'test-secret', fingerprint };
  const adapter = {
    connection: jest.fn().mockResolvedValue(connection),
    pricing: jest.fn().mockResolvedValue({ model: 'minimax-h3', operation: value.operation, resolution: '720p', duration_seconds: 4,
      pricing_status: 'quoted', amount_usd: '0.2', pricing_version: 'price1', expires_at: new Date(Date.now() + 60000).toISOString() }),
    submitContract: jest.fn(async (_c, _v, _m, _r, id) => contractResult(id, {}, 202)),
    queryContract: jest.fn(async (_c, id) => contractResult(id, { status: 'completed', is_final: true,
      billing: { status: 'settled', actual_cost_usd: '0.1' } })),
    cancelContract: jest.fn(async (_c, id) => contractResult(id, { status: 'cancelled', is_final: true,
      billing: { status: 'not_charged', actual_cost_usd: '0' } })),
    rawContent: jest.fn().mockImplementation(async () => new Response(videoBytes)),
    usage: jest.fn(async (_c, id) => ({ request_id: id, status: 'settled', model: 'minimax-h3', actual_cost_usd: '0.1',
      video_count: 1, duration_seconds: 4, resolution: '720p' })),
  };
  const cache = { saveOutput: jest.fn().mockResolvedValue({ ...outputMetadata, hasAudio: true }),
    readReference: jest.fn(), saveReference: jest.fn(), streamOutput: jest.fn() };
  const billing = {
    quoteFunding: jest.fn().mockResolvedValue({ creditCny: '0.000000', memberWalletCny: '0.000000', personalCny: '1.400000' }),
    reserve: jest.fn(async (_c, id) => { db.state.reservations.set(id, { receiptId: id, status: 'RESERVED', updatedAt: new Date() }); }),
    status: jest.fn(async id => db.state.reservations.get(id)?.status ?? 'NOT_RESERVED'),
    release: jest.fn(async id => { db.state.reservations.get(id).status = 'RELEASED'; }),
    settleNegotiated: jest.fn(async id => { db.state.reservations.get(id).status = 'SETTLED'; return 'SETTLED'; }),
  };
  const config = { get: jest.fn().mockReturnValue('true') };
  const runtime = { getRuntimeVideo: jest.fn().mockResolvedValue({ executionAvailable: true, executionMode: 'real', profiles: [{ ...input,
    kind: 'video', displayName: 'H3', executionMode: 'async-query', operations: ['text-to-video', 'image-to-video'], capabilities }] }),
    getRuntimeVideoV3: jest.fn().mockResolvedValue({ executionAvailable: true, executionMode: 'real', profiles: [{ ...input,
      authorized: true, operations: ['text-to-video', 'image-to-video'], adapter: { available: true, operations: ['text-to-video', 'image-to-video'] } }] }) };
  const service = new MediaVideoRealService(config as never, db as never, { getEffectiveValue: async () => '7' } as never,
    runtime as never, adapter as never, cache as never, billing as never, store, recoveryLease);
  async function submit(clientRequestId = 'new-video') {
    const quote = await service.quote(videoClaims, value);
    const request = { ...value, clientRequestId, quoteId: quote.quoteId };
    return { request, receipt: await service.submit(videoClaims, request) };
  }
  return { db, store, adapter, cache, billing, config, runtime, service, submit };
}

describe('MediaVideoRealService v2 client receipts', () => {
  it('ends a changed-payment quote without generation, billing uncertainty or polling', async () => {
    const h = harness();
    h.billing.reserve.mockRejectedValueOnce(new HttpException({ error: { code: 'PAYMENT_MODE_CHANGED', message: '付款方式已变化，请重新报价' } }, 409));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_RESERVED', errorCode: 'CONFIG_CHANGED',
      execution: { submissionStatus: 'not_submitted', billing: { status: 'not_charged' } },
      clientActions: { shouldPoll: false, canStartNewRequest: true } });
    expect(h.adapter.submitContract).not.toHaveBeenCalled();
  });
  it('saves and settles the original task in the background after restart without a client token', async () => {
    const h = harness(); const { receipt } = await h.submit();
    const restarted = new MediaVideoRealService(h.config as never, h.db as never, {} as never, h.runtime as never,
      h.adapter as never, h.cache as never, h.billing as never, h.store);
    await restarted.recoverPending(scope, receipt.receiptId);
    expect(await h.store.findRequest(scope, receipt.receiptId)).toMatchObject({ receipt: {
      status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'SETTLED', clientActions: { shouldPoll: false },
    } });
    await restarted.recoverPending(scope, receipt.receiptId);
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1); expect(h.adapter.queryContract).toHaveBeenCalledTimes(1);
    expect(h.cache.saveOutput).toHaveBeenCalledTimes(1); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('shares recovery between background work and a concurrent client query', async () => {
    const h = harness(); const { receipt } = await h.submit();
    await Promise.all([h.service.recoverPending(scope, receipt.receiptId), h.service.receipt(videoClaims, receipt.receiptId)]);
    expect(h.adapter.queryContract).toHaveBeenCalledTimes(1); expect(h.cache.saveOutput).toHaveBeenCalledTimes(1);
    expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('waits for a live submission and never resubmits when recovering a lost response', async () => {
    const h = harness(); const { receipt } = await h.submit();
    const row = h.db.state.requests.get(receipt.receiptId);
    row.status = row.receipt.status = 'SUBMITTING'; row.configuration.dispatchState = 'DISPATCHING';
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(h.adapter.queryContract).not.toHaveBeenCalled();
    row.submissionDeadline = new Date(Date.now() - 1);
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(h.adapter.queryContract).toHaveBeenCalledTimes(1); expect(h.adapter.submitContract).toHaveBeenCalledTimes(1);
  });

  it('keeps detailed background download errors and retries the same file without another charge', async () => {
    const h = harness(); const { receipt } = await h.submit();
    h.cache.saveOutput.mockRejectedValueOnce(new HttpException({ error: { message: 'Synthetic disk full', code: 'ENOSPC' } }, 503));
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(await h.store.findRequest(scope, receipt.receiptId)).toMatchObject({ receipt: {
      fileStatus: 'download_failed', execution: { generationStatus: 'completed', operation: 'download',
        operationError: { body: { error: { code: 'ENOSPC', message: 'Synthetic disk full' } } } },
    } });
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(await h.store.findRequest(scope, receipt.receiptId)).toMatchObject({ receipt: { status: 'SUCCEEDED' } });
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('continues billing recovery but does not save a file after owner access is revoked', async () => {
    const h = harness(); const { receipt } = await h.submit(); h.db.enterpriseMember.findFirst.mockResolvedValue(null);
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(h.cache.saveOutput).not.toHaveBeenCalled(); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
    expect(await h.store.findRequest(scope, receipt.receiptId)).toMatchObject({ receipt: {
      execution: { generationStatus: 'completed', operationError: { status: 403 } }, fileStatus: 'download_failed',
    } });
  });

  it('skips recovery owned by another backend instance', async () => {
    const lease = { acquire: jest.fn().mockResolvedValue(null) };
    const h = harness(lease as never); const { receipt } = await h.submit();
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(lease.acquire).toHaveBeenCalledWith(receipt.receiptId);
    expect(h.adapter.queryContract).not.toHaveBeenCalled(); expect(h.cache.saveOutput).not.toHaveBeenCalled();
  });

  it('uses a shared lease across two service instances and returns the original pending receipt', async () => {
    const owners = new Map<string, string>();
    const redis = {
      set: jest.fn(async (key: string, token: string) => {
        if (owners.has(key)) return null;
        owners.set(key, token); return 'OK';
      }),
      eval: jest.fn(async (_script: string, _count: number, key: string, token: string) => {
        if (owners.get(key) !== token) return 0;
        owners.delete(key); return 1;
      }),
    };
    const h = harness(new MediaVideoRecoveryLeaseService({ redis } as never));
    const other = new MediaVideoRealService(h.config as never, h.db as never, {} as never, h.runtime as never,
      h.adapter as never, h.cache as never, h.billing as never, h.store,
      new MediaVideoRecoveryLeaseService({ redis } as never));
    const { receipt } = await h.submit();
    let finish: () => void;
    h.adapter.queryContract.mockImplementationOnce((_c, id) => new Promise(resolve => {
      finish = () => resolve(contractResult(id, { status: 'completed', billing: { status: 'settled', actual_cost_usd: '0.1' } }));
    }));
    const background = h.service.recoverPending(scope, receipt.receiptId);
    await new Promise(resolve => setImmediate(resolve));
    expect(await other.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'QUEUED' });
    expect(h.adapter.queryContract).toHaveBeenCalledTimes(1); finish!(); await background;
    expect(await other.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(h.cache.saveOutput).toHaveBeenCalledTimes(1); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
    expect(owners.size).toBe(0);
  });

  it('does not apply settlement or download after losing the shared lease', async () => {
    const assertHeld = jest.fn(); const release = jest.fn();
    const h = harness({ acquire: jest.fn().mockResolvedValue({ assertHeld, release }) } as never);
    const { receipt } = await h.submit();
    h.adapter.queryContract.mockImplementationOnce(async (_c, id) => {
      assertHeld.mockImplementation(() => { throw new HttpException('Synthetic recovery lease lost', 503); });
      return contractResult(id, { status: 'completed', billing: { status: 'settled', actual_cost_usd: '0.1' } });
    });
    await h.service.recoverPending(scope, receipt.receiptId);
    expect(h.billing.settleNegotiated).not.toHaveBeenCalled(); expect(h.cache.saveOutput).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps finalized receipts readable during a recovery Redis outage', async () => {
    const lease = { acquire: jest.fn().mockResolvedValue({ assertHeld: jest.fn(), release: jest.fn() }) };
    const h = harness(lease as never); const { receipt } = await h.submit();
    await h.service.recoverPending(scope, receipt.receiptId); lease.acquire.mockReset().mockRejectedValue(new Error('Synthetic Redis outage'));
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED' });
    expect(lease.acquire).not.toHaveBeenCalled();
  });

  it('preserves pending client receipts and the lock failure reason during a Redis outage', async () => {
    const h = harness({ acquire: jest.fn().mockRejectedValue(new HttpException({ error: {
      code: 'VIDEO_RECOVERY_LOCK_UNAVAILABLE', message: 'Synthetic Redis unavailable',
    } }, 503)) } as never);
    const { receipt } = await h.submit();
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'QUEUED', billingStatus: 'RECONCILING',
      execution: { submissionStatus: 'accepted', generationStatus: 'queued', operation: 'query',
        operationError: { status: 503, body: { error: { code: 'VIDEO_RECOVERY_LOCK_UNAVAILABLE', message: 'Synthetic Redis unavailable' } } } },
    });
    expect(h.adapter.queryContract).not.toHaveBeenCalled(); expect(h.cache.saveOutput).not.toHaveBeenCalled();
    expect(h.billing.release).not.toHaveBeenCalled(); expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('persists request identity, 257s deadline and dispatch marker before exactly one POST', async () => {
    const h = harness();
    h.adapter.submitContract.mockImplementationOnce(async (_c, _v, _m, _r, id) => {
      const row = [...h.db.state.requests.values()][0];
      expect(row.configuration).toMatchObject({ upstreamRequestId: id, dispatchState: 'DISPATCHING', contractVersion: 2 });
      expect(row.submissionDeadline.getTime() - Date.now()).toBeLessThanOrEqual(257000);
      expect(row.submissionDeadline.getTime() - Date.now()).toBeGreaterThan(250000);
      return contractResult(id, {}, 202);
    });
    const { receipt, request } = await h.submit();
    expect(receipt).toMatchObject({ status: 'QUEUED', receiptVersion: 2, clientActions: { pollPurpose: 'generation', canStartNewRequest: false } });
    await h.service.submit(videoClaims, request);
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'rejected', 'not_submitted'])('returns original exhausted %s error, closes generation and refunds', async submission_status => {
    const h = harness();
    h.adapter.submitContract.mockImplementation(async (_c, _v, _m, _r, id) => contractResult(id, { task_id: null,
      submission_status, status: null, billing: { status: 'not_charged', actual_cost_usd: '0' },
      error: { message: 'upstream connection closed', upstream_status: 503 },
      submission_retry: { attempts: 4, max_attempts: 4, exhausted: true, errors: [{ message: 'EOF' }] } }, 502));
    const { receipt, request } = await h.submit();
    expect(MediaVideoRealReceiptSchema.parse(receipt)).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      upstreamError: { status: 502, body: { error: { message: 'upstream connection closed' } } },
      execution: { submissionRetry: { attempts: 4, exhausted: true } },
      clientActions: { generationFinished: true, canStartNewRequest: true, shouldPoll: false } });
    await h.service.submit(videoClaims, request);
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1);
    expect(h.billing.release).toHaveBeenCalledTimes(1);
    expect(h.adapter.queryContract).not.toHaveBeenCalled();
  });

  it('recovers lost submit response by original request ID without reposting', async () => {
    const h = harness(); h.adapter.submitContract.mockRejectedValueOnce(new Error('ECONNRESET'));
    const { receipt, request } = await h.submit();
    expect(receipt).toMatchObject({ status: 'SUBMISSION_UNKNOWN', execution: { taskId: null }, clientActions: { pollPurpose: 'submission' } });
    const recovered = await h.service.findByClientId(videoClaims, request.clientRequestId);
    expect(h.adapter.queryContract).toHaveBeenCalledWith(expect.anything(), receipt.execution!.requestId, null);
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', fileStatus: 'available',
      actualSpec: { frameRate: 24 }, clientActions: { canStartNewRequest: true, shouldPoll: false } });
    expect(h.billing.settleNegotiated).toHaveBeenCalledWith(receipt.receiptId, '0.700000', '0.100000', 'minimax-h3', 'minimax-h3');
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'cancelled'])('closes %s generation without waiting for unknown billing', async status => {
    const h = harness();
    h.adapter.queryContract.mockImplementation(async (_c, id) => contractResult(id, { status, is_final: true,
      task_error: { code: 'provider_failure', message: 'reference rejected' }, billing: { status: 'unknown', actual_cost_usd: null,
        error: { source: 'platform', message: 'settlement database unavailable' } } }));
    const { receipt } = await h.submit();
    const failed = await h.service.receipt(videoClaims, receipt.receiptId);
    expect(failed).toMatchObject({ status: status === 'failed' ? 'FAILED' : 'CANCELLED', billingStatus: 'RECONCILING',
      execution: { taskError: { message: 'reference rejected' }, billing: { error: { message: 'settlement database unavailable' } } },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.billing.release).not.toHaveBeenCalled(); expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('clears submission-unknown once the original queued task has been restored', async () => {
    const h = harness(); h.adapter.submitContract.mockRejectedValueOnce(new Error('socket closed'));
    h.adapter.queryContract.mockImplementationOnce(async (_c, id) => contractResult(id));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'QUEUED', errorCode: null,
      clientActions: { pollPurpose: 'generation', canStartNewRequest: false } });
  });

  it('returns cached task status with query diagnostics rather than failing generation', async () => {
    const h = harness(); const { receipt } = await h.submit();
    h.adapter.queryContract.mockImplementation(async (_c, id) => contractResult(id, { status: 'queued', status_source: 'cached',
      operation: 'query', error: { message: 'upstream 404', upstream_status: 404 } }, 502));
    const result = await h.service.receipt(videoClaims, receipt.receiptId);
    expect(result).toMatchObject({ status: 'QUEUED', execution: { operationError: { status: 502 } }, clientActions: { pollPurpose: 'generation' } });
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('does not infer free failure from missing Redis records', async () => {
    const h = harness(); const { receipt } = await h.submit();
    h.adapter.queryContract.mockRejectedValue(new MediaUpstreamException({ status: 404, body: { message: 'record expired' } }));
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'QUEUED', execution: { operationError: { status: 404 } } });
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('retries download only, preserving completed generation and a single settlement', async () => {
    const h = harness(); h.cache.saveOutput.mockRejectedValueOnce(new HttpException('download interrupted', 502));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ fileStatus: 'download_failed',
      execution: { generationStatus: 'completed' }, clientActions: { pollPurpose: 'delivery', canStartNewRequest: true, canRetryDownload: true } });
    const recovered = await h.service.receipt(videoClaims, receipt.receiptId);
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available' });
    expect(recovered.execution).not.toHaveProperty('operationError'); expect(recovered.upstreamError).toBeUndefined();
    expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1); expect(h.adapter.submitContract).toHaveBeenCalledTimes(1);
  });

  it('clears a resolved download error while retaining historical submission diagnostics', async () => {
    const h = harness(); const { receipt } = await h.submit();
    h.cache.saveOutput.mockRejectedValueOnce(new HttpException('Synthetic content interrupted', 502));
    h.adapter.queryContract.mockImplementationOnce(async (_c, id) => contractResult(id, {
      status: 'completed', submission_error: { code: 'submission_retried', message: 'Synthetic prior submission interruption' },
      http_status: 502, billing: { status: 'settled', actual_cost_usd: '0.1' },
    }));
    await h.service.receipt(videoClaims, receipt.receiptId);
    const recovered = await h.service.receipt(videoClaims, receipt.receiptId);
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', execution: {
      submissionError: { code: 'submission_retried', message: 'Synthetic prior submission interruption' },
    } });
    expect(recovered.execution).not.toHaveProperty('operationError');
    expect(recovered.upstreamError).toMatchObject({ body: { error: { code: 'submission_retried' } } });
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('delivers video while billing is unknown and later drives upstream settlement', async () => {
    const h = harness();
    h.adapter.queryContract.mockImplementationOnce(async (_c, id) => contractResult(id, { status: 'completed', is_final: true,
      billing: { status: 'unknown', actual_cost_usd: null, error: { message: 'database unavailable' } } }));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING',
      recovery: { canDownload: true }, clientActions: { pollPurpose: 'billing', canStartNewRequest: true } });
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ billingStatus: 'SETTLED' });
    expect(h.cache.saveOutput).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent queries before content and billing writes', async () => {
    const h = harness(); const { receipt } = await h.submit();
    await Promise.all([h.service.receipt(videoClaims, receipt.receiptId), h.service.receipt(videoClaims, receipt.receiptId)]);
    expect(h.adapter.queryContract).toHaveBeenCalledTimes(1);
    expect(h.cache.saveOutput).toHaveBeenCalledTimes(1); expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('preserves a reliable task ID on invalid model receipts for subsequent recovery', async () => {
    const h = harness();
    h.adapter.submitContract.mockImplementationOnce(async (_c, _v, _m, _r, id) => contractResult(id, { model: 'unexpected-model' }, 202));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ execution: { taskId: 'task-original', operationError: { status: 502 } } });
    await h.service.receipt(videoClaims, receipt.receiptId);
    expect(h.adapter.queryContract).toHaveBeenCalledWith(expect.anything(), receipt.execution!.requestId, 'task-original');
  });

  it('returns insufficient funds as a saved client receipt and never submits', async () => {
    const h = harness(); h.billing.reserve.mockRejectedValueOnce(new HttpException({ error: { message: '余额不足' } }, 402));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_RESERVED', billingError: { status: 402 },
      clientActions: { shouldPoll: false, canStartNewRequest: true } });
    expect(h.adapter.submitContract).not.toHaveBeenCalled();
  });

  it('ends undispatched generation independently of an uncertain wallet reservation', async () => {
    const h = harness(); h.billing.reserve.mockRejectedValueOnce(new HttpException('database unavailable', 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING', billingError: { status: 503 },
      execution: { submissionStatus: 'not_submitted' },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    await h.service.receipt(videoClaims, receipt.receiptId);
    expect(h.adapter.submitContract).not.toHaveBeenCalled(); expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('keeps historical recovery available after disabling new execution', async () => {
    const h = harness(); const { receipt, request } = await h.submit(); h.config.get.mockReturnValue('false');
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'SUCCEEDED' });
    await expect(h.service.submit(videoClaims, { ...request, clientRequestId: 'other' })).rejects.toMatchObject({ status: 503 });
    await expect(h.service.receipt({ ...videoClaims, sub: 'another-user' }, receipt.receiptId)).rejects.toMatchObject({ status: 404 });
  });

  it('only enables cancellation when explicitly declared and uses the returned outcome', async () => {
    const h = harness(); h.db.state.model.capabilities.supportsCancel = true;
    const { receipt } = await h.submit(); expect(receipt.recovery.canCancel).toBe(true);
    expect(await h.service.cancel(videoClaims, receipt.receiptId)).toMatchObject({ status: 'CANCELLED', billingStatus: 'RELEASED',
      clientActions: { generationFinished: true, canStartNewRequest: true } });
    await h.service.cancel(videoClaims, receipt.receiptId);
    expect(h.adapter.cancelContract).toHaveBeenCalledTimes(1);
  });

  it('preserves active status and money on a failed cancellation', async () => {
    const h = harness(); h.db.state.model.capabilities.supportsCancel = true;
    h.adapter.cancelContract.mockRejectedValueOnce(new HttpException('upstream cancel unavailable', 503));
    const { receipt } = await h.submit();
    expect(await h.service.cancel(videoClaims, receipt.receiptId)).toMatchObject({ status: 'QUEUED',
      execution: { operationError: { status: 503 } }, clientActions: { generationFinished: false } });
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('closes protocol-error video creation, retains diagnostics and never replays generation', async () => {
    const h = harness();
    h.adapter.submitContract.mockImplementationOnce(async (_c, _v, _m, _r, id) => contractResult(id, {
      task_id: 'task-diagnostic', model: 'invalid-provider-model', submission_status: 'protocol_error', status: null,
      billing: { status: 'not_charged', actual_cost_usd: '0' },
      operation_error: { message: 'Invalid upstream model' }, submission_error: { code: 'video_protocol_error', message: 'Invalid upstream model' },
      submission_record_error: { message: 'Association save failed' }, http_status: 502 }, 502));
    const { receipt, request } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', execution: {
      taskId: 'task-diagnostic', submissionStatus: 'protocol_error', submissionError: { code: 'video_protocol_error' },
      submissionRecordError: { message: 'Association save failed' } }, clientActions: { shouldPoll: false, canStartNewRequest: true } });
    await h.service.submit(videoClaims, request);
    expect(h.adapter.submitContract).toHaveBeenCalledTimes(1); expect(h.adapter.queryContract).not.toHaveBeenCalled();
  });

  it.each(['query', 'cancel'] as const)('preserves known video state on unobserved %s', async operation => {
    const h = harness(); h.db.state.model.capabilities.supportsCancel = true;
    const { receipt } = await h.submit();
    const result = contractResult('current-operation', { task_id: null, submission_status: 'unobserved', status: null,
      receipt_operation: operation, billing: { status: 'unknown', actual_cost_usd: null },
      operation_error: { code: 'ACCESS_DENIED', message: 'Cannot read original task' } }, 403);
    if (operation === 'query') h.adapter.queryContract.mockResolvedValueOnce(result);
    else h.adapter.cancelContract.mockResolvedValueOnce(result);
    const updated = operation === 'query' ? await h.service.receipt(videoClaims, receipt.receiptId)
      : await h.service.cancel(videoClaims, receipt.receiptId);
    expect(updated).toMatchObject({ status: 'QUEUED', billingStatus: receipt.billingStatus, execution: {
      requestId: receipt.execution!.requestId, taskId: 'task-original', submissionStatus: 'accepted', generationStatus: 'queued',
      operation, operationError: { status: 403 } }, clientActions: { canStartNewRequest: false } });
    expect(h.billing.release).not.toHaveBeenCalled(); expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('stops output recovery after its original expiry without extending retention', async () => {
    const h = harness(); h.cache.saveOutput.mockRejectedValueOnce(new Error('download interrupted'));
    const { receipt } = await h.submit(); await h.service.receipt(videoClaims, receipt.receiptId);
    h.db.state.requests.get(receipt.receiptId).configuration.outputExpiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await h.service.receipt(videoClaims, receipt.receiptId)).toMatchObject({ status: 'RESULT_EXPIRED', fileStatus: 'expired',
      clientActions: { canRetryDownload: false, canStartNewRequest: true, shouldPoll: false } });
    expect(h.cache.saveOutput).toHaveBeenCalledTimes(1);
  });
});
