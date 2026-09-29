import { describe, it, expect } from 'vitest';
import {
  earliestWindowStart,
  mergeSuppliers,
  spendByPlatform,
  sumSpend,
  windowBounds,
} from '../services/campaign-money.js';
import { sourceKey, sourceLabel } from '../utils/catchr-platform.js';

// Sam S11 (2026-09-29) — campaign page: Supplier CPL chart had no bars,
// "facebook" and "Facebook Ads" were separate sources, and "Cost £0.00" sat
// next to a −£1,087.53 loss.

describe('sourceKey / sourceLabel', () => {
  it('collapses every Facebook spelling to one key and label', () => {
    for (const n of ['facebook', 'Facebook Ads', 'facebook-ads', ' FACEBOOK ', 'Meta']) {
      expect(sourceKey(n)).toBe('facebook-ads');
    }
    expect(sourceLabel('facebook-ads', 'facebook')).toBe('Facebook');
  });

  it('groups unknown supplier names case- and whitespace-insensitively', () => {
    expect(sourceKey('Acme  Leads ')).toBe(sourceKey('acme leads'));
    expect(sourceLabel(sourceKey('Acme Leads'), 'Acme Leads')).toBe('Acme Leads');
  });
});

describe('mergeSuppliers', () => {
  it('merges "facebook" and "Facebook Ads" into one source with summed leads, cost and revenue', () => {
    const rows = mergeSuppliers(
      [
        { name: 'facebook', totalSpend: 0, totalLeads: 120, revenue: 3000 },
        { name: 'Facebook Ads', totalSpend: 0, totalLeads: 70, revenue: 1750 },
      ],
      new Map([['facebook-ads', 14527.53]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'facebook-ads',
      name: 'Facebook',
      totalLeads: 190,
      revenue: 4750,
      leadbyteCost: 0,
      adSpend: 14527.53,
      totalSpend: 14527.53,
      cpl: 76.46,
    });
  });

  it('gives a direct-traffic source a non-zero CPL from ad spend when LeadByte payout is 0', () => {
    // The empty-chart bug: payout 0 → every bar had zero length.
    const [fb] = mergeSuppliers(
      [{ name: 'facebook', totalSpend: 0, totalLeads: 50, revenue: 0 }],
      new Map([['facebook-ads', 1000]]),
    );
    expect(fb.cpl).toBe(20);
  });

  it('adds LeadByte payout and ad spend for the same platform, and leaves other suppliers alone', () => {
    const rows = mergeSuppliers(
      [
        { name: 'google', totalSpend: 100, totalLeads: 10, revenue: 500 },
        { name: 'Affiliate X', totalSpend: 300, totalLeads: 30, revenue: 900 },
      ],
      new Map([['google-ads', 50]]),
    );
    const google = rows.find((r) => r.id === 'google-ads')!;
    const aff = rows.find((r) => r.name === 'Affiliate X')!;
    expect(google).toMatchObject({ leadbyteCost: 100, adSpend: 50, totalSpend: 150, cpl: 15 });
    expect(aff).toMatchObject({ leadbyteCost: 300, adSpend: 0, totalSpend: 300, cpl: 10 });
    // Sorted by total cost, largest first.
    expect(rows.map((r) => r.name)).toEqual(['Affiliate X', 'Google']);
  });

  it('keeps a platform that has ad spend but no LeadByte leads, with cpl null (never "£0")', () => {
    const rows = mergeSuppliers([], new Map([['taboola', 250], ['tik-tok', 0]]));
    expect(rows).toEqual([
      expect.objectContaining({ id: 'taboola', name: 'Taboola', totalLeads: 0, adSpend: 250, cpl: null }),
    ]);
  });
});

describe('windowBounds', () => {
  // Tuesday 29 September 2026 — the day Sam tested.
  const now = new Date(Date.UTC(2026, 8, 29, 10, 0, 0));

  it('uses Monday-start weeks', () => {
    expect(windowBounds('this_week', now)).toEqual({ start: '2026-09-28', end: '2026-09-29' });
    expect(windowBounds('last_week', now)).toEqual({ start: '2026-09-21', end: '2026-09-27' });
  });

  it('computes calendar months, today, yesterday, ytd and last_30d', () => {
    expect(windowBounds('today', now)).toEqual({ start: '2026-09-29', end: '2026-09-29' });
    expect(windowBounds('yesterday', now)).toEqual({ start: '2026-09-28', end: '2026-09-28' });
    expect(windowBounds('this_month', now)).toEqual({ start: '2026-09-01', end: '2026-09-29' });
    expect(windowBounds('last_month', now)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(windowBounds('ytd', now)).toEqual({ start: '2026-01-01', end: '2026-09-29' });
    expect(windowBounds('last_30d', now)).toEqual({ start: '2026-08-30', end: '2026-09-29' });
  });

  it('gets last month right on the 31st (no setMonth overflow)', () => {
    const mar31 = new Date(Date.UTC(2026, 2, 31, 12));
    expect(windowBounds('last_month', mar31)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });

  it('crosses the year boundary in January', () => {
    const jan5 = new Date(Date.UTC(2027, 0, 5, 12)); // a Tuesday
    expect(windowBounds('last_month', jan5)).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(windowBounds('last_week', jan5)).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(earliestWindowStart(['ytd', 'last_month', 'last_30d'], jan5)).toBe('2026-12-01');
  });
});

describe('sumSpend / spendByPlatform', () => {
  const rows = [
    { platform: 'facebook-ads', date: '2026-09-29', spend: 10 },
    { platform: 'facebook-ads', date: '2026-09-01', spend: 5 },
    { platform: 'google-ads', date: '2026-09-29', spend: 2.5 },
    { platform: 'facebook-ads', date: '2026-08-31', spend: 100 },
  ];

  it('sums only rows inside the inclusive bounds', () => {
    expect(sumSpend(rows, { start: '2026-09-01', end: '2026-09-29' })).toBe(17.5);
    expect(sumSpend(rows, { start: '2026-09-01', end: '2026-09-29' }, 'facebook-ads')).toBe(15);
  });

  it('splits spend per platform', () => {
    const m = spendByPlatform(rows, { start: '2026-09-01', end: '2026-09-29' });
    expect(Object.fromEntries(m)).toEqual({ 'facebook-ads': 15, 'google-ads': 2.5 });
  });
});
