import { describe, it, expect } from 'vitest';
import { normalizeCurrencyCode } from '../utils/currency.js';

// Regression guard for the 2026-05-27 production incident: a malformed
// ad_spend.currency from Catchr (empty string, whitespace, wrong length,
// non-letters) reached Intl.NumberFormat and crashed the portal dashboard.
// normalizeCurrencyCode is the single chokepoint used at both ingest (write)
// and the portal (read).
describe('normalizeCurrencyCode', () => {
  it('passes through valid ISO codes, uppercasing + trimming', () => {
    expect(normalizeCurrencyCode('GBP')).toBe('GBP');
    expect(normalizeCurrencyCode('usd')).toBe('USD');
    expect(normalizeCurrencyCode(' eur ')).toBe('EUR');
  });

  it('falls back for malformed codes (the crash class)', () => {
    for (const bad of ['', '  ', 'us', 'GBPP', 'Facebook', '12', 'g8p']) {
      expect(normalizeCurrencyCode(bad)).toBe('GBP');
    }
  });

  it('falls back for null / undefined', () => {
    expect(normalizeCurrencyCode(null)).toBe('GBP');
    expect(normalizeCurrencyCode(undefined)).toBe('GBP');
  });

  it('honours a valid custom fallback, but ignores a malformed one', () => {
    expect(normalizeCurrencyCode('', 'EUR')).toBe('EUR');
    expect(normalizeCurrencyCode('', 'nonsense')).toBe('GBP');
    expect(normalizeCurrencyCode('', '')).toBe('GBP');
  });

  it('every output is accepted by Intl.NumberFormat (can never crash a formatter)', () => {
    for (const input of ['', null, '  ', 'XX', 'Facebook', 'usd', ' eur ', 'GBPP']) {
      const code = normalizeCurrencyCode(input);
      expect(() => new Intl.NumberFormat('en-GB', { style: 'currency', currency: code })).not.toThrow();
    }
  });
});
