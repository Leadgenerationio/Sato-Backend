import { CREATIVE_CLIENT_SHA_INDEX } from '../db/schema/creatives.js';

/**
 * A Postgres unique violation (23505). Drizzle wraps the driver error in a
 * DrizzleQueryError and puts the Postgres code on `.cause`, so `err.code`
 * alone is never set.
 */
/** The name of the unique index or constraint a 23505 violated (the driver puts it on the error or on its cause). */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  const e = err as { constraint_name?: string; constraint?: string; cause?: { constraint_name?: string; constraint?: string } } | null;
  return e?.constraint_name ?? e?.constraint ?? e?.cause?.constraint_name ?? e?.cause?.constraint;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** A unique violation of OUR creatives (client, file or text hash) index: the sign that the same asset raced in. Any other unique violation is a different problem. */
export function isCreativeShaRace(err: unknown): boolean {
  return isUniqueViolation(err) && uniqueViolationConstraint(err) === CREATIVE_CLIENT_SHA_INDEX;
}
