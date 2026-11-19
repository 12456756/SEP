import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MediaVideoRealProfilesSchema, MediaVideoRealQuoteRequestSchema, MediaVideoRealQuoteSchema,
  MediaVideoRealReceiptSchema, MediaVideoRealReferenceSchema, MediaVideoRealRequestSchema,
} from './media-video-real.dto';
import { MediaVideoGatewayQuoteRequestSchema, MediaVideoGatewayRequestSchema } from './media-video.dto';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/media-video-v1.json'), 'utf8'));
const quote = () => ({
  mock: false, quoteId: 'quote-1', expiresAt: '2026-10-20T01:00:00Z', semanticSha256: 'a'.repeat(64),
  pricingStatus: 'quoted', amountCny: '0.900000', amountUsd: '0.128000000001', pricingVersion: 'price-1',
  usdToCnyRate: 7, billingStatus: 'NOT_RESERVED',
  funding: { creditCny: '0.900000', memberWalletCny: '0.000000', personalCny: '0.000000' },
});
const receipt = (status = 'succeeded') => ({ ...fixture.receipts[status], mock: false, billingStatus: 'RESERVED' });

describe('real video contracts', () => {
  it('reuses existing strict request schemas without widening mock contracts', () => {
    expect(MediaVideoRealQuoteRequestSchema.parse(fixture.quoteRequest)).toEqual(
      MediaVideoGatewayQuoteRequestSchema.parse(fixture.quoteRequest));
    expect(MediaVideoRealRequestSchema.parse(fixture.request)).toEqual(
      MediaVideoGatewayRequestSchema.parse(fixture.request));
    expect(MediaVideoRealRequestSchema.parse(fixture.request)).toEqual(fixture.request);
  });

  it('accepts real PNG references with the existing reference limits', () => {
    const ref = { mock: false, referenceId: 'reference-1', expiresAt: '2026-10-20T01:00:00Z',
      mimeType: 'image/png', byteLength: 100, sha256: 'a'.repeat(64), width: 1280, height: 720 };
    expect(MediaVideoRealReferenceSchema.parse(ref)).toEqual(ref);
    for (const mimeType of ['image/jpeg', 'image/webp']) {
      expect(MediaVideoRealReferenceSchema.parse({ ...ref, mimeType }).mimeType).toBe(mimeType);
    }
    for (const extra of [{ mock: true }, { bytes: 'private' }, { mimeType: 'image/heic' }, { byteLength: 10 * 1024 * 1024 + 1 }]) {
      expect(MediaVideoRealReferenceSchema.safeParse({ ...ref, ...extra }).success).toBe(false);
    }
  });

  it('accepts exact decimal money and all five real billing states', () => {
    expect(MediaVideoRealQuoteSchema.parse(quote())).toEqual(quote());
    for (const billingStatus of ['NOT_RESERVED', 'RESERVED', 'SETTLED', 'RELEASED', 'RECONCILING']) {
      expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt(), billingStatus,
        amountCny: '0.900000', actualCostCny: '0.800000', amountUsd: '0.12',
        recovery: { ...receipt().recovery, canQuery: ['RESERVED', 'RECONCILING'].includes(billingStatus) } }).success).toBe(true);
    }
  });

  it.each([
    { mock: true }, { billingStatus: 'MOCK_NOT_CHARGED' }, { amountCny: '1.00' }, { amountUsd: '-1' },
    { amountUsd: '0.1234567890123' }, { amountUsd: '1e-6' }, { usdToCnyRate: 0 }, { usdToCnyRate: Infinity },
    { funding: { creditCny: '0.900000' } }, { apiKey: 'private' },
  ])('rejects invalid or unsolicited quote fields %#', patch => {
    expect(MediaVideoRealQuoteSchema.safeParse({ ...quote(), ...patch }).success).toBe(false);
  });

  it('applies the same async state consistency rules as mock receipts', () => {
    for (const value of Object.values(fixture.receipts)) {
      const item = value as { recovery: Record<string, boolean> };
      expect(MediaVideoRealReceiptSchema.safeParse({ ...item, mock: false, billingStatus: 'RESERVED',
        recovery: { ...item.recovery, canQuery: true } }).success).toBe(true);
    }
    for (const patch of [
      { outputs: [] }, { outputs: [fixture.output, fixture.output] }, { pollAfterMs: 100 },
      { billingStatus: 'MOCK_NOT_CHARGED' },
      { mock: true }, { privateUrl: 'private' },
    ]) expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt(), ...patch }).success).toBe(false);
    expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt('failed'), recovery: {
      canQuery: false, canCancel: false, canDownload: true,
    } }).success).toBe(false);
  });

  it('allows terminal provider states to remain queryable only while billing is unresolved', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']) {
      const hasOutput = status === 'SUCCEEDED';
      const value = {
        ...receipt(status === 'SUCCEEDED' ? 'succeeded' : 'failed'), status, pollAfterMs: null,
        outputs: hasOutput ? [fixture.output] : [],
        billingStatus: 'RECONCILING',
        recovery: { canQuery: true, canCancel: false, canDownload: hasOutput },
      };
      expect(MediaVideoRealReceiptSchema.safeParse(value).success).toBe(true);
    }
    expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt('failed'), status: 'FAILED', billingStatus: 'SETTLED',
      pollAfterMs: null, recovery: { canQuery: false, canCancel: false, canDownload: false } }).success).toBe(true);
    expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt('failed'), status: 'FAILED', billingStatus: 'RELEASED',
      pollAfterMs: null, recovery: { canQuery: true, canCancel: false, canDownload: false } }).success).toBe(false);
    expect(MediaVideoRealReceiptSchema.safeParse({ ...receipt('failed'), status: 'FAILED', billingStatus: 'RECONCILING',
      pollAfterMs: 1000, recovery: { canQuery: true, canCancel: false, canDownload: false } }).success).toBe(false);
  });

  it('requires database persistence and strict runtime profiles', () => {
    const value = { mock: false, protocolVersion: 1, persistence: 'database', billingStatus: 'NOT_RESERVED', profiles: fixture.runtime.profiles };
    expect(MediaVideoRealProfilesSchema.parse(value)).toEqual(value);
    for (const patch of [{ persistence: 'memory' }, { mock: true }, { billingStatus: 'MOCK_NOT_CHARGED' },
      { profiles: [] }, { profiles: [{ ...fixture.runtime.profiles[0], modelId: 'private' }] }, { apiKey: 'private' }]) {
      expect(MediaVideoRealProfilesSchema.safeParse({ ...value, ...patch }).success).toBe(false);
    }
  });
});
