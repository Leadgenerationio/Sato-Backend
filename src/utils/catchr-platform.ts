/**
 * Canonicalise free-text platform strings to the `CatchrPlatform` identifier
 * stored in `ad_spend.platform`.
 *
 * Why this exists: two places in the system disagree on platform spelling.
 *
 *   - `ad_spend.platform` is written by the Catchr sync and uses the
 *     hyphenated lowercase strings from `src/integrations/catchr/catchr-types.ts`
 *     (`google-ads`, `facebook-ads`, `bing-ads`, `tik-tok`, `taboola`).
 *
 *   - `traffic_sources.platform` is written by the campaign-detail picker on
 *     the FE, which uses friendlier values — `google`, `facebook`, `TikTok`,
 *     etc. (verified in prod: `SELECT DISTINCT platform FROM traffic_sources;`
 *     returned `google`, `facebook`, `Google`, `Facebook`, `TikTok`).
 *
 * Before this normalizer the join inside `aggregateCatchrSpend` was
 * `a.platform = sa.platform`, which silently produced 0 rows for every
 * campaign — `'google' != 'google-ads'`. The list view then showed
 * `totalCost: 0` and `margin: 100%` for every direct-traffic campaign even
 * when £100k+/month of real Catchr spend was sitting in `ad_spend`.
 *
 * Returns `null` when the input can't be normalized — callers should treat
 * that as "no canonical platform" and emit no rows for that side of the
 * join (matches the original behaviour of dropping unsupported platforms).
 */
export type CanonicalPlatform =
  | 'google-ads'
  | 'facebook-ads'
  | 'bing-ads'
  | 'tik-tok'
  | 'taboola';

export function canonicalizePlatform(input: string | null | undefined): CanonicalPlatform | null {
  if (typeof input !== 'string') return null;
  const n = input.toLowerCase().trim();
  if (!n) return null;
  if (n === 'facebook-ads' || n === 'facebook' || n === 'meta' || n.includes('facebook') || n.includes('meta ads')) return 'facebook-ads';
  if (n === 'google-ads' || n === 'google' || n.includes('google')) return 'google-ads';
  if (n === 'tik-tok' || n === 'tiktok' || n === 'tik tok' || n.includes('tiktok')) return 'tik-tok';
  if (n === 'taboola' || n.includes('taboola')) return 'taboola';
  if (n === 'bing-ads' || n === 'bing' || n === 'microsoft' || n.includes('bing') || n.includes('microsoft')) return 'bing-ads';
  return null;
}

/**
 * Postgres `CASE` expression that produces the same normalization as
 * {@link canonicalizePlatform}. Inlined into the JOIN so the DB can apply
 * it to both `ad_spend.platform` and `traffic_sources.platform` in one
 * scan. Generated as a string fragment so Drizzle's `sql` template can
 * splice it without losing parameter binding on the surrounding query —
 * the expression is data-free (no user input) so it's safe to interpolate.
 *
 * Keep the SQL branches in lockstep with {@link canonicalizePlatform}:
 * the unit tests assert both produce the same answer for the prod
 * platform vocabulary.
 */
export function canonicalPlatformSql(column: string): string {
  // lower(trim(...)) once, then compare to the canonical hyphen form or any
  // common synonym. ORDER MATTERS: 'facebook-ads' must match before the
  // bare 'facebook' branch would (both contain 'facebook'); the LIKE
  // checks are ordered so the most specific value wins first.
  return `case
    when lower(trim(${column})) in ('facebook-ads', 'facebook', 'meta') or lower(${column}) like '%facebook%' or lower(${column}) like '%meta ads%' then 'facebook-ads'
    when lower(trim(${column})) in ('google-ads', 'google') or lower(${column}) like '%google%' then 'google-ads'
    when lower(trim(${column})) in ('tik-tok', 'tiktok', 'tik tok') or lower(${column}) like '%tiktok%' then 'tik-tok'
    when lower(trim(${column})) in ('taboola') or lower(${column}) like '%taboola%' then 'taboola'
    when lower(trim(${column})) in ('bing-ads', 'bing', 'microsoft') or lower(${column}) like '%bing%' or lower(${column}) like '%microsoft%' then 'bing-ads'
    else null
  end`;
}
