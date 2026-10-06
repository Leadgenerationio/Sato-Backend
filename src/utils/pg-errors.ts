/**
 * A Postgres unique violation (23505). Drizzle wraps the driver error in a
 * DrizzleQueryError and puts the Postgres code on `.cause`, so `err.code`
 * alone is never set.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
