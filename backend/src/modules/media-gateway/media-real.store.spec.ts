import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MediaRealQuote, MediaRealReceipt, MediaRealReference } from 'shared';
import { MediaRealQuoteSchema, MediaRealReceiptSchema, MediaRealReferenceSchema } from 'shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { MediaRealStore, RealRequestRecord } from './media-real.store';

const SCOPE = 'enterprise-1:user-1:subscription-1';
const EXPIRES_AT = '2026-10-15T10:15:00.000Z';
const HASH = 'a'.repeat(64);
const reference = (): Omit<MediaRealReference, 'referenceId'> => ({
  mock: false, expiresAt: EXPIRES_AT, mimeType: 'image/png', byteLength: 128,
  sha256: HASH, width: 1024, height: 1024,
});
const quote = (): Omit<MediaRealQuote, 'quoteId'> => ({
  mock: false, expiresAt: EXPIRES_AT, semanticSha256: HASH, pricingStatus: 'quoted',
  amountCny: '3.500000', pricingVersion: 'pricing-1', billingStatus: 'NOT_RESERVED',
  funding: { creditCny: '1.000000', memberWalletCny: '2.000000', personalCny: '0.500000' },
});
const receipt = (): MediaRealReceipt => ({
  mock: false, receiptId: 'pending', clientRequestId: 'client-1', profileId: 'profile-1',
  configVersion: 'config-1', executionMode: 'sync-response', status: 'SUBMITTING',
  pollAfterMs: null, outputs: [], billingStatus: 'RESERVED', errorCode: null, outputErrors: [],
  recovery: { canQuery: true, canCancel: false, canDownload: false },
});
const input = (): Omit<RealRequestRecord, 'id' | 'revision'> => ({
  enterpriseId: 'enterprise-1', clientRequestId: 'client-1', quoteId: 'quote-1',
  upstreamRequestId: null, scope: SCOPE, semanticSha256: HASH,
  referenceIds: ['reference-1'], referenceHashes: [HASH], count: 1,
  configuration: { profileId: 'profile-1', configVersion: 'config-1', operation: 'edit',
    parameters: { count: 1, size: '1024x1024', quality: 'medium' } },
  receipt: receipt(), submissionDeadline: new Date('2026-10-15T10:03:00.000Z'),
});
function requestRow() {
  const value = input();
  const { receiptId: _id, ...storedReceipt } = value.receipt;
  return { ...value, id: 'receipt-1', revision: 0, receipt: storedReceipt, status: value.receipt.status };
}
type RequestRow = ReturnType<typeof requestRow>;
const knownError = (code: string) => new Prisma.PrismaClientKnownRequestError('private database error', {
  code, clientVersion: 'test', meta: { target: ['enterpriseId', 'clientRequestId'] },
});
function mockPrisma() {
  return {
    mediaRealReference: { create: jest.fn(), findUnique: jest.fn() },
    mediaRealQuote: { create: jest.fn(), findUnique: jest.fn() },
    mediaRealRequest: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  };
}
async function expectUnavailable(action: Promise<unknown>) {
  const error: unknown = await action.then(() => { throw new Error('Expected storage rejection'); }, reason => reason);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(503);
  expect((error as HttpException).getResponse()).toMatchObject({ error: {
    code: 'MEDIA_STORAGE_UNAVAILABLE', message: '媒体存储暂不可用，请查询原请求，不要重新生成',
  } });
  return error as HttpException;
}

