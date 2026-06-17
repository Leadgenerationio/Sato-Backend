import { describe, it, expect } from 'vitest';
import { resolveYtdTotals } from '../services/campaign.service.js';
import type { LeadByteCampaignReportRow } from '../integrations/leadbyte/leadbyte-types.js';

// Minimal report-row factory — only the fields resolveYtdTotals reads.
function row(partial: Partial<LeadByteCampaignReportRow>): LeadByteCampaignReportRow {
  return {
    campaign: 'Test Campaign',
    leads: 0,
    payout: 0,
    revenue: 0,
    ...partial,
  } as LeadByteCampaignReportRow;
}

describe('resolveYtdTotals — campaign YTD source selection', () => {
  const month = row({ leads: 30, revenue: 3000, payout: 900 });
  const lastMonth = row({ leads: 20, revenue: 2000, payout: 600 });

  it('prefers the local Jan 1 → today sum when present (true YTD)', () => {
    const local = { leads: 500, revenue: 50_000, cost: 12_000 };
    const ytdRow = row({ leads: 9, revenue: 999 }); // LeadByte ytd has SOME data...
    const out = resolveYtdTotals(ytdRow, local, [month, lastMonth]);
    // ...but local wins because it's the genuine year-to-date figure.
    expect(out.source).toBe('local');
    expect(out.leads).toBe(500);
    expect(out.revenue).toBe(50_000);
    expect(out.leadbyteCost).toBe(12_000);
  });

  it('treats local-with-leads-but-zero-revenue as present (still true YTD)', () => {
    const local = { leads: 42, revenue: 0, cost: 0 };
    const out = resolveYtdTotals(row({ revenue: 9999 }), local, [month, lastMonth]);
    expect(out.source).toBe('local');
    expect(out.leads).toBe(42);
    expect(out.revenue).toBe(0);
  });

  it("falls back to LeadByte's ytd row when local has no data", () => {
    const ytdRow = row({ leads: 700, revenue: 70_000, payout: 5000, emailCost: 100, smsCost: 50, validationCost: 25 });
    const out = resolveYtdTotals(ytdRow, undefined, [month, lastMonth]);
    expect(out.source).toBe('leadbyte-ytd');
    expect(out.leads).toBe(700);
    expect(out.revenue).toBe(70_000);
    expect(out.leadbyteCost).toBe(5175); // payout + email + sms + validation
  });

  it('treats a zero local total as no-data and still uses LeadByte ytd', () => {
    const zeroLocal = { leads: 0, revenue: 0, cost: 0 };
    const out = resolveYtdTotals(row({ leads: 5, revenue: 500 }), zeroLocal, [month, lastMonth]);
    expect(out.source).toBe('leadbyte-ytd');
    expect(out.leads).toBe(5);
  });

  it('falls back to this_month + last_month sum when both local and ytd are empty', () => {
    const out = resolveYtdTotals(undefined, undefined, [month, lastMonth]);
    expect(out.source).toBe('window-sum');
    expect(out.leads).toBe(50); // 30 + 20
    expect(out.revenue).toBe(5000); // 3000 + 2000
    expect(out.leadbyteCost).toBe(1500); // 900 + 600
  });

  it('window-sum tolerates undefined window rows', () => {
    const out = resolveYtdTotals(undefined, undefined, [undefined, lastMonth]);
    expect(out.source).toBe('window-sum');
    expect(out.leads).toBe(20);
    expect(out.revenue).toBe(2000);
  });
});
