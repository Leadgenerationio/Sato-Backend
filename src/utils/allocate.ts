/**
 * Allocate an integer `total` across buckets weighted by `shares` (which should
 * sum to ~1), giving leftover units to the largest fractional remainders so the
 * returned integers ALWAYS sum back to `total` — no units gained or lost.
 *
 * Used to split a campaign's valid-lead count across the multiple ad platforms
 * it runs on (portal "By Source") when LeadByte can't attribute per-source.
 */
export function largestRemainderAllocate(total: number, shares: number[]): number[] {
  if (shares.length === 0) return [];
  const raw = shares.map((s) => s * total);
  const result = raw.map((x) => Math.floor(x));
  let remaining = total - result.reduce((s, x) => s + x, 0);
  const byFraction = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byFraction.length && remaining > 0; k++) {
    result[byFraction[k].i] += 1;
    remaining--;
  }
  return result;
}
