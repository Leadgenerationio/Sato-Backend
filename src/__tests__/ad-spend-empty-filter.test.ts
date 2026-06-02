import { describe, it, expect } from 'vitest';
import { summarizeAdSpend, totalSpend } from '../services/ad-spend.service.js';

// Regression: summarizeAdSpend()/totalSpend() build their WHERE via
// buildWhere(filters), which returns `undefined` when no filters are supplied.
// That undefined was interpolated straight into the raw SQL (`where ${where}`),
// producing an invalid/degenerate query on a no-filter call — e.g. a bare
// GET /ad-spend/summary. The guard now emits an empty fragment when there's no
// filter, so the unfiltered roll-up works instead of crashing/returning nothing.

describe('ad-spend roll-up with no filters (empty WHERE guard)', () => {
  it('summarizeAdSpend() with no filters resolves to an array', async () => {
    const rows = await summarizeAdSpend();
    expect(Array.isArray(rows)).toBe(true);
    // Shape check on any rows present in the test DB.
    for (const r of rows) {
      expect(typeof r.platform).toBe('string');
      expect(typeof r.totalSpend).toBe('number');
      expect(Number.isFinite(r.totalSpend)).toBe(true);
    }
  });

  it('totalSpend() with no filters resolves to a finite total + rowCount', async () => {
    const res = await totalSpend();
    expect(typeof res.total).toBe('number');
    expect(Number.isFinite(res.total)).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(0);
    expect(typeof res.rowCount).toBe('number');
    expect(res.rowCount).toBeGreaterThanOrEqual(0);
    expect(res.currency).toBe('GBP');
  });

  it('passing a filter still narrows the result (guard does not disable filtering)', async () => {
    // A platform that cannot exist → must return zero spend, proving the WHERE
    // is still applied when a filter IS supplied (guard only affects the
    // no-filter case).
    const res = await totalSpend({ platform: '__nonexistent_platform__' });
    expect(res.total).toBe(0);
  });
});
