import { HttpException } from '@nestjs/common';
import { MediaUpstreamException } from '../../common/errors/media-upstream.exception';
import { MediaRealAnyReceiptSchema } from 'shared';
import { imageClaims, imageHarness, imageInput } from './media-async.test-support';
import { contractResult } from './longdao-media.test-support';
import { referenceFixture } from './media-reference.test-support';
import { MEDIA_MOCK_PNG } from './media-gateway-mock.adapter';
import { createHash } from 'node:crypto';

describe('MediaRealService asynchronous client receipts', () => {
  it('keeps a changed payment preference failure definitive and never dispatches generation', async () => {
    const h = imageHarness();
    h.billing.reserve.mockRejectedValueOnce(new HttpException({ error: { code: 'PAYMENT_MODE_CHANGED', message: '付款方式已变化，请重新报价' } }, 409));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'NOT_RESERVED', errorCode: 'CONFIG_CHANGED',
      execution: { submissionStatus: 'not_submitted', billing: { status: 'not_charged' } },
      clientActions: { shouldPoll: false, canStartNewRequest: true },
      billingError: { body: { error: { message: '付款方式已变化，请重新报价' } } } });
    expect(h.adapter.submitAsync).not.toHaveBeenCalled();
  });
  it('quotes without dispatch, returns a pending async receipt and saves the correlation before POST', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementationOnce(async (_input, _refs, _model, id) => {
      const persisted = [...h.records.values()][0];
      expect(persisted.upstreamRequestId).toBe(id);
      expect(persisted.configuration).toMatchObject({ dispatchState: 'DISPATCHING' });
      return contractResult(id, { status: 'processing' }, 202);
    });
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ executionMode: 'async-query', status: 'RUNNING', receiptVersion: 2, outputs: [],
      clientActions: { shouldPoll: true, pollPurpose: 'generation', canStartNewRequest: false } });
    expect(h.billing.reserve).toHaveBeenCalledTimes(1);
    expect(h.adapter.queryAsync).not.toHaveBeenCalled();
    expect(h.adapter.contentAsync).not.toHaveBeenCalled();
    expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
    expect(h.records.get(receipt.receiptId)!.submissionDeadline.getTime() - Date.now()).toBeLessThanOrEqual(70000);
  });

  it.each(['not_submitted', 'rejected', 'failed'])('closes %s with a complete receipt and releases funds before allowing a new request', async submission_status => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, { task_id: null, status: 'failed',
      submission_status, billing: { status: 'not_charged', actual_cost_usd: '0' }, error: { message: 'original provider failure', details: { reason: 'connection closed' } } }, 502));
    const { receipt, request } = await h.submit();
    expect(MediaRealAnyReceiptSchema.parse(receipt)).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      clientActions: { submissionFinished: true, generationFinished: true, canStartNewRequest: true, shouldPoll: false },
      upstreamError: { status: 502, body: { error: { message: 'original provider failure', details: { reason: 'connection closed' } } } } });
    await h.service.submit(imageClaims, request);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
    expect(h.billing.release).toHaveBeenCalledTimes(1);
  });

  it('returns refund failure separately and does not report released funds prematurely', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, { task_id: null,
      submission_status: 'failed', status: null, billing: { status: 'not_charged', actual_cost_usd: '0' }, error: { message: 'EOF' } }, 502));
    h.billing.release.mockRejectedValueOnce(new HttpException('database unavailable', 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING',
      billingError: { status: 503 }, clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    const recovered = await h.service.receipt(imageClaims, receipt.receiptId);
    // The query is the authoritative retry of the original closed request.
    expect(recovered.execution!.requestId).toBe(receipt.execution!.requestId);
  });

  it('keeps a closed creation separate from Longdao billing unknown', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, { task_id: null,
      submission_status: 'failed', status: 'failed', billing: { status: 'unknown', actual_cost_usd: null,
        error: { source: 'platform', message: 'ledger unavailable' } } }, 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING', execution: { billing: { status: 'unknown' } },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.billing.release).not.toHaveBeenCalled();
    expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('recovers a lost POST response by original request ID without a second POST', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockRejectedValueOnce(new Error('socket closed'));
    const { receipt, request } = await h.submit();
    expect(receipt.status).toBe('SUBMISSION_UNKNOWN');
    const recovered = await h.service.findByClientId(imageClaims, request.clientRequestId);
    expect(h.adapter.queryAsync).toHaveBeenCalledWith(expect.anything(), receipt.execution!.requestId, null);
    expect(recovered).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'SETTLED', fileStatus: 'available',
      clientActions: { canStartNewRequest: true, shouldPoll: false } });
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it('does not interpret a lookup 404 or Redis failure as free failure', async () => {
    const h = imageHarness();
    const { receipt } = await h.submit();
    h.adapter.queryAsync.mockRejectedValue(new MediaUpstreamException({ status: 404, body: { error: { message: 'request expired' } } }));
    const result = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(result).toMatchObject({ status: 'RUNNING', execution: { generationStatus: 'in_progress', operationError: { status: 404 } } });
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('clears submission-unknown after finding the accepted task without claiming generation success', async () => {
    const h = imageHarness(); h.adapter.submitAsync.mockRejectedValueOnce(new Error('socket closed'));
    h.adapter.queryAsync.mockImplementationOnce(async (_c, id) => contractResult(id, { status: 'processing' }));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ status: 'RUNNING', errorCode: null,
      execution: { submissionStatus: 'accepted' }, clientActions: { pollPurpose: 'generation', canStartNewRequest: false } });
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('saves and returns original %s bytes and measured metadata', async mimeType => {
    const h = imageHarness();
    const bytes = mimeType === 'image/png' ? MEDIA_MOCK_PNG : await referenceFixture(mimeType === 'image/jpeg' ? 'jpeg' : 'webp');
    h.adapter.contentAsync.mockResolvedValue({ bytes, metadata: { mimeType, width: 1, height: 1 } });
    const { receipt } = await h.submit();
    const complete = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(complete.outputs[0].mimeType).toBe(mimeType);
    expect(h.cache.put).toHaveBeenCalledWith('output', expect.any(String), expect.any(String), bytes, expect.any(String));
    expect(h.billing.settleNegotiated).toHaveBeenCalledWith(receipt.receiptId, '0.576000', '0.080000', 'gpt-image-2', 'gpt-image-2');
    await h.service.receipt(imageClaims, receipt.receiptId);
    expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
    expect(h.adapter.contentAsync).toHaveBeenCalledTimes(1);
  });

  it('preserves completed generation when download fails, then retries only download', async () => {
    const h = imageHarness();
    h.adapter.contentAsync.mockRejectedValueOnce(new HttpException({ error: { message: 'content expired' } }, 502));
    const { receipt } = await h.submit();
    const failed = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(failed).toMatchObject({ fileStatus: 'download_failed', execution: { generationStatus: 'completed' },
      clientActions: { generationFinished: true, canRetryDownload: true, canStartNewRequest: true, pollPurpose: 'delivery' } });
    await h.service.receipt(imageClaims, receipt.receiptId);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
    expect(h.adapter.contentAsync).toHaveBeenCalledTimes(2);
  });

  it('delivers completed images even when Longdao settlement is unavailable', async () => {
    const h = imageHarness();
    h.adapter.queryAsync.mockImplementation(async (_c, id) => contractResult(id, { status: 'completed', is_final: true,
      billing: { status: 'unknown', actual_cost_usd: null, error: { source: 'platform', message: 'settlement failed' } } }));
    const { receipt } = await h.submit();
    const complete = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(complete).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'RECONCILING',
      recovery: { canDownload: true }, clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('retries upstream task query to drive a failed upstream settlement', async () => {
    const h = imageHarness();
    h.adapter.queryAsync.mockImplementationOnce(async (_c, id) => contractResult(id, { status: 'completed',
      billing: { status: 'unknown', actual_cost_usd: null } }));
    const { receipt } = await h.submit();
    await h.service.receipt(imageClaims, receipt.receiptId);
    expect((await h.service.receipt(imageClaims, receipt.receiptId)).billingStatus).toBe('SETTLED');
    expect(h.adapter.queryAsync).toHaveBeenCalledTimes(2);
    expect(h.adapter.contentAsync).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent creation and query/download within a process', async () => {
    const h = imageHarness();
    const quote = await h.service.quote(imageClaims, imageInput);
    const req = { ...imageInput, quoteId: quote.quoteId, clientRequestId: 'same' };
    const results = await Promise.all([h.service.submit(imageClaims, req), h.service.submit(imageClaims, req)]);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
    await Promise.all([h.service.receipt(imageClaims, results[0].receiptId), h.service.receipt(imageClaims, results[0].receiptId)]);
    expect(h.adapter.contentAsync).toHaveBeenCalledTimes(1);
    expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it('rejects changed payload under an existing client ID without dispatching', async () => {
    const h = imageHarness(); const { request } = await h.submit();
    await expect(h.service.submit(imageClaims, { ...request, creativeBrief: 'different' })).rejects.toMatchObject({ status: 409 });
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported counts and references before quoting or reserving', async () => {
    const h = imageHarness();
    await expect(h.service.quote(imageClaims, { ...imageInput, requestedSpec: { ...imageInput.requestedSpec, count: 2 } })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.quote(imageClaims, { ...imageInput, operation: 'edit', referenceIds: ['1', '2', '3', '4', '5'] })).rejects.toMatchObject({ status: 422 });
    expect(h.adapter.pricing).not.toHaveBeenCalled();
    expect(h.billing.reserve).not.toHaveBeenCalled();
  });

  it('keeps recovery authorized and available after disabling creation; another scope is denied', async () => {
    const h = imageHarness(); const { receipt, request } = await h.submit();
    h.config.get.mockReturnValue('false');
    await expect(h.service.submit(imageClaims, request)).resolves.toMatchObject({ receiptId: receipt.receiptId });
    await expect(h.service.receipt({ ...imageClaims, sub: 'other' }, receipt.receiptId)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.submit(imageClaims, { ...request, clientRequestId: 'new' })).rejects.toMatchObject({ status: 503 });
  });

  it('keeps uncommitted reservation outcomes from causing dispatch', async () => {
    const h = imageHarness();
    h.billing.reserve.mockRejectedValueOnce(new HttpException('database unavailable', 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING', billingError: { status: 503 },
      execution: { submissionStatus: 'not_submitted' },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.adapter.submitAsync).not.toHaveBeenCalled();
  });

  it('never calls async upstream from the legacy periodic reconciliation scan', async () => {
    const h = imageHarness(); await h.submit(); await h.service.reconcilePending();
    expect(h.adapter.queryAsync).not.toHaveBeenCalled();
  });

  it('retains legacy finalized synchronous receipts without a new upstream submission', async () => {
    const h = imageHarness(); const { receipt } = await h.submit();
    const record = h.records.get(receipt.receiptId)!;
    delete record.receipt.execution; delete record.receipt.clientActions;
    record.receipt.executionMode = 'sync-response'; record.receipt.status = 'FAILED'; record.receipt.billingStatus = 'RELEASED';
    expect((await h.service.receipt(imageClaims, receipt.receiptId)).status).toBe('FAILED');
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it.each(['jpeg', 'webp'] as const)('uploads and preserves original %s reference metadata', async format => {
    const h = imageHarness(); const bytes = await referenceFixture(format);
    const reference = await h.service.uploadReference(imageClaims, { buffer: bytes, size: bytes.length,
      mimetype: `image/${format}`, originalname: `source.${format}` } as Express.Multer.File);
    expect(reference).toMatchObject({ referenceId: 'reference', mimeType: `image/${format}`, width: 3, height: 2,
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(h.cache.put).toHaveBeenCalledWith('reference', expect.any(String), 'reference', bytes, reference.expiresAt);
    expect(h.adapter.submitAsync).not.toHaveBeenCalled();
  });

  it('rejects a mismatched reference MIME before writing bytes or metadata', async () => {
    const h = imageHarness(); const bytes = await referenceFixture('jpeg');
    await expect(h.service.uploadReference(imageClaims, { buffer: bytes, size: bytes.length, mimetype: 'image/png' } as Express.Multer.File))
      .rejects.toMatchObject({ status: 400 });
    expect(h.store.saveReference).not.toHaveBeenCalled(); expect(h.cache.put).not.toHaveBeenCalled();
  });

  it.each(['subscription', 'profile', 'model', 'switch'] as const)('rechecks %s after reserving and closes locally before dispatch', async change => {
    const h = imageHarness();
    h.billing.reserve.mockImplementationOnce(async (_c, id) => {
      h.journals.set(id, 'RESERVED');
      if (change === 'subscription') h.prisma.subscription.findFirst.mockResolvedValue(null);
      if (change === 'profile') h.profile.enabled = false;
      if (change === 'model') h.profile.modelId = 'another-model';
      if (change === 'switch') h.config.get.mockReturnValue('false');
    });
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      execution: { submissionStatus: 'not_submitted' }, clientActions: { generationFinished: true, canStartNewRequest: true, shouldPoll: false } });
    expect(h.adapter.submitAsync).not.toHaveBeenCalled(); expect(h.billing.release).toHaveBeenCalledTimes(1);
  });

  it('retries a local refund without requiring provider lookup or a fresh POST', async () => {
    const h = imageHarness();
    h.billing.reserve.mockImplementationOnce(async (_c, id) => { h.journals.set(id, 'RESERVED'); h.profile.enabled = false; });
    h.billing.release.mockRejectedValueOnce(new HttpException('refund database unavailable', 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ billingStatus: 'RECONCILING', billingError: { status: 503 },
      clientActions: { generationFinished: true, canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ billingStatus: 'RELEASED' });
    expect(h.adapter.submitAsync).not.toHaveBeenCalled(); expect(h.adapter.queryAsync).not.toHaveBeenCalled();
  });

  it('enforces changed configured reference limits at quote and submit', async () => {
    const h = imageHarness();
    const input = { ...imageInput, operation: 'edit' as const, referenceIds: ['front', 'side', 'scene'] };
    const quote = await h.service.quote(imageClaims, input); h.profile.capabilities.maxReferenceCount = 2;
    await expect(h.service.quote(imageClaims, input)).rejects.toMatchObject({ status: 422 });
    await expect(h.service.submit(imageClaims, { ...input, quoteId: quote.quoteId, clientRequestId: 'three' })).rejects.toMatchObject({ status: 422 });
    expect(h.billing.reserve).not.toHaveBeenCalled(); expect(h.adapter.submitAsync).not.toHaveBeenCalled();
  });

  it('checks model and original amount for usage v2 that omits image_count', async () => {
    const h = imageHarness(); h.adapter.usage.mockImplementation(async request_id => ({ schema_version: 2, request_id,
      status: 'settled', model: 'gpt-image-2', actual_cost_usd: '0.08' } as any));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ billingStatus: 'SETTLED' });
    expect(h.billing.settleNegotiated).toHaveBeenCalledTimes(1);
  });

  it.each(['model', 'request_id', 'actual_cost_usd'] as const)('keeps invalid %s billing evidence pending while delivering the original', async field => {
    const h = imageHarness(); h.adapter.usage.mockImplementation(async request_id => ({ request_id, status: 'settled',
      model: 'gpt-image-2', actual_cost_usd: '0.08', image_count: 1, [field]: field === 'actual_cost_usd' ? '0.2' : 'wrong' }));
    const { receipt } = await h.submit();
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING',
      billingError: { status: 409 }, clientActions: { canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('preserves measured size mismatch, allows original download and leaves quality unverified', async () => {
    const h = imageHarness(); h.adapter.contentAsync.mockResolvedValue({ bytes: MEDIA_MOCK_PNG,
      metadata: { mimeType: 'image/png', width: 2, height: 2 } });
    const { receipt } = await h.submit();
    const done = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(done).toMatchObject({ status: 'SUCCEEDED', actualSpec: { size: '2x2', count: 1 },
      acceptance: { status: 'mismatched', mismatchedFields: ['size'], unknownFields: ['quality'] } });
    await expect(h.service.content(imageClaims, receipt.receiptId, done.outputs[0].outputId)).resolves.toMatchObject({ bytes: MEDIA_MOCK_PNG });
  });

  it('bounds download retries to the frozen expiry and does not depend on later task lookup', async () => {
    const h = imageHarness(); h.adapter.contentAsync.mockRejectedValueOnce(new Error('download failed'));
    const { receipt } = await h.submit(); await h.service.receipt(imageClaims, receipt.receiptId);
    (h.records.get(receipt.receiptId)!.configuration as any).outputExpiresAt = new Date(Date.now() - 1000).toISOString();
    h.adapter.queryAsync.mockRejectedValue(new Error('task record expired'));
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ status: 'RESULT_EXPIRED', fileStatus: 'expired',
      clientActions: { shouldPoll: false, canRetryDownload: false, canStartNewRequest: true } });
    expect(h.adapter.queryAsync).toHaveBeenCalledTimes(1); expect(h.adapter.contentAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps terminal generation from reverting when a cached billing query has an older status', async () => {
    const h = imageHarness(); h.adapter.queryAsync
      .mockImplementationOnce(async (_c, id) => contractResult(id, { status: 'failed', is_final: true, task_error: { message: 'reference rejected' } }))
      .mockImplementationOnce(async (_c, id) => contractResult(id, { status: 'processing', is_final: false }));
    const { receipt } = await h.submit(); await h.service.receipt(imageClaims, receipt.receiptId);
    expect(await h.service.receipt(imageClaims, receipt.receiptId)).toMatchObject({ status: 'FAILED',
      execution: { generationStatus: 'failed', taskError: { message: 'reference rejected' } }, clientActions: { generationFinished: true } });
    expect(h.adapter.contentAsync).not.toHaveBeenCalled();
  });
});
