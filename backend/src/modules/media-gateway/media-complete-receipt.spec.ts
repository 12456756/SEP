import { createHash } from 'node:crypto';
import { MediaRealAnyReceiptSchema } from 'shared';
import { closedSubmission, executionEvidence, mediaClientActions, readLongdaoMedia } from './longdao-media-contract';
import { contractResult } from './longdao-media.test-support';
import { imageClaims, imageHarness } from './media-async.test-support';
import { Sub2apiImageAdapter } from './sub2api-image.adapter';
import { Sub2apiVideoAdapter } from './sub2api-video.adapter';

const originalError = { source: 'platform', code: 'media_protocol_error', message: 'Invalid provider task status', details: { status: 'unexpected' } };
const metadata = {
  schema_version: 2, request_id: 'original', task_id: null, receipt_operation: 'create',
  submission_status: 'not_submitted', status: null, is_final: null,
  status_observed_at: null, status_source: null, task_error: null,
  error: null, operation_error: null, submission_error: null, submission_retry: null,
  billing: { status: 'not_charged', actual_cost_usd: '0', error: null },
};

describe('complete Longdao receipts and client recovery', () => {
  it.each([400, 401, 402, 403, 409, 413, 422, 429, 500, 502, 503, 504])('closes explicit pre-dispatch HTTP %s failures', async httpStatus => {
    const body = { ...metadata, operation: 'create', error: originalError, operation_error: originalError, submission_error: originalError };
    const result = await readLongdaoMedia(new Response(JSON.stringify(body), { status: httpStatus }), 'fixture-key', 'original', undefined, true);
    const evidence = executionEvidence(result);
    expect(evidence).toMatchObject({ submissionStatus: 'not_submitted', submissionError: originalError, submissionHttpStatus: httpStatus });
    expect(closedSubmission(evidence)).toBe(true);
    expect(mediaClientActions(evidence, 'unavailable', false)).toMatchObject({ shouldPoll: false, canStartNewRequest: true });
  });

  it('keeps a protocol-error task ID while ending creation without charging', async () => {
    const body = { ...metadata, task_id: 'task-retained', submission_status: 'protocol_error',
      operation_error: originalError, submission_error: originalError };
    const result = await readLongdaoMedia(new Response(JSON.stringify(body), { status: 502 }), 'fixture-key', 'original', undefined, true);
    const evidence = executionEvidence(result);
    expect(evidence).toMatchObject({ taskId: 'task-retained', submissionStatus: 'protocol_error', submissionError: originalError });
    expect(closedSubmission(evidence)).toBe(true);
    expect(mediaClientActions(evidence, 'unavailable', false)).toMatchObject({ generationFinished: true, shouldPoll: false, canStartNewRequest: true });
  });

  it('keeps historical creation diagnostics separate from a successful recovery query', async () => {
    const body = { ...metadata, receipt_operation: 'query', operation: 'query', submission_status: 'failed',
      submission_error: originalError, http_status: 502, error: originalError, operation_error: null,
      submission_record_error: { message: 'Redis unavailable when saving failure' }, diagnostic_truncated: true };
    const evidence = executionEvidence(await readLongdaoMedia(new Response(JSON.stringify(body)), 'fixture-key', 'original'));
    expect(evidence).toMatchObject({ submissionError: originalError, submissionHttpStatus: 502,
      submissionRecordError: { message: 'Redis unavailable when saving failure' }, diagnosticTruncated: true });
    expect(evidence.operationError).toBeUndefined();
    expect(evidence.taskError).toBeUndefined();
  });

  it('accepts an unobserved query correlation without treating it as original-task evidence', async () => {
    const body = { ...metadata, request_id: 'current-query', receipt_operation: 'query', submission_status: 'unobserved',
      billing: { status: 'unknown', actual_cost_usd: null, error: { message: 'No original record' } },
      error: { code: 'not_found', message: 'Original record is unavailable' } };
    const result = await readLongdaoMedia(new Response(JSON.stringify(body), { status: 404 }), 'fixture-key', 'original', 'known-task');
    expect(result.contract.submission_status).toBe('unobserved');
    expect(executionEvidence(result).operationError).toMatchObject({ status: 404, body: { request_id: 'current-query' } });
    await expect(readLongdaoMedia(new Response(JSON.stringify({ ...body, task_id: 'other-task' }), { status: 404 }),
      'fixture-key', 'original', 'known-task')).rejects.toBeDefined();
  });

  it.each(['unobserved', 'not_applicable'])('never treats %s as a confirmed creation outcome', async submission_status => {
    const body = { ...metadata, submission_status };
    await expect(readLongdaoMedia(new Response(JSON.stringify(body), { status: 403 }),
      'fixture-key', 'original', undefined, true)).rejects.toBeDefined();
  });

  it('returns a closed protocol error to the client and does not generate or query again', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, {
      task_id: 'task-retained', model: 'invalid-provider-model', submission_status: 'protocol_error', status: null,
      billing: metadata.billing, submission_error: originalError, operation_error: originalError }, 502));
    const { receipt, request } = await h.submit();
    expect(MediaRealAnyReceiptSchema.parse(receipt)).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      execution: { submissionStatus: 'protocol_error', taskId: 'task-retained', submissionError: originalError },
      clientActions: { canStartNewRequest: true, shouldPoll: false } });
    await h.service.submit(imageClaims, request);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
    expect(h.adapter.queryAsync).not.toHaveBeenCalled();
    expect(h.billing.settleCompute).toHaveBeenCalledTimes(1);
  });

  it('preserves known image state and reserved funds on an unobserved query', async () => {
    const h = imageHarness(); const { receipt } = await h.submit();
    h.adapter.queryAsync.mockImplementationOnce(async () => contractResult('current-query', {
      ...metadata, request_id: 'current-query', receipt_operation: 'query', submission_status: 'unobserved',
      billing: { status: 'unknown', actual_cost_usd: null }, operation_error: { code: 'ACCESS_DENIED', message: 'Original key disabled' } }, 403));
    const result = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(result).toMatchObject({ status: 'RUNNING', billingStatus: receipt.billingStatus, execution: {
      requestId: receipt.execution!.requestId, taskId: 'task-original', submissionStatus: 'accepted', generationStatus: 'in_progress',
      operation: 'query', operationError: { status: 403, body: { request_id: 'current-query' } } } });
    expect(h.billing.release).not.toHaveBeenCalled(); expect(h.billing.settleNegotiated).not.toHaveBeenCalled();
  });

  it('recovers a failed image by request ID and retains the original error after repeated reads', async () => {
    const h = imageHarness(); h.adapter.submitAsync.mockRejectedValueOnce(new Error('socket closed'));
    const { receipt } = await h.submit();
    h.adapter.queryAsync.mockImplementationOnce(async (_c, id) => contractResult(id, { ...metadata, request_id: id,
      receipt_operation: 'query', operation: 'query', submission_status: 'failed', submission_error: originalError, http_status: 422 }));
    const recovered = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(recovered).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', execution: {
      submissionError: originalError, submissionHttpStatus: 422, operation: 'query' },
      upstreamError: { status: 422, body: { error: originalError } }, clientActions: { shouldPoll: false, canStartNewRequest: true } });
    expect(recovered.execution!.operationError).toBeUndefined();
    expect((await h.service.receipt(imageClaims, receipt.receiptId)).execution!.submissionError).toEqual(originalError);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it('reconciles a closed protocol error by original request ID without polling the diagnostic task', async () => {
    const h = imageHarness();
    h.adapter.submitAsync.mockImplementationOnce(async (_i, _r, _m, id) => contractResult(id, { task_id: 'diagnostic-only',
      submission_status: 'protocol_error', status: null, submission_error: originalError,
      billing: { status: 'unknown', actual_cost_usd: null, error: { message: 'Ledger unavailable' } } }, 503));
    const { receipt } = await h.submit();
    expect(receipt).toMatchObject({ status: 'FAILED', billingStatus: 'RECONCILING',
      clientActions: { canStartNewRequest: true, pollPurpose: 'billing' } });
    expect(h.billing.release).not.toHaveBeenCalled();
    h.adapter.queryAsync.mockImplementationOnce(async (_c, id) => contractResult(id, { task_id: 'diagnostic-only',
      submission_status: 'protocol_error', status: null, operation: 'query', operation_error: null,
      billing: { status: 'not_charged', actual_cost_usd: '0' } }));
    const recovered = await h.service.receipt(imageClaims, receipt.receiptId);
    expect(h.adapter.queryAsync).toHaveBeenCalledWith(expect.anything(), receipt.execution!.requestId, null);
    expect(recovered).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED',
      execution: { submissionError: originalError }, clientActions: { shouldPoll: false } });
    expect(h.adapter.contentAsync).not.toHaveBeenCalled(); expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });
});

