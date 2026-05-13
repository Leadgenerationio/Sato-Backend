import { describe, it, expect } from 'vitest';
import { computeDaysOverdue, deriveDisplayStatus } from '../services/invoice.service.js';

describe('invoice — computeDaysOverdue', () => {
  it('returns 0 when paidDate is set', () => {
    const due = new Date(Date.now() - 14 * 86_400_000); // 14 days ago
    expect(computeDaysOverdue(due, new Date(), 'paid')).toBe(0);
  });

  it('returns 0 when status is paid even without paidDate', () => {
    const due = new Date(Date.now() - 14 * 86_400_000);
    expect(computeDaysOverdue(due, null, 'paid')).toBe(0);
  });

  it('returns 0 when dueDate is null', () => {
    expect(computeDaysOverdue(null, null, 'sent')).toBe(0);
  });

  it('returns 0 when dueDate is in the future', () => {
    const due = new Date(Date.now() + 7 * 86_400_000);
    expect(computeDaysOverdue(due, null, 'sent')).toBe(0);
  });

  it('returns the floor of days past due for a late invoice', () => {
    const due = new Date(Date.now() - 14 * 86_400_000 - 5 * 60_000); // 14d 5min ago
    expect(computeDaysOverdue(due, null, 'sent')).toBe(14);
  });
});

describe('invoice — deriveDisplayStatus (Sam Loom #6)', () => {
  it('keeps "paid" as-is', () => {
    expect(deriveDisplayStatus('paid', 14)).toBe('paid');
  });

  it('keeps "draft" as-is even if "overdue"', () => {
    expect(deriveDisplayStatus('draft', 14)).toBe('draft');
  });

  it('keeps "overdue" as-is', () => {
    expect(deriveDisplayStatus('overdue', 14)).toBe('overdue');
  });

  it('promotes "authorised" with days > 0 to "overdue"', () => {
    expect(deriveDisplayStatus('authorised', 1)).toBe('overdue');
  });

  it('promotes "sent" with days > 0 to "overdue"', () => {
    expect(deriveDisplayStatus('sent', 5)).toBe('overdue');
  });

  it('keeps "authorised" with daysOverdue=0 (not yet late)', () => {
    expect(deriveDisplayStatus('authorised', 0)).toBe('authorised');
  });

  it('keeps "sent" with daysOverdue=0 (not yet late)', () => {
    expect(deriveDisplayStatus('sent', 0)).toBe('sent');
  });

  it('defaults null status to "draft"', () => {
    expect(deriveDisplayStatus(null, 0)).toBe('draft');
  });
});
