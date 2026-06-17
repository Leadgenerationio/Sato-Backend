// CORS allow-list logic, extracted so it's unit-testable (index.ts wires it
// into the cors() middleware).
//
// First-party portal domains: every business Sam runs gets a
// `{business}.stato.tech` subdomain (see the multi-business subdomain plan),
// so the whole `stato.tech` family is trusted by default — a new business
// subdomain works without a CORS_ORIGINS edit. Everything else must be in the
// explicit configured allow-list (CORS_ORIGINS / FRONTEND_URL).

const FIRST_PARTY_HOST_SUFFIX = '.stato.tech';

/**
 * True for the product's own portal domains: `https://stato.tech` or any
 * `https://*.stato.tech` subdomain. HTTPS-only, and the leading dot in the
 * suffix check stops look-alikes like `evil-stato.tech` or `stato.tech.evil.com`
 * from matching.
 */
export function isFirstPartyStatoOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'stato.tech' || url.hostname.endsWith(FIRST_PARTY_HOST_SUFFIX);
}

/**
 * Whether a request Origin is allowed. No Origin (server-to-server, curl,
 * health checks) is allowed; otherwise it must be either in the configured
 * allow-list or a first-party stato.tech domain.
 */
export function isOriginAllowed(origin: string | undefined, configuredOrigins: string[]): boolean {
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  return isFirstPartyStatoOrigin(origin);
}
