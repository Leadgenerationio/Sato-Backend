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

describe('vat.service — historicalQuarters (Sam Loom #12)', () => {
  it('returns the requested count of past quarters skipping the most-recent one', () => {
    // Today = 11 May 2026 stagger 2 (CMS):
    //   previousQuarter = Feb-Apr 2026 (most-recent closed — skipped)
    //   history[0]      = Nov 2025-Jan 2026
    //   history[1]      = Aug-Oct 2025
    //   history[2]      = May-Jul 2025
    const today = d('2026-05-11');
    const hist = vat.historicalQuarters(3, today, 2);
    expect(hist).toHaveLength(3);
    expect(hist[0]).toMatchObject({ fromDate: '2025-11-01', toDate: '2026-01-31' });
    expect(hist[1]).toMatchObject({ fromDate: '2025-08-01', toDate: '2025-10-31' });
    expect(hist[2]).toMatchObject({ fromDate: '2025-05-01', toDate: '2025-07-31' });
    hist.forEach((r) => expect(r.label).toMatch(/\d{4}/));
  });

  it('count=0 returns empty', () => {
    expect(vat.historicalQuarters(0, d('2026-05-11'), 2)).toEqual([]);
  });

  it('caps at the available enumeration window (no negative-year crash)', () => {
    // Request more quarters than the [year-1, year+1] window can supply.
    const hist = vat.historicalQuarters(20, d('2026-05-11'), 2);
    expect(hist.length).toBeGreaterThan(0);
    expect(hist.length).toBeLessThan(20);
  });

  it('stagger 1 calendar quarters: today 2026-05-11 → history = Oct-Dec 2025, Jul-Sep 2025…', () => {
    const today = d('2026-05-11');
    const hist = vat.historicalQuarters(2, today, 1);
    expect(hist[0]).toMatchObject({ fromDate: '2025-10-01', toDate: '2025-12-31' });
    expect(hist[1]).toMatchObject({ fromDate: '2025-07-01', toDate: '2025-09-30' });
  });
});