describe('MediaRealStore (mock PrismaService; no database)', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let store: MediaRealStore;
  beforeEach(() => {
    prisma = mockPrisma();
    store = new MediaRealStore(prisma as unknown as PrismaService);
  });

  it('retains database diagnostics with credentials redacted and without retrying writes', async () => {
    prisma.mediaRealReference.create.mockRejectedValueOnce(Object.assign(
      new Error('Database connection refused postgres://user:storage-secret@private/db'), { code: 'ECONNREFUSED' }));
    const failure = await expectUnavailable(store.saveReference(SCOPE, reference()));
    expect(failure.getResponse()).toMatchObject({ error: { cause: { code: 'ECONNREFUSED',
      message: 'Database connection refused [REDACTED]' } } });
    expect(prisma.mediaRealReference.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure.getResponse())).not.toContain('storage-secret');
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('writes and reads %s references with the database ID', async mimeType => {
    const value = { ...reference(), mimeType };
    prisma.mediaRealReference.create.mockResolvedValue({ id: 'reference-1' });
    const saved = await store.saveReference(SCOPE, value);
    expect(saved).toEqual(MediaRealReferenceSchema.parse({ ...value, referenceId: 'reference-1' }));
    expect(prisma.mediaRealReference.create).toHaveBeenCalledWith({ data: {
      scope: SCOPE, metadata: value, expiresAt: new Date(EXPIRES_AT),
    } });
    prisma.mediaRealReference.findUnique.mockResolvedValue({ id: 'reference-1', scope: SCOPE, metadata: value });
    await expect(store.findReference('reference-1')).resolves.toEqual({ scope: SCOPE, value: saved });
    expect(prisma.mediaRealReference.findUnique).toHaveBeenCalledWith({ where: { id: 'reference-1' } });
  });

  it('writes and reads quotes without losing the fixed funding amounts or exchange rate', async () => {
    const value = quote();
    prisma.mediaRealQuote.create.mockResolvedValue({ id: 'quote-1' });
    const saved = await store.saveQuote(SCOPE, value, 7.1234);
    expect(saved).toEqual(MediaRealQuoteSchema.parse({ ...value, quoteId: 'quote-1' }));
    expect(prisma.mediaRealQuote.create).toHaveBeenCalledWith({ data: {
      scope: SCOPE, metadata: { quote: value, usdToCnyRate: 7.1234 }, expiresAt: new Date(EXPIRES_AT),
    } });
    prisma.mediaRealQuote.findUnique.mockResolvedValue({ id: 'quote-1', scope: SCOPE,
      metadata: { quote: value, usdToCnyRate: 7.1234 } });
    await expect(store.findQuote('quote-1')).resolves.toEqual({ scope: SCOPE, value: saved, usdToCnyRate: 7.1234 });
    expect(prisma.mediaRealQuote.findUnique).toHaveBeenCalledWith({ where: { id: 'quote-1' } });
  });

  it.each(['findReference', 'findQuote', 'findRequest'] as const)('%s returns null for a missing row', async method => {
    const delegate = method === 'findReference' ? prisma.mediaRealReference :
      method === 'findQuote' ? prisma.mediaRealQuote : prisma.mediaRealRequest;
    delegate.findUnique.mockResolvedValue(null);
    await expect(store[method]('missing')).resolves.toBeNull();
  });

  it('claims a request once, strips the provisional receipt ID and restores the persisted ID', async () => {
    const value = input();
    prisma.mediaRealRequest.create.mockResolvedValue(requestRow());
    const result = await store.claim(value);
    expect(result.created).toBe(true);
    expect(result.record).toEqual({ ...value, id: 'receipt-1', revision: 0,
      receipt: MediaRealReceiptSchema.parse({ ...value.receipt, receiptId: 'receipt-1' }) });
    const { receiptId: _id, ...storedReceipt } = value.receipt;
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledWith({ data: {
      ...value, receipt: storedReceipt, status: 'SUBMITTING',
    } });
    expect(prisma.mediaRealRequest.findUnique).not.toHaveBeenCalled();
  });

  it('reads requests by ID or enterprise-scoped client ID using the same receipt decoder', async () => {
    prisma.mediaRealRequest.findUnique.mockResolvedValue(requestRow());
    const found = await store.findRequest('receipt-1');
    expect(found?.receipt.receiptId).toBe('receipt-1');
    expect(found?.revision).toBe(0);
    await expect(store.findByClientId('enterprise-1', 'client-1')).resolves.toEqual(found);
    expect(prisma.mediaRealRequest.findUnique.mock.calls).toEqual([
      [{ where: { id: 'receipt-1' } }],
      [{ where: { enterpriseId_clientRequestId: { enterpriseId: 'enterprise-1', clientRequestId: 'client-1' } } }],
    ]);
    prisma.mediaRealRequest.findUnique.mockResolvedValueOnce(null);
    await expect(store.findByClientId('enterprise-2', 'client-1')).resolves.toBeNull();
  });

  describe('pending request raw-row pagination', () => {
    let warn: jest.SpyInstance;
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...requestRow(), id: `receipt-${String(index + 1).padStart(3, '0')}`,
    }));

    beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warn.mockRestore(); });

    it.each([[100, 20], [20, 20], [3, 3], [0, 1], [-1, 1]])(
      'bounds limit %i to %i raw rows with the pending filter and strict ID cursor', async (limit, take) => {
        const batch = rows(take);
        prisma.mediaRealRequest.findMany.mockResolvedValue(batch);
        const result = await store.pendingRequests(limit, 'receipt-000');
        expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledWith({
          where: { id: { gt: 'receipt-000' }, OR: [
            { receipt: { path: ['billingStatus'], equals: 'RESERVED' } },
            { receipt: { path: ['billingStatus'], equals: 'RECONCILING' } },
          ] }, orderBy: { id: 'asc' }, take,
        });
        expect(result).toMatchObject({ records: batch.map(row => ({ id: row.id })), afterId: batch[take - 1].id });
        expect(result.records[0].receipt.receiptId).toBe(batch[0].id);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('starts without an ID filter and ends a short page without a cursor', async () => {
      const batch = rows(2);
      prisma.mediaRealRequest.findMany.mockResolvedValue(batch);
      const result = await store.pendingRequests(20);
      expect(result.records.map(record => record.id)).toEqual(batch.map(row => row.id));
      expect(result.afterId).toBeUndefined();
      expect(prisma.mediaRealRequest.findMany.mock.calls[0][0].where).not.toHaveProperty('id');
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns an empty terminal page without a cursor', async () => {
      prisma.mediaRealRequest.findMany.mockResolvedValue([]);
      await expect(store.pendingRequests(20, 'receipt-020')).resolves.toEqual({ records: [], afterId: undefined });
      expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('isolates corrupt receipts and configuration while retaining valid rows in raw order', async () => {
      const batch = rows(5);
      const corrupt = [
        { ...batch[0], receipt: { ...batch[0].receipt, unexpected: 'private receipt body' } },
        batch[1],
        { ...batch[2], referenceHashes: [] },
        batch[3],
        { ...batch[4], configuration: null },
      ];
      prisma.mediaRealRequest.findMany.mockResolvedValue(corrupt);
      const result = await store.pendingRequests(5);
      expect(result.records.map(record => record.id)).toEqual([batch[1].id, batch[3].id]);
      expect(result.afterId).toBe(batch[4].id);
      expect(warn.mock.calls).toEqual(Array.from({ length: 3 }, () => ['MEDIA_PENDING_REQUEST_INVALID']));
      expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.mediaRealRequest.create).not.toHaveBeenCalled();
      expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
    });

    it('advances past a full corrupt page so later valid requests are not starved', async () => {
      const corrupt = rows(20).map(row => ({ ...row, receipt: null }));
      const valid = { ...requestRow(), id: 'receipt-021' };
      prisma.mediaRealRequest.findMany.mockResolvedValueOnce(corrupt).mockResolvedValueOnce([valid]);
      const first = await store.pendingRequests(20);
      expect(first).toEqual({ records: [], afterId: 'receipt-020' });
      expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
      const second = await store.pendingRequests(20, first.afterId);
      expect(second.records.map(record => record.id)).toEqual(['receipt-021']);
      expect(second.afterId).toBeUndefined();
      expect(prisma.mediaRealRequest.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: { gt: 'receipt-020' } }), take: 20,
      }));
      expect(warn.mock.calls).toEqual(Array.from({ length: 20 }, () => ['MEDIA_PENDING_REQUEST_INVALID']));
    });

    it('does not advertise another page based on decoded count or refill a short corrupt page', async () => {
      const batch = rows(2).map(row => ({ ...row, receipt: null }));
      prisma.mediaRealRequest.findMany.mockResolvedValue(batch);
      await expect(store.pendingRequests(20)).resolves.toEqual({ records: [], afterId: undefined });
      expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([['MEDIA_PENDING_REQUEST_INVALID'], ['MEDIA_PENDING_REQUEST_INVALID']]);
    });

    it('propagates database read failure as unavailable rather than an empty page', async () => {
      prisma.mediaRealRequest.findMany.mockRejectedValue(new Error('private database failure'));
      await expectUnavailable(store.pendingRequests(20));
      expect(prisma.mediaRealRequest.findMany).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('P2002 recovers the original claim without inserting or updating again', async () => {
    const original = { ...requestRow(), scope: 'original-scope', semanticSha256: 'b'.repeat(64), quoteId: 'original-quote' };
    prisma.mediaRealRequest.create.mockRejectedValue(knownError('P2002'));
    prisma.mediaRealRequest.findUnique.mockResolvedValue(original);
    const result = await store.claim(input());
    expect(result.created).toBe(false);
    expect(result.record).toMatchObject({ id: original.id, scope: original.scope,
      semanticSha256: original.semanticSha256, quoteId: original.quoteId });
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.findUnique).toHaveBeenCalledWith({ where: {
      enterpriseId_clientRequestId: { enterpriseId: 'enterprise-1', clientRequestId: 'client-1' },
    } });
    expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
  });

  it('concurrent claims share the database uniqueness winner and only one is created', async () => {
    let persisted: RequestRow | null = null;
    prisma.mediaRealRequest.create.mockImplementation(async () => {
      if (persisted) throw knownError('P2002');
      persisted = requestRow();
      return persisted;
    });
    prisma.mediaRealRequest.findUnique.mockImplementation(async () => persisted);
    const results = await Promise.all([store.claim(input()), store.claim(input())]);
    expect(results.map(result => result.created)).toEqual([true, false]);
    expect(results[0].record).toEqual(results[1].record);
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledTimes(2);
    expect(prisma.mediaRealRequest.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unreadable'] as const)('fails closed when P2002 recovery is %s without a second create', async kind => {
    prisma.mediaRealRequest.create.mockRejectedValue(knownError('P2002'));
    if (kind === 'missing') prisma.mediaRealRequest.findUnique.mockResolvedValue(null);
    else prisma.mediaRealRequest.findUnique.mockRejectedValue(new Error('read timed out'));
    await expectUnavailable(store.claim(input()));
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown commit outcome', new Error('connection lost after commit')],
    ['serialization conflict', knownError('P2034')],
    ['non-Prisma code lookalike', { code: 'P2002' }],
  ])('does not retry or infer a claim after %s', async (_name, error) => {
    prisma.mediaRealRequest.create.mockRejectedValue(error);
    await expectUnavailable(store.claim(input()));
    expect(prisma.mediaRealRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.mediaRealRequest.findUnique).not.toHaveBeenCalled();
    expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
  });

  it('save uses revision CAS, omits receipt ID and preserves immutable request metadata', async () => {
    const row = requestRow();
    const record: RealRequestRecord = { ...input(), id: row.id, revision: 3,
      receipt: { ...receipt(), receiptId: row.id, status: 'RUNNING' } };
    prisma.mediaRealRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.mediaRealRequest.findUnique.mockResolvedValue({ ...row, receipt: record.receipt,
      status: 'RUNNING', revision: 4, upstreamRequestId: 'upstream-1' });
    const { receiptId: _id, ...storedReceipt } = record.receipt;
    const result = await store.save(record, 'upstream-1');
    expect(prisma.mediaRealRequest.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, revision: 3 }, data: { receipt: storedReceipt, status: 'RUNNING',
        upstreamRequestId: 'upstream-1', revision: { increment: 1 } },
    });
    expect(result).toMatchObject({ revision: 4, upstreamRequestId: 'upstream-1', receipt: { status: 'RUNNING' } });
    expect(prisma.mediaRealRequest.findUnique).toHaveBeenCalledWith({ where: { id: row.id } });
  });

  it('a delayed stale save cannot overwrite a newer committed revision or upstream ID', async () => {
    let persisted = requestRow();
    const stale: RealRequestRecord = { ...input(), id: persisted.id, revision: 0,
      receipt: { ...receipt(), receiptId: persisted.id, status: 'SUBMISSION_UNKNOWN' } };
    const newer: RealRequestRecord = { ...stale, receipt: { ...stale.receipt, status: 'RUNNING' } };
    let allowStale!: () => void;
    const gate = new Promise<void>(resolve => { allowStale = resolve; });
    prisma.mediaRealRequest.updateMany.mockImplementation(async ({ where, data }) => {
      if (data.status === 'SUBMISSION_UNKNOWN') await gate;
      if (persisted.id !== where.id || persisted.revision !== where.revision) return { count: 0 };
      persisted = { ...persisted, ...data, revision: persisted.revision + 1 };
      return { count: 1 };
    });
    prisma.mediaRealRequest.findUnique.mockImplementation(async () => persisted);
    const staleSave = store.save(stale, 'stale-upstream');
    const winner = await store.save(newer, 'confirmed-upstream');
    allowStale();
    const recovered = await staleSave;
    expect(winner.revision).toBe(1);
    expect(recovered).toEqual(winner);
    expect(persisted).toMatchObject({ revision: 1, status: 'RUNNING', upstreamRequestId: 'confirmed-upstream' });
    expect(prisma.mediaRealRequest.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.mediaRealRequest.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: 'receipt-1', revision: 0 }, { id: 'receipt-1', revision: 0 },
    ]);
  });

  it('fails closed if a save cannot read back the current request', async () => {
    prisma.mediaRealRequest.updateMany.mockResolvedValue({ count: 0 });
    prisma.mediaRealRequest.findUnique.mockResolvedValue(null);
    await expectUnavailable(store.save({ ...input(), id: 'receipt-1', revision: 0,
      receipt: { ...receipt(), receiptId: 'receipt-1' } }));
    expect(prisma.mediaRealRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(['reference', 'quote', 'save'] as const)('does not replay an unknown %s write outcome', async kind => {
    const error = new Error('write may have committed');
    if (kind === 'reference') {
      prisma.mediaRealReference.create.mockRejectedValue(error);
      await expectUnavailable(store.saveReference(SCOPE, reference()));
      expect(prisma.mediaRealReference.create).toHaveBeenCalledTimes(1);
      expect(prisma.mediaRealReference.findUnique).not.toHaveBeenCalled();
    } else if (kind === 'quote') {
      prisma.mediaRealQuote.create.mockRejectedValue(error);
      await expectUnavailable(store.saveQuote(SCOPE, quote(), 7));
      expect(prisma.mediaRealQuote.create).toHaveBeenCalledTimes(1);
      expect(prisma.mediaRealQuote.findUnique).not.toHaveBeenCalled();
    } else {
      prisma.mediaRealRequest.updateMany.mockRejectedValue(error);
      await expectUnavailable(store.save({ ...input(), id: 'receipt-1', revision: 0,
        receipt: { ...receipt(), receiptId: 'receipt-1' } }));
      expect(prisma.mediaRealRequest.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.mediaRealRequest.findUnique).not.toHaveBeenCalled();
    }
  });

  describe('corrupt stored metadata fails closed', () => {
    it.each([null, {}, { ...reference(), mock: true }, { ...reference(), sha256: 'invalid' },
      { ...reference(), width: 0 }, { ...reference(), unexpected: true }])('rejects bad reference metadata %#', async metadata => {
      prisma.mediaRealReference.findUnique.mockResolvedValue({ id: 'reference-1', scope: SCOPE, metadata });
      await expectUnavailable(store.findReference('reference-1'));
      expect(prisma.mediaRealReference.create).not.toHaveBeenCalled();
    });

    it.each([null, {}, { quote: quote() }, ...[0, -1, NaN, Infinity, '7'].map(usdToCnyRate => ({ quote: quote(), usdToCnyRate })),
      { quote: { ...quote(), amountCny: '1.00' }, usdToCnyRate: 7 },
      { quote: { ...quote(), funding: { ...quote().funding, personalCny: '-1.000000' } }, usdToCnyRate: 7 },
      { quote: { ...quote(), extra: true }, usdToCnyRate: 7 },
    ])('rejects bad quote metadata or exchange rate %#', async metadata => {
      prisma.mediaRealQuote.findUnique.mockResolvedValue({ id: 'quote-1', scope: SCOPE, metadata });
      await expectUnavailable(store.findQuote('quote-1'));
      expect(prisma.mediaRealQuote.create).not.toHaveBeenCalled();
    });

    it.each([
      ['null receipt', () => ({ ...requestRow(), receipt: null })],
      ['unknown status', () => ({ ...requestRow(), status: 'INVALID' })],
      ['mock receipt', () => ({ ...requestRow(), receipt: { ...requestRow().receipt, mock: true } })],
      ['invalid billing status', () => ({ ...requestRow(), receipt: { ...requestRow().receipt, billingStatus: 'UNKNOWN' } })],
      ['invalid output', () => ({ ...requestRow(), receipt: { ...requestRow().receipt, outputs: [{}] } })],
      ['unexpected receipt field', () => ({ ...requestRow(), receipt: { ...requestRow().receipt, extra: true } })],
      ['client ID mismatch', () => ({ ...requestRow(), clientRequestId: 'other-client' })],
      ['profile mismatch', () => ({ ...requestRow(), configuration: { profileId: 'other-profile', configVersion: 'config-1' } })],
      ['config version mismatch', () => ({ ...requestRow(), configuration: { profileId: 'profile-1', configVersion: 'other-config' } })],
      ['null configuration', () => ({ ...requestRow(), configuration: null })],
      ['reference/hash length mismatch', () => ({ ...requestRow(), referenceHashes: [] })],
    ] as const)('rejects %s on both request lookup paths', async (_name, corrupt) => {
      prisma.mediaRealRequest.findUnique.mockResolvedValue(corrupt());
      await expectUnavailable(store.findRequest('receipt-1'));
      await expectUnavailable(store.findByClientId('enterprise-1', 'client-1'));
      expect(prisma.mediaRealRequest.create).not.toHaveBeenCalled();
      expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('invalid input is rejected before persistence', () => {
    it('validates reference schema before create', async () => {
      prisma.mediaRealReference.create.mockResolvedValue({ id: 'reference-1' });
      await expectUnavailable(store.saveReference(SCOPE, { ...reference(), width: 0 }));
      expect(prisma.mediaRealReference.create).not.toHaveBeenCalled();
    });

    it('validates quote schema before create', async () => {
      prisma.mediaRealQuote.create.mockResolvedValue({ id: 'quote-1' });
      await expectUnavailable(store.saveQuote(SCOPE, { ...quote(), amountCny: '1.00' }, 7));
      expect(prisma.mediaRealQuote.create).not.toHaveBeenCalled();
    });

    it('rejects invalid quote exchange rates before create', async () => {
      prisma.mediaRealQuote.create.mockResolvedValue({ id: 'quote-1' });
      await expectUnavailable(store.saveQuote(SCOPE, quote(), 0));
      expect(prisma.mediaRealQuote.create).not.toHaveBeenCalled();
    });

    it('validates the claim receipt before create', async () => {
      const invalid = { ...input(), receipt: { ...receipt(), pollAfterMs: -1 } };
      prisma.mediaRealRequest.create.mockResolvedValue({ ...requestRow(), receipt: invalid.receipt });
      await expectUnavailable(store.claim(invalid));
      expect(prisma.mediaRealRequest.create).not.toHaveBeenCalled();
    });

    it('validates the saved receipt before updateMany', async () => {
      const invalid: RealRequestRecord = { ...input(), id: 'receipt-1', revision: 0,
        receipt: { ...receipt(), receiptId: 'receipt-1', pollAfterMs: -1 } };
      prisma.mediaRealRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.mediaRealRequest.findUnique.mockResolvedValue({ ...requestRow(), receipt: invalid.receipt, revision: 1 });
      await expectUnavailable(store.save(invalid));
      expect(prisma.mediaRealRequest.updateMany).not.toHaveBeenCalled();
    });
  });
});
