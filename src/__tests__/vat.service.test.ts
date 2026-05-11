import { describe, it, expect } from 'vitest';
import * as vat from '../services/vat.service.js';

function d(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

describe('vat.service — configuredStagger', () => {
  it('defaults to stagger 1 when env var is unset', () => {
    expect(vat.configuredStagger({})).toBe(1);
  });

  it('accepts "2" and "3" as valid stagger values', () => {
    expect(vat.configuredStagger({ XERO_VAT_STAGGER: '2' })).toBe(2);
    expect(vat.configuredStagger({ XERO_VAT_STAGGER: '3' })).toBe(3);
  });

  it('falls back to stagger 1 for any other value', () => {
    expect(vat.configuredStagger({ XERO_VAT_STAGGER: '0' })).toBe(1);
    expect(vat.configuredStagger({ XERO_VAT_STAGGER: 'bogus' })).toBe(1);
    expect(vat.configuredStagger({ XERO_VAT_STAGGER: '' })).toBe(1);
  });
});

describe('vat.service — Stagger 1 (MAR/JUN/SEP/DEC quarters)', () => {
  it('mid-quarter (2026-05-11): previous = Jan-Mar, current = Apr-today', () => {
    const today = d('2026-05-11');
    expect(vat.previousQuarter(today, 1)).toEqual({ fromDate: '2026-01-01', toDate: '2026-03-31' });
    expect(vat.currentQuarter(today, 1)).toEqual({ fromDate: '2026-04-01', toDate: '2026-05-11' });
  });

  it('first day of a new quarter (2026-04-01): previous = Jan-Mar', () => {
    const today = d('2026-04-01');
    expect(vat.previousQuarter(today, 1)).toEqual({ fromDate: '2026-01-01', toDate: '2026-03-31' });
    expect(vat.currentQuarter(today, 1)).toEqual({ fromDate: '2026-04-01', toDate: '2026-04-01' });
  });

  it('January (2026-01-15) crosses year boundary: previous = Oct-Dec 2025', () => {
    const today = d('2026-01-15');
    expect(vat.previousQuarter(today, 1)).toEqual({ fromDate: '2025-10-01', toDate: '2025-12-31' });
    expect(vat.currentQuarter(today, 1)).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-15' });
  });
});

describe("vat.service — Stagger 2 (APR/JUL/OCT/JAN quarters, Sam's)", () => {
  it("Sam's working example (2026-05-30): previous = Feb-Apr, current = May-today", () => {
    const today = d('2026-05-30');
    expect(vat.previousQuarter(today, 2)).toEqual({ fromDate: '2026-02-01', toDate: '2026-04-30' });
    expect(vat.currentQuarter(today, 2)).toEqual({ fromDate: '2026-05-01', toDate: '2026-05-30' });
  });

  it('mid-quarter (2026-05-11): previous = Feb-Apr, current = May-today', () => {
    const today = d('2026-05-11');
    expect(vat.previousQuarter(today, 2)).toEqual({ fromDate: '2026-02-01', toDate: '2026-04-30' });
    expect(vat.currentQuarter(today, 2)).toEqual({ fromDate: '2026-05-01', toDate: '2026-05-11' });
  });

  it('January (2026-01-20) crosses year boundary: previous = Nov 2025 - Jan 2026', () => {
    // Stagger 2 has a Jan-end quarter. Mid-Jan 2026 means the just-closed
    // quarter ended 31 Jan 2025; current accrual starts 1 Feb 2025... wait,
    // actually mid-Jan means the previous end was 31 Oct 2025 (because the
    // Jan 2026 end is in the future). Current quarter started 1 Nov 2025.
    const today = d('2026-01-20');
    expect(vat.previousQuarter(today, 2)).toEqual({ fromDate: '2025-08-01', toDate: '2025-10-31' });
    expect(vat.currentQuarter(today, 2)).toEqual({ fromDate: '2025-11-01', toDate: '2026-01-20' });
  });

  it('Feb 1 2026 — just after Jan-quarter close', () => {
    const today = d('2026-02-01');
    expect(vat.previousQuarter(today, 2)).toEqual({ fromDate: '2025-11-01', toDate: '2026-01-31' });
    expect(vat.currentQuarter(today, 2)).toEqual({ fromDate: '2026-02-01', toDate: '2026-02-01' });
  });
});

describe('vat.service — Stagger 3 (MAY/AUG/NOV/FEB quarters)', () => {
  it('mid-quarter (2026-07-01): previous = Mar-May, current = Jun-today', () => {
    const today = d('2026-07-01');
    expect(vat.previousQuarter(today, 3)).toEqual({ fromDate: '2026-03-01', toDate: '2026-05-31' });
    expect(vat.currentQuarter(today, 3)).toEqual({ fromDate: '2026-06-01', toDate: '2026-07-01' });
  });
});
