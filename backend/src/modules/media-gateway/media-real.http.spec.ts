import { ExecutionContext, HttpException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { MediaRealReceipt } from 'shared';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ClientEmploymentGuard } from '../client/client-employment.guard';
import type { ClientEmploymentClaims } from '../client/client-employment.guard';
import { MediaRealController } from './media-real.controller';
import { MediaRealGuard } from './media-real.guard';
import { MediaRealService } from './media-real.service';

const root = '/api/gateway/v1/media/real';
const maxReferenceBytes = 5 * 1024 * 1024;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const claims: ClientEmploymentClaims = {
  sub: 'user-a', sid: 'session-a', enterpriseId: 'enterprise-a', subscriptionId: 'subscription-a',
  memberId: 'member-a', type: 'client-employment', iat: 1, exp: 9999999999,
};
const otherClaims: ClientEmploymentClaims = {
  ...claims, sub: 'user-b', sid: 'session-b', enterpriseId: 'enterprise-b', subscriptionId: 'subscription-b', memberId: 'member-b',
};
const profile = {
  profileId: 'image-real', kind: 'image', displayName: 'Real image', configVersion: 'cfg-real',
  operations: ['generate', 'edit'], executionMode: 'sync-response',
  capabilities: { supportsReferenceImage: true, maxOutputs: 4, sizes: ['1024x1024'], maxWidth: 1024, maxHeight: 1024 },
};
const quoteInput = () => ({ profileId: profile.profileId, configVersion: profile.configVersion, operation: 'generate', creativeBrief: '  A red kite  ' });
const submitInput = () => ({ ...quoteInput(), quoteId: 'quote-original', clientRequestId: 'request-original' });
const parsedQuote = () => ({ ...quoteInput(), creativeBrief: 'A red kite', referenceIds: [], parameters: { size: '1024x1024', count: 1, quality: 'medium' } });
const businessError = (status: number, code: string) => new HttpException({ error: {
  code, message: 'Media request unavailable', type: status >= 500 ? 'server_error' : 'invalid_request_error', source: 'platform', param: null,
} }, status);
const receipt = (status: MediaRealReceipt['status'] = 'SUBMISSION_UNKNOWN'): MediaRealReceipt => ({
  mock: false, receiptId: 'receipt-original', clientRequestId: 'request-original', profileId: profile.profileId,
  configVersion: profile.configVersion, executionMode: 'sync-response', status, pollAfterMs: null, outputs: [],
  billingStatus: 'RECONCILING', errorCode: status === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : null, outputErrors: [],
  recovery: { canQuery: true, canCancel: false, canDownload: false },
});

