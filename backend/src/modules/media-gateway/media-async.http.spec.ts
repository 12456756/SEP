import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import { MediaRealController } from './media-real.controller';
import { MediaRealGuard } from './media-real.guard';
import { MediaRealService } from './media-real.service';
import { imageClaims, imageHarness, imageInput } from './media-async.test-support';
import { contractResult } from './longdao-media.test-support';
import { referenceFixture } from './media-reference.test-support';

const root = '/api/gateway/v1/media/real';
describe('asynchronous image receipts through the actual HTTP pipeline', () => {
  let app: INestApplication;
  let h: ReturnType<typeof imageHarness>;
  const post = (path: string) => request(app.getHttpServer()).post(root + path).set('Authorization', 'Bearer employment');
  const get = (path: string) => request(app.getHttpServer()).get(root + path).set('Authorization', 'Bearer employment');
  beforeEach(async () => {
    h = imageHarness();
    const module = await Test.createTestingModule({ controllers: [MediaRealController], providers: [MediaRealGuard,
      { provide: MediaRealService, useValue: h.service }] }).overrideGuard(ClientEmploymentGuard).useValue({
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        if (req.headers.authorization !== 'Bearer employment') throw new UnauthorizedException();
        req.clientEmployment = imageClaims; return true;
      },
    }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  afterEach(async () => app?.close());
  async function submit() {
    const quote = await post('/quotes').send(imageInput).expect(201);
    return post('/requests').send({ ...imageInput, quoteId: quote.body.quoteId, clientRequestId: 'http-image' });
  }

  it('returns 202 while running and 200 after query without extra generation', async () => {
    const created = await submit().then(response => response);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ receiptVersion: 2, executionMode: 'async-query',
      execution: { submissionStatus: 'accepted', generationStatus: 'in_progress' }, clientActions: { shouldPoll: true } });
    const done = await get(`/requests/${created.body.receiptId}`).expect(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', fileStatus: 'available', billingStatus: 'SETTLED',
      clientActions: { canStartNewRequest: true, shouldPoll: false } });
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it('returns a closed failure receipt with the entire upstream error and explicit client actions', async () => {
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, { task_id: null,
      submission_status: 'failed', status: 'failed', billing: { status: 'not_charged', actual_cost_usd: '0' },
      error: { code: 'permission_error', message: 'Image generation disabled for upstream account', details: { upstream_status: 403 } } }, 502));
    const response = await submit();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', fileStatus: 'unavailable',
      upstreamError: { status: 502, body: { error: { code: 'permission_error', message: 'Image generation disabled for upstream account',
        details: { upstream_status: 403 } } } }, clientActions: { generationFinished: true, canStartNewRequest: true, shouldPoll: false } });
  });

  it('recovers a lost submit response through the client-ID route and preserves original JPEG downloads', async () => {
    const bytes = await referenceFixture('jpeg');
    h.adapter.submitAsync.mockRejectedValueOnce(new Error('socket closed'));
    h.adapter.contentAsync.mockResolvedValue({ bytes, metadata: { mimeType: 'image/jpeg', width: 3, height: 2 } });
    h.cache.get.mockResolvedValue(bytes);
    const created = await submit(); expect(created.status).toBe(202);
    const done = await get('/requests/by-client-id/http-image').expect(200);
    expect(done.body.execution.requestId).toBe(created.body.execution.requestId);
    const download = await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(download.headers['content-type']).toBe('image/jpeg');
    expect(download.headers['content-disposition']).toContain('.jpg'); expect(download.body).toEqual(bytes);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });

  it('returns concrete download failure while reporting completed generation separately', async () => {
    h.adapter.contentAsync.mockRejectedValueOnce(new Error('source URL expired'));
    const created = await submit();
    const result = await get(`/requests/${created.body.receiptId}`).expect(200);
    expect(result.body).toMatchObject({ fileStatus: 'download_failed', execution: { generationStatus: 'completed',
      operationError: { body: { error: { message: 'source URL expired' } } } },
      clientActions: { generationFinished: true, canRetryDownload: true, canStartNewRequest: true, pollPurpose: 'delivery' } });
  });

  it('keeps a delivered result accessible while billing still needs reconciliation', async () => {
    h.adapter.queryAsync.mockImplementation(async (_c, id) => contractResult(id, { status: 'completed', is_final: true,
      billing: { status: 'unknown', actual_cost_usd: null, error: { message: 'database unavailable', source: 'platform' } } }));
    const created = await submit(); const done = await get(`/requests/${created.body.receiptId}`).expect(200);
    expect(done.body).toMatchObject({ status: 'SUCCEEDED', billingStatus: 'RECONCILING', pollAfterMs: 15000,
      clientActions: { generationFinished: true, pollPurpose: 'billing', canStartNewRequest: true }, recovery: { canDownload: true } });
    await get(`/requests/${done.body.receiptId}/outputs/${done.body.outputs[0].outputId}/content`).expect(200);
    expect(h.billing.release).not.toHaveBeenCalled();
  });

  it('requires employment authentication before querying or generating', async () => {
    await request(app.getHttpServer()).post(root + '/requests').send(imageInput).expect(401);
    await request(app.getHttpServer()).get(root + '/requests/by-client-id/http-image').expect(401);
    expect(h.adapter.submitAsync).not.toHaveBeenCalled();
  });

  it('returns an ended protocol-error receipt including storage diagnostics to the actual client', async () => {
    h.adapter.submitAsync.mockImplementation(async (_i, _r, _m, id) => contractResult(id, { task_id: 'diagnostic-task',
      submission_status: 'protocol_error', status: null, billing: { status: 'not_charged', actual_cost_usd: '0' },
      receipt_operation: 'create', operation_error: { code: 'image_protocol_error', message: 'Invalid task status' },
      submission_error: { code: 'image_protocol_error', message: 'Invalid task status' },
      submission_record_error: { message: 'Redis receipt save failed' }, http_status: 502, diagnostic_truncated: true }, 502));
    const response = await submit();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ receiptVersion: 2, status: 'FAILED', billingStatus: 'RELEASED', execution: {
      taskId: 'diagnostic-task', submissionStatus: 'protocol_error', operation: 'create',
      submissionError: { code: 'image_protocol_error', message: 'Invalid task status' }, submissionHttpStatus: 502,
      submissionRecordError: { message: 'Redis receipt save failed' }, diagnosticTruncated: true },
      clientActions: { generationFinished: true, shouldPoll: false, canStartNewRequest: true } });
    const cached = await get(`/requests/${response.body.receiptId}`).expect(200);
    expect(cached.body.execution.submissionError).toEqual(response.body.execution.submissionError);
    expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1); expect(h.adapter.queryAsync).not.toHaveBeenCalled();
  });

  it('recovers a pre-dispatch rejection and distinguishes successful lookup from original creation failure', async () => {
    h.adapter.submitAsync.mockRejectedValueOnce(new Error('socket closed'));
    h.adapter.queryAsync.mockImplementationOnce(async (_c, id) => contractResult(id, { task_id: null, submission_status: 'not_submitted',
      status: null, billing: { status: 'not_charged', actual_cost_usd: '0' }, receipt_operation: 'query', operation_error: null,
      submission_error: { code: 'API_KEY_EXPIRED', message: 'API key expired' }, http_status: 403 }));
    const created = await submit(); expect(created.status).toBe(202);
    const recovered = await get('/requests/by-client-id/http-image').expect(200);
    expect(recovered.body).toMatchObject({ status: 'FAILED', billingStatus: 'RELEASED', execution: { operation: 'query',
      submissionStatus: 'not_submitted', submissionError: { code: 'API_KEY_EXPIRED', message: 'API key expired' }, submissionHttpStatus: 403 },
      clientActions: { shouldPoll: false, canStartNewRequest: true } });
    expect(recovered.body.execution.operationError).toBeUndefined(); expect(h.adapter.submitAsync).toHaveBeenCalledTimes(1);
  });
});
