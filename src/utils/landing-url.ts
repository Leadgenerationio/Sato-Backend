// Landing pages are stored once per client, keyed by this normalised form, so
// the same page reached from two ads (different tracking params) is one row.
// Lower-cases scheme + host, drops tracking params (utm_*, fbclid, gclid,
// msclkid, ttclid), the fragment, default ports and a trailing slash. Other
// query params are kept (and sorted) because they can change the page.
const TRACKING = new Set(['fbclid', 'gclid', 'msclkid', 'ttclid']);

export function normaliseLandingUrl(url: string): string {
  const raw = url.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw.toLowerCase();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  const out = `${u.protocol}//${u.host}${path === '/' ? '' : path}${u.search}`;
  return out;
}