// Exercise the actual router, DTO pipes, multipart interceptor, decorator and real guard.
// All service calls and employment authentication are mocked: no Redis, DB or upstream dispatch.
describe('media real controller/guard HTTP contracts', () => {
  let app: INestApplication;
  const media = {
    assertRealEnabled: jest.fn(), profiles: jest.fn(), uploadReference: jest.fn(), quote: jest.fn(),
    submit: jest.fn(), findByClientId: jest.fn(), receipt: jest.fn(), content: jest.fn(), cancel: jest.fn(),
  };
  const get = (path: string, token = 'employment-a') => request(app.getHttpServer()).get(`${root}${path}`).set('Authorization', `Bearer ${token}`);
  const post = (path: string, token = 'employment-a') => request(app.getHttpServer()).post(`${root}${path}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MediaRealController],
      providers: [MediaRealGuard, { provide: MediaRealService, useValue: media }],
    }).overrideGuard(ClientEmploymentGuard).useValue({
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        const scope = req.headers.authorization === 'Bearer employment-a' ? claims
          : req.headers.authorization === 'Bearer employment-b' ? otherClaims : null;
        if (!scope) throw new UnauthorizedException();
        req.clientEmployment = scope;
        req.user = { sub: 'unrelated-jwt-user', enterpriseId: 'unrelated-enterprise' };
        return true;
      },
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    for (const mock of Object.values(media)) mock.mockReset();
    media.assertRealEnabled.mockResolvedValue(undefined);
    media.profiles.mockResolvedValue({ mock: false, protocolVersion: 1, persistence: 'database', profiles: [profile] });
    media.uploadReference.mockResolvedValue({ mock: false, referenceId: 'reference-original', expiresAt: new Date(Date.now() + 900_000).toISOString(),
      mimeType: 'image/png', byteLength: png.length, sha256: digest, width: 1, height: 1 });
    media.quote.mockResolvedValue({ mock: false, quoteId: 'quote-original', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      semanticSha256: 'a'.repeat(64), pricingStatus: 'quoted', amountCny: '0.120000', pricingVersion: 'price-v1', billingStatus: 'NOT_RESERVED',
      funding: { creditCny: '0.120000', memberWalletCny: '0.000000', personalCny: '0.000000' } });
    media.submit.mockResolvedValue(receipt());
    media.findByClientId.mockResolvedValue(receipt());
    media.receipt.mockResolvedValue(receipt());
    media.content.mockResolvedValue({ output: { outputId: 'output-original', mimeType: 'image/png', sha256: digest }, bytes: png });
    media.cancel.mockRejectedValue(businessError(409, 'CANCEL_UNSUPPORTED'));
  });

  afterAll(async () => { await app?.close(); });

  it('requires employment authentication before running the real-enabled guard', async () => {
    await request(app.getHttpServer()).get(`${root}/profiles`).expect(401);
    await get('/profiles', 'access-token-is-not-employment').expect(401);
    expect(media.assertRealEnabled).not.toHaveBeenCalled();
    expect(media.profiles).not.toHaveBeenCalled();
  });

  it('fails closed in the real guard before multipart buffering or DTO validation', async () => {
    media.assertRealEnabled.mockRejectedValue(businessError(503, 'MEDIA_REAL_DISABLED'));
    const upload = await post('/references').attach('file', png, { filename: 'reference.png', contentType: 'image/png' }).expect(503);
    expect(upload.body.error).toMatchObject({ code: 'MEDIA_REAL_DISABLED', source: 'platform', type: 'server_error' });
    await post('/quotes').send({ invalid: true }).expect(503);
    expect(media.uploadReference).not.toHaveBeenCalled();
    expect(media.quote).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/profiles', 'profiles'],
  ] as const)('gates %s %s when real media is disabled', async (method, path, serviceMethod) => {
    media.assertRealEnabled.mockRejectedValue(businessError(503, 'MEDIA_REAL_DISABLED'));
    const response = await (method === 'GET' ? get(path) : post(path).send({})).expect(503);
    expect(response.body.error.code).toBe('MEDIA_REAL_DISABLED');
    expect(media[serviceMethod]).not.toHaveBeenCalled();
  });

  it('delegates existing request replay and cancellation when execution is disabled', async () => {
    media.assertRealEnabled.mockRejectedValue(businessError(503, 'MEDIA_REAL_DISABLED'));
    await post('/requests').send(submitInput()).expect(202);
    await post('/requests/receipt-original/cancel').expect(409);
    expect(media.assertRealEnabled).not.toHaveBeenCalled();
    expect(media.submit).toHaveBeenCalled(); expect(media.cancel).toHaveBeenCalled();
  });

  it.each([
    ['/requests/by-client-id/request-original', 'findByClientId'], ['/requests/receipt-original', 'receipt'],
    ['/requests/receipt-original/outputs/output-original/content', 'content'],
  ] as const)('keeps authenticated recovery available with new execution disabled: %s', async (path, serviceMethod) => {
    media.assertRealEnabled.mockRejectedValue(businessError(503, 'MEDIA_REAL_DISABLED'));
    await get(path).expect(200);
    expect(media.assertRealEnabled).not.toHaveBeenCalled();
    expect(media[serviceMethod]).toHaveBeenCalled();
  });

  it('returns the exact real profiles envelope without requiring tools or exposing configuration internals', async () => {
    const response = await get('/profiles').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ mock: false, protocolVersion: 1, persistence: 'database', profiles: [profile] });
    expect(media.profiles).toHaveBeenCalledWith(claims, 1);
    expect(media.assertRealEnabled).toHaveBeenCalledTimes(1);
  });

  const invalidPayloads: [string, Record<string, unknown>][] = [
    ['unknown scope', { enterpriseId: 'injected-enterprise' }],
    ['unknown credential', { apiKey: 'fixture-not-a-key' }],
    ['blank brief', { creativeBrief: '   ' }],
    ['oversized brief', { creativeBrief: 'x'.repeat(4001) }],
    ['invalid profile ID', { profileId: '../private' }],
    ['edit without references', { operation: 'edit', referenceIds: [] }],
    ['generate with references', { referenceIds: ['reference-a'] }],
    ['duplicate references', { operation: 'edit', referenceIds: ['reference-a', 'reference-a'] }],
    ['too many references', { operation: 'edit', referenceIds: ['ref-a', 'ref-b', 'ref-c', 'ref-d', 'ref-e'] }],
    ['unsupported size', { parameters: { size: '1x1', count: 1 } }],
    ['too many outputs', { parameters: { count: 5 } }],
    ['zero outputs', { parameters: { count: 0 } }],
    ['unsupported quality', { parameters: { quality: 'automatic' } }],
    ['unknown parameter', { parameters: { seed: 123 } }],
  ];
  it.each(invalidPayloads)('rejects %s in both quote and submit DTOs before service dispatch', async (_label, patch) => {
    for (const [path, input] of [['/quotes', quoteInput()], ['/requests', submitInput()]] as const) {
      const response = await post(path).send({ ...input, ...patch }).expect(400);
      expect(response.body.errors).not.toHaveLength(0);
    }
    expect(media.quote).not.toHaveBeenCalled();
    expect(media.submit).not.toHaveBeenCalled();
  });

  it.each([{ quoteId: undefined }, { clientRequestId: undefined }, { clientRequestId: 'bad id' }, { quoteId: 'bad/id' }])(
    'requires valid quote/client IDs for submission: %j', async patch => {
      await post('/requests').send({ ...submitInput(), ...patch }).expect(400);
      expect(media.submit).not.toHaveBeenCalled();
    },
  );

  it('forwards normalized DTO defaults and employment scope to quote and submit without executing another route', async () => {
    const quoted = await post('/quotes').send(quoteInput()).expect(201);
    expect(quoted.headers['cache-control']).toBe('no-store');
    expect(quoted.body).toEqual(await media.quote.mock.results[0].value);
    expect(media.quote).toHaveBeenCalledWith(claims, parsedQuote());
    expect(media.submit).not.toHaveBeenCalled();
    const submitted = await post('/requests').send(submitInput()).expect(202);
    expect(submitted.headers['cache-control']).toBe('no-store');
    expect(media.submit).toHaveBeenCalledWith(claims, { ...parsedQuote(), quoteId: 'quote-original', clientRequestId: 'request-original' });
  });

  it('accepts one PNG part and forwards its bytes and metadata with no extra fields', async () => {
    const response = await post('/references').attach('file', png, { filename: 'reference.png', contentType: 'image/png' }).expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ mock: false, mimeType: 'image/png', byteLength: png.length, sha256: digest });
    expect(media.uploadReference).toHaveBeenCalledWith(claims, expect.objectContaining({
      fieldname: 'file', originalname: 'reference.png', mimetype: 'image/png', size: png.length, buffer: png,
    }), {});
  });

  it('enforces the reference byte budget in Multer before invoking the service', async () => {
    // The mock service deliberately skips PNG decoding; this test isolates HTTP upload limits.
    const below = Buffer.alloc(maxReferenceBytes - 1);
    png.copy(below);
    await post('/references').attach('file', below, { filename: 'below.png', contentType: 'image/png' }).expect(201);
    expect(media.uploadReference.mock.calls[0][1].size).toBe(maxReferenceBytes - 1);
    media.uploadReference.mockClear();
    await post('/references').attach('file', Buffer.alloc(maxReferenceBytes), { filename: 'limit.png', contentType: 'image/png' }).expect(201);
    expect(media.uploadReference.mock.calls[0][1].size).toBe(maxReferenceBytes);
    media.uploadReference.mockClear();
    for (const size of [maxReferenceBytes + 1, maxReferenceBytes + 2]) {
      await post('/references').attach('file', Buffer.alloc(size), { filename: 'limit.png', contentType: 'image/png' }).expect(413);
    }
    expect(media.uploadReference).not.toHaveBeenCalled();
  });

  it.each(['field', 'second-file', 'wrong-file-field'] as const)('rejects multipart %s before the upload service', async kind => {
    const upload = post('/references');
    if (kind === 'wrong-file-field') upload.attach('image', png, { filename: 'wrong.png', contentType: 'image/png' });
    else {
      upload.attach('file', png, { filename: 'reference.png', contentType: 'image/png' });
      if (kind === 'field') upload.field('enterpriseId', 'injected-enterprise');
      else upload.attach('file', png, { filename: 'second.png', contentType: 'image/png' });
    }
    await upload.expect(400);
    expect(media.uploadReference).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-mime', 'corrupt-png'] as const)('preserves the service INVALID_REFERENCE rejection for %s input', async kind => {
    // MIME/signature/PNG integrity validation belongs to MediaRealService, not the interceptor.
    media.uploadReference.mockRejectedValue(businessError(400, 'INVALID_REFERENCE'));
    const upload = post('/references');
    if (kind === 'missing') upload.send({});
    else upload.attach('file', kind === 'corrupt-png' ? Buffer.from('not a PNG') : png,
      { filename: 'reference.png', contentType: kind === 'wrong-mime' ? 'image/jpeg' : 'image/png' });
    const response = await upload.expect(400);
    expect(response.body.error.code).toBe('INVALID_REFERENCE');
    expect(media.uploadReference).toHaveBeenCalledTimes(1);
    expect(media.uploadReference.mock.calls[0][0]).toEqual(claims);
    if (kind === 'missing') expect(media.uploadReference.mock.calls[0][1]).toBeUndefined();
    else expect(media.uploadReference.mock.calls[0][1]).toMatchObject({
      mimetype: kind === 'wrong-mime' ? 'image/jpeg' : 'image/png', buffer: kind === 'corrupt-png' ? Buffer.from('not a PNG') : png,
    });
  });

  it.each(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN'] as const)('returns 202/no-store for %s, preserving reconciliation and original IDs', async status => {
    const pending = receipt(status);
    media.submit.mockResolvedValue(pending);
    const response = await post('/requests').send(submitInput()).expect(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(pending);
    expect(media.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'] as const)('returns 200/no-store for terminal %s even while billing reconciles', async status => {
    const completed = receipt(status);
    media.submit.mockResolvedValue(completed);
    const response = await post('/requests').send(submitInput()).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(completed);
  });

  it('queries the original IDs with the current employment scope and never dispatches a new request', async () => {
    const byClientId = await get('/requests/by-client-id/request-original?enterpriseId=injected&memberId=injected', 'employment-b').expect(200);
    const byReceipt = await get('/requests/receipt-original', 'employment-b').expect(200);
    expect(media.findByClientId).toHaveBeenCalledWith(otherClaims, 'request-original');
    expect(media.receipt).toHaveBeenCalledWith(otherClaims, 'receipt-original');
    for (const response of [byClientId, byReceipt]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual(receipt());
    }
    expect(media.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['/requests/by-client-id/bad%20id', 'findByClientId'], ['/requests/bad%20id', 'receipt'],
    ['/requests/bad%20id/outputs/output-original/content', 'content'], ['/requests/receipt-original/outputs/bad%20id/content', 'content'],
  ] as const)('rejects invalid path IDs at %s before the service', async (path, method) => {
    await get(path).expect(400);
    expect(media[method]).not.toHaveBeenCalled();
  });

  it('validates cancellation IDs/body and forwards unsupported cancellation without another submission', async () => {
    await post('/requests/bad%20id/cancel').send({}).expect(400);
    await post('/requests/receipt-original/cancel').send({ force: true }).expect(400);
    expect(media.cancel).not.toHaveBeenCalled();
    const response = await post('/requests/receipt-original/cancel', 'employment-b').send({}).expect(409);
    expect(response.body.error.code).toBe('CANCEL_UNSUPPORTED');
    expect(media.cancel).toHaveBeenCalledWith(otherClaims, 'receipt-original');
    expect(media.submit).not.toHaveBeenCalled();
  });

  it('downloads bare PNG bytes with verified hash/security headers and the employment scope', async () => {
    const response = await get('/requests/receipt-original/outputs/output-original/content', 'employment-b').expect(200);
    expect(media.content).toHaveBeenCalledWith(otherClaims, 'receipt-original', 'output-original');
    expect(response.body).toEqual(png);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['content-length']).toBe(String(png.length));
    expect(response.headers['content-disposition']).toBe('attachment; filename="output-original.png"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-sep-media-mock']).toBe('false');
    expect(response.headers['x-sha256']).toBe(digest);
    expect(createHash('sha256').update(response.body).digest('hex')).toBe(response.headers['x-sha256']);
    expect(media.submit).not.toHaveBeenCalled();
  });

  it.each([[403, 'MEDIA_FORBIDDEN'], [404, 'MEDIA_NOT_FOUND'], [410, 'RESULT_EXPIRED'], [503, 'MEDIA_STORAGE_UNAVAILABLE']] as const)(
    'preserves download failure %s/%s without emitting PNG bytes or hash headers', async (status, code) => {
      media.content.mockRejectedValue(businessError(status, code));
      const response = await get('/requests/receipt-original/outputs/output-original/content').expect(status);
      expect(response.body.error).toMatchObject({ code, source: 'platform' });
      expect(response.headers['x-sha256']).toBeUndefined();
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toMatch(/application\/json/);
    },
  );
});
