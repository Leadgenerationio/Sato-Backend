import { describe, it, expect } from 'vitest';
import { cronNextFire, isValidCron, CronParseError } from '../utils/cron-next.js';

// Slice 5 Day 4 — pin the cron next-fire math against fixed reference dates
// so a future cron-syntax refactor can't regress silently.

describe('cron-next — common patterns', () => {
  it('daily at 09:00 from a mid-morning time returns tomorrow 09:00', () => {
    const from = new Date(Date.UTC(2026, 4, 11, 10, 0));  // Mon 11 May 2026 10:00 UTC
    const next = cronNextFire('0 9 * * *', from);
    // Local-time clocks vary; assert the wall-clock interpretation in the
    // host TZ. Day must be the next calendar day; hour:minute = 09:00.
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime() > from.getTime()).toBe(true);
  });

  it('every Monday 09:00 from a Friday returns the next Monday', () => {
    const from = new Date(2026, 4, 15, 12, 0); // Fri 15 May 2026 (local)
    const next = cronNextFire('0 9 * * 1', from);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('every 30 min advances exactly 30 min when from an on-the-hour', () => {
    const from = new Date(2026, 4, 11, 10, 0);
    const next = cronNextFire('*/30 * * * *', from);
    // Should fire at :30 of the same hour.
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(30);
  });

  it('every 15 min from :07 fires at :15', () => {
    const from = new Date(2026, 4, 11, 10, 7);
    const next = cronNextFire('*/15 * * * *', from);
    expect(next.getMinutes()).toBe(15);
  });

  it('1st of month 09:00 from mid-month returns next month 1st', () => {
    const from = new Date(2026, 4, 15, 12, 0);  // 15 May
    const next = cronNextFire('0 9 1 * *', from);
    expect(next.getDate()).toBe(1);
    expect(next.getMonth()).toBe(5); // June (0-based)
    expect(next.getHours()).toBe(9);
  });

  it('weekday business hours (9-17 Mon-Fri) skips weekends', () => {
    // Saturday 10:00
    const from = new Date(2026, 4, 16, 10, 0);
    const next = cronNextFire('0 9-17 * * 1-5', from);
    // Should jump to Monday 09:00.
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(9);
  });

  it('always returns a date strictly greater than `from`', () => {
    const from = new Date(2026, 4, 11, 9, 0);
    // A pattern that matches `from` exactly — next fire must still be later.
    const next = cronNextFire('0 9 * * *', from);
    expect(next.getTime() > from.getTime()).toBe(true);
  });
});

describe('cron-next — validation', () => {
  it('isValidCron accepts standard 5-field patterns', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1')).toBe(true);
    expect(isValidCron('*/15 9-17 * * 1-5')).toBe(true);
    expect(isValidCron('0 0 1,15 * *')).toBe(true);
  });

  it('isValidCron rejects malformed expressions', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('* * *')).toBe(false);              // too few fields
    expect(isValidCron('* * * * * *')).toBe(false);         // too many
    expect(isValidCron('99 * * * *')).toBe(false);          // minute out of range
    expect(isValidCron('* 25 * * *')).toBe(false);          // hour out of range
    expect(isValidCron('* * 32 * *')).toBe(false);          // dom out of range
  });

  it('cronNextFire throws CronParseError on bad input', () => {
    expect(() => cronNextFire('not a cron', new Date())).toThrow(CronParseError);
  });
});
