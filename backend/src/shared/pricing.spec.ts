import { SETTING_FIELDS, SETTING_KEYS } from './index';

describe('compute-owned model pricing', () => {
  it.each([SETTING_KEYS.USD_TO_CNY_RATE, SETTING_KEYS.FALLBACK_PRICE_INPUT, SETTING_KEYS.FALLBACK_PRICE_OUTPUT])(
    'does not expose retired pricing setting %s', key => {
      expect(SETTING_FIELDS.some(field => field.key === key)).toBe(false);
    },
  );
});
