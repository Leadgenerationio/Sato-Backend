import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  lastQuarterEnd,
  currentQuarterRange,
  lastCompletedQuarterRange,
} from '../services/vat.service.js';

// Clinical Marketing Solutions' VAT quarters end Apr 30 / Jul 31 / Oct 31 / Jan 31
// (Sam's Loom confirmation: "Feb, March, April. So that is one quarter. And
// then the next quarter is going to be from May, June, July."). CMS is on
// HMRC stagger 2 — pin the env var here so this suite tests CMS specifically.

describe('vat.service — CMS quarter math', () => {
  const originalStagger = process.env.XERO_VAT_STAGGER;
  beforeAll(() => { process.env.XERO_VAT_STAGGER = '2'; });
  afterAll(() => {
    if (originalStagger === undefined) delete process.env.XERO_VAT_STAGGER;
    else process.env.XERO_VAT_STAGGER = originalStagger;
  });

  it('lastQuarterEnd: 11 May 2026 → 30 Apr 2026', () => {
    expect(lastQuarterEnd(new Date('2026-05-11T12:00:00Z'))).toBe('2026-04-30');
  });

  it('lastQuarterEnd: 15 Feb 2026 → 31 Jan 2026 (crosses calendar year)', () => {
    expect(lastQuarterEnd(new Date('2026-02-15T12:00:00Z'))).toBe('2026-01-31');
  });

  it('lastQuarterEnd: 1 Aug 2026 → 31 Jul 2026', () => {
    expect(lastQuarterEnd(new Date('2026-08-01T12:00:00Z'))).toBe('2026-07-31');
  });

  it('lastQuarterEnd: midday on 30 Apr 2026 → 30 Apr 2026 (already past midnight Apr 30)', () => {
    // Boundary semantics: 30 Apr 12:00 is strictly after 30 Apr 00:00, so the
    // Apr 30 quarter end already qualifies as "last completed". Practically
    // this is what Sam wants — the quarter has ended for the day.
    expect(lastQuarterEnd(new Date('2026-04-30T12:00:00Z'))).toBe('2026-04-30');
  });

  it('currentQuarterRange: 11 May 2026 → 1 May–11 May 2026', () => {
    const r = currentQuarterRange(new Date('2026-05-11T12:00:00Z'));
    expect(r.fromDate).toBe('2026-05-01');
    expect(r.toDate).toBe('2026-05-11');
    expect(r.label).toMatch(/May/);
  });

  it('lastCompletedQuarterRange: 11 May 2026 → Feb-Apr 2026 (Sam\'s example)', () => {
    const r = lastCompletedQuarterRange(new Date('2026-05-11T12:00:00Z'));
    expect(r.fromDate).toBe('2026-02-01');
    expect(r.toDate).toBe('2026-04-30');
    expect(r.label).toMatch(/Feb/);
    expect(r.label).toMatch(/Apr/);
  });

  it('lastCompletedQuarterRange: 15 Feb 2026 → Nov 2025–Jan 2026 (crosses year)', () => {
    const r = lastCompletedQuarterRange(new Date('2026-02-15T12:00:00Z'));
    expect(r.fromDate).toBe('2025-11-01');
    expect(r.toDate).toBe('2026-01-31');
    expect(r.label).toMatch(/Nov/);
    expect(r.label).toMatch(/Jan/);
  });
});