describe('complete quote and usage response compatibility', () => {
  const connection = { base: 'https://fixture.example/v1', key: 'fixture-key', fingerprint: '' };
  connection.fingerprint = createHash('sha256').update(`${connection.base}\0${connection.key}`).digest('hex');
  const image = { protocolVersion: 3 as const, profileId: 'image', configVersion: 'cfg', specRevision: 1,
    operation: 'generate' as const, referenceIds: [], creativeBrief: 'fixture', requestedSpec: { size: '1024x1024', count: 1, quality: 'medium' } };
  const video = { protocolVersion: 3 as const, profileId: 'video', configVersion: 'cfg', specRevision: 1,
    operation: 'text-to-video' as const, referenceIds: [], creativeBrief: 'fixture', requestedSpec: { durationSeconds: 4, resolution: '720p' } };
  const images = new Sub2apiImageAdapter({} as never), videos = new Sub2apiVideoAdapter({} as never);
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch'); });
  afterEach(() => jest.restoreAllMocks());
  const quoteMetadata = { ...metadata, receipt_operation: 'pricing', submission_status: 'not_applicable',
    billing: { status: 'not_applicable', actual_cost_usd: null, error: null } };
  const price = () => ({ currency: 'USD', billing_mode: 'per_request', pricing_status: 'quoted',
    pricing_source: 'customer_contract', pricing_authority: 'sub2api_customer_billing', amount_usd: '0.1',
    pricing_version: 'price-1', effective_rate_multiplier: 1, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() });
  const respond = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('accepts v2 image quotes with non-task metadata', async () => {
    fetchMock.mockResolvedValueOnce(respond({ ...quoteMetadata, ...price(), object: 'sub2api.image_pricing', model: 'gpt-image-2',
      operation: 'generate', size: '1024x1024', n: 1, quality: 'medium' }));
    expect(await images.pricing(image, 'gpt-image-2', connection)).toMatchObject({ schema_version: 2, amount_usd: '0.1' });
  });

  it('accepts v2 video quotes while preserving the business operation', async () => {
    fetchMock.mockResolvedValueOnce(respond({ ...quoteMetadata, ...price(), object: 'sub2api.video_pricing', model: 'seedance-2.0',
      operation: 'text-to-video', resolution: '720p', duration_seconds: 4 }));
    expect(await videos.pricing(connection, video, 'seedance-2.0')).toMatchObject({ schema_version: 2, amount_usd: '0.1', operation: 'text-to-video' });
  });

  it('accepts video usage metadata without treating financial status as generation status', async () => {
    fetchMock.mockResolvedValueOnce(respond({ ...metadata, receipt_operation: 'usage', operation: 'usage',
      submission_status: 'unobserved', billing: { status: 'settled', actual_cost_usd: '0.1' },
      object: 'sub2api.video_request_usage', currency: 'USD', status: 'settled', model: 'seedance-2.0',
      actual_cost_usd: '0.1', video_count: 1, duration_seconds: 4, resolution: '720p' }));
    expect(await videos.usage(connection, 'original')).toMatchObject({ status: 'settled', actual_cost_usd: '0.1' });
  });
});
