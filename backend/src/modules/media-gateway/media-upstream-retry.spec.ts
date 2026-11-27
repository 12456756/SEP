import { mediaPollAfter, mediaResponseWait, updateMediaWait, withMediaWait } from './media-upstream-retry';

describe('upstream media waiting contract', () => {
  const now = Date.UTC(2026, 10, 27);
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
  afterEach(() => jest.restoreAllMocks());

  it('preserves the header verbatim while counting elapsed wait against the polling delay', () => {
    const config = {};
    updateMediaWait(config, { 'Retry-After': '0030' }, now - 5000);
    const receipt = withMediaWait({ pollAfterMs: mediaPollAfter(config, 3000) }, config);
    expect(receipt.pollAfterMs).toBe(25000); expect(mediaResponseWait(receipt)).toBe('0030');
    expect(JSON.stringify(receipt)).toBe('{"pollAfterMs":25000}');
  });

  it('supports HTTP dates without replacing the exact date header', () => {
    const config = {};
    const date = new Date(now + 45000).toUTCString();
    updateMediaWait(config, { 'retry-after': date });
    expect(mediaPollAfter(config, 3000)).toBe(45000);
    expect(mediaResponseWait(withMediaWait({}, config))).toBe(date);
  });

  it.each(['invalid', '-1', '99999999999999999999999999'])('preserves %s without inventing a numeric delay', value => {
    const config = {};
    updateMediaWait(config, { 'retry-after': value });
    expect(mediaPollAfter(config, 3000)).toBe(3000);
    expect(mediaResponseWait(withMediaWait({}, config))).toBe(value);
  });

  it('replaces an earlier wait and removes it when a new response omits it', () => {
    const config = {};
    updateMediaWait(config, { 'retry-after': '30' });
    updateMediaWait(config, { 'retry-after': '5' });
    expect(mediaPollAfter(config, 3000)).toBe(5000);
    updateMediaWait(config, {});
    expect(mediaPollAfter(config, 3000)).toBe(3000); expect(mediaResponseWait(withMediaWait({}, config))).toBeUndefined();
  });
});
