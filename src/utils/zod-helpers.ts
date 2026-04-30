import { z } from 'zod';

/**
 * UUID regex that accepts ANY 36-char UUID-shape, including legacy / nil-style
 * UUIDs whose version nibble is 0 (e.g. the demo seed client ID
 * 00000000-0000-0000-0000-000000000001). Zod 4's built-in `.uuid()` enforces
 * strict RFC 4122 versions (1-8) and rejects those, which broke every demo
 * Send-Agreement / Create-Invoice / Upload-Creative attempt against seeded
 * data. Postgres' `uuid` column already enforces shape on insert, so this
 * client-facing check is purely a 36-char shape guard.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidShape = (label = 'must be a UUID') => z.string().regex(UUID_SHAPE, label);

/** Pure regex check — used by services that need to short-circuit before
 * passing a value to a Postgres `uuid` column (LeadByte campaign IDs are
 * numeric strings like "2" and would crash an internal Postgres query). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/** Coerce a possibly non-UUID actor ID to either UUID-or-null for safe FK
 * insertion. The legacy in-memory seed users have ids like '1','2','3' — if
 * those land in a Postgres `uuid` column the insert blows up with "invalid
 * input syntax for type uuid". Use this everywhere `requester.userId` is
 * persisted as a `references(users.id)` FK. */
export function uuidOrNull(value: unknown): string | null {
  return isUuid(value) ? value : null;
}
