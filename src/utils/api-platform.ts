import { canonicalizePlatform } from './catchr-platform.js';

// Platform names at the public API / MCP boundary (spec v1.0 §2.1).
//
// Stato stores two vocabularies and this file is the only place that knows
// both:
//   - client_ad_accounts and ad_spend use the Catchr spelling: facebook-ads,
//     google-ads, tik-tok, taboola, bing-ads.
//   - creatives and creative_ad_links use meta, google, tiktok, taboola.
// The API speaks one vocabulary (meta, google, tiktok, taboola, bing) in and
// out, and accepts any spelling canonicalizePlatform understands on the way
// in (facebook-ads, Facebook, tik-tok, …). No data is migrated.

export const API_PLATFORMS = ['meta', 'google', 'tiktok', 'taboola', 'bing'] as const;
export type ApiPlatform = (typeof API_PLATFORMS)[number];

/** Platforms a creative or an ad link can be stored under. */
export type CreativePlatform = 'meta' | 'google' | 'tiktok' | 'taboola';

const FROM_CATCHR: Record<string, ApiPlatform> = {
  'facebook-ads': 'meta',
  'google-ads': 'google',
  'tik-tok': 'tiktok',
  taboola: 'taboola',
  'bing-ads': 'bing',
};

/** Any spelling (stored or typed) → the API name, or null when unknown. */
export function toApiPlatform(input: string | null | undefined): ApiPlatform | null {
  const canonical = canonicalizePlatform(input);
  return canonical ? FROM_CATCHR[canonical] ?? null : null;
}

/** The API name for a stored value; unknown values are returned lower-cased so nothing is hidden. */
export function apiPlatformOut(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  return toApiPlatform(stored) ?? stored.toLowerCase().trim();
}

/** Spelling stored in client_ad_accounts (Catchr), or null when unknown. */
export function toAccountPlatform(input: string | null | undefined): string | null {
  return canonicalizePlatform(input);
}

/** Spelling stored in creatives / creative_ad_links, or null when the platform can't hold creatives (bing, unknown). */
export function toCreativePlatform(input: string | null | undefined): CreativePlatform | null {
  const api = toApiPlatform(input);
  return api && api !== 'bing' ? api : null;
}
