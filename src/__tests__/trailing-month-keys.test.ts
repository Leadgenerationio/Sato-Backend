import { describe, it, expect } from 'vitest';
import { trailingMonthKeys } from '../services/report.service.js';

// Feedback S12 (29 Sep 2026): the dashboard revenue axis read "Jan, Mar, Mar"
// on the 29th because the month series overflowed through a non-existent
// 29 February. Pure — no DB.
describe('trailingMonthKeys', () => {
  it('on 29 Sep 2026 yields 12 distinct consecutive months incl. February', () => {
    const keys = trailingMonthKeys(12, new Date(2026, 8, 29));
    expect(keys).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
  });

  it('on 31 Mar (a 31st after a short month) never repeats a month', () => {
    const keys = trailingMonthKeys(12, new Date(2026, 2, 31));
    expect(new Set(keys).size).toBe(12);
    expect(keys[keys.length - 1]).toBe('2026-03');
    expect(keys).toContain('2026-02');
  });

  it('crosses the year boundary', () => {
    expect(trailingMonthKeys(3, new Date(2026, 0, 30))).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});
