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
