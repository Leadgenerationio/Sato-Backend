import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_WINDOW_MS,
  GENERAL_LIMIT_MAX,
  AUTH_LIMIT_MAX,
} from '../middleware/rate-limit.middleware.js';

// Sam reported "Too many requests, please try again later" while categorising
// bank-feed transactions on 30-Apr. Root cause was the 100/15min general
// limiter being too tight for an active admin SPA session (dashboard polls
// + LeadByte hooks + pagination + clicks). Bumped to 1500/15min. Auth limiter
// stays tight against brute-force login attempts. These tests pin those
// numbers so a future tightening can't silently regress the bank-feed flow.

describe('rate-limit middleware caps', () => {
  it('general limiter allows ~100 rpm — at least 1500 / 15 min', () => {
    expect(GENERAL_LIMIT_MAX).toBeGreaterThanOrEqual(1500);
    expect(RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('auth limiter stays tight against login brute-force (≤ 30 / 15 min)', () => {
    expect(AUTH_LIMIT_MAX).toBeLessThanOrEqual(30);
  });
});
