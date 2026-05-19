/**
 * Derive a human-readable vertical/category from a campaign name.
 *
 * LeadByte's `/campaigns` endpoint doesn't carry a vertical column, and
 * Sam hasn't backfilled the Sato `campaigns.vertical` field manually —
 * so the dashboard's "Campaign Sources" pie chart was rendering 100% in
 * a single "Other" slice. Keyword-match against the campaign name to
 * bucket cleanly (Solar, Insulation, Hearing Aids, Tax Claims, etc.).
 *
 * Order matters — more specific phrases first so they match before
 * generics.
 *
 * Returns 'Other' when no keyword matches; callers can decide whether
 * to merge that bucket with named verticals or surface separately.
 */
export function deriveVerticalFromName(name: string): string {
  const lower = (name ?? '').toLowerCase();
  const keywords: Array<{ match: string | RegExp; label: string }> = [
    { match: 'hearing aid', label: 'Hearing Aids' },
    { match: 'solar', label: 'Solar' },
    { match: 'insulation', label: 'Insulation' },
    { match: 'conservatory', label: 'Conservatory' },
    { match: 'loft', label: 'Home Improvement' },
    { match: 'spray foam', label: 'Home Improvement' },
    { match: 'lasting power of attorney', label: 'Legal — LPA' },
    { match: 'will writ', label: 'Will Writing' },
    { match: 'pcp claim', label: 'PCP Claims' },
    { match: 'tax claim', label: 'Tax Claims' },
    { match: 'mortgage', label: 'Mortgage' },
    { match: 'life insurance', label: 'Life Insurance' },
    { match: 'home insurance', label: 'Home Insurance' },
    { match: 'pmi', label: 'Private Medical Insurance' },
    { match: 'house sale', label: 'Property Sales' },
    { match: 'property sale', label: 'Property Sales' },
    { match: 'boiler', label: 'Boiler' },
    { match: 'debt', label: 'Debt Management' },
    { match: 'flight delay', label: 'Travel — Flight Delay' },
    { match: 'police', label: 'Legal — Police Claims' },
    { match: 'personal injury', label: 'Personal Injury' },
  ];
  for (const k of keywords) {
    if (typeof k.match === 'string' ? lower.includes(k.match) : k.match.test(lower)) {
      return k.label;
    }
  }
  return 'Other';
}

/**
 * Pick the best vertical for a campaign: prefer the explicit DB value if
 * present and not the placeholder 'Unmapped', otherwise fall back to the
 * name-derived one.
 */
export function pickVertical(name: string, dbVertical: string | null | undefined): string {
  if (dbVertical && dbVertical !== 'Unmapped' && dbVertical.trim() !== '') return dbVertical;
  return deriveVerticalFromName(name);
}
