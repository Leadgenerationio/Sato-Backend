import { UnauthorizedError } from './errors.js';

/**
 * S8 (Sam feedback 29 Sep 2026): time-limited access. Throws a plain-words
 * 401 once the end date the Owner set has passed. No end date = no limit.
 */
export function assertAccessNotExpired(accessExpiresAt: Date | string | null | undefined, now = new Date()): void {
  if (!accessExpiresAt) return;
  const ends = new Date(accessExpiresAt);
  if (Number.isNaN(ends.getTime()) || ends.getTime() > now.getTime()) return;
  const day = ends.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  throw new UnauthorizedError(`Your access ended on ${day}. Ask the account owner to extend it.`);
}
