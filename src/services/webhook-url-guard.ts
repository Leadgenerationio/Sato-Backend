import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { ValidationError } from '../utils/errors.js';

// SSRF guard for outbound webhooks. An Owner types the URL, but the request
// comes from our server, inside Railway's network — so a URL must never reach
// loopback, private, link-local (cloud metadata 169.254.169.254) or other
// internal ranges.
//
// Two layers:
//   1. assertWebhookUrl() — shape + every resolved address, checked when an
//      endpoint is saved (so the Owner gets a clear error up front).
//   2. guardedLookup — passed as the `lookup` of each delivery request, so the
//      address actually connected to is re-checked at connect time. A DNS
//      answer that changes after step 1 (rebinding) can't slip through.
//
// Production: https only, loopback blocked. Elsewhere: http is allowed and
// loopback is allowed so a local receiver (tests, `nc -l`) works.

export interface UrlPolicy {
  production: boolean;
}

export const defaultPolicy = (): UrlPolicy => ({ production: env.NODE_ENV === 'production' });

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function inV4(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Expands an IPv6 address (incl. "::" and a trailing dotted IPv4) to 8 numeric groups. */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    text = text.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  const nums = groups.map((x) => parseInt(x, 16));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/** True when a connection to `ip` must be refused under `policy`. */
export function isBlockedAddress(ip: string, policy: UrlPolicy = defaultPolicy()): boolean {
  const family = isIP(ip);
  if (family === 4) {
    if (inV4(ip, ['127.0.0.0', 8])) return policy.production;
    return V4_BLOCKED.some((r) => inV4(ip, r));
  }
  if (family === 6) {
    const g = expandV6(ip.replace(/^\[|\]$/g, ''));
    if (!g) return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms. The WHATWG URL
    // parser rewrites "[::ffff:127.0.0.1]" to "[::ffff:7f00:1]", so the check
    // must work on the numeric groups, not on the text.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && g[7] <= 1) {
        return g[7] === 1 ? policy.production : true; // ::1 loopback, :: unspecified
      }
      return isBlockedAddress(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`, policy);
    }
    const first = g[0];
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (first === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 reaches v4 internals
    return false;
  }
  return true; // not an IP at all — refuse
}

function resolveAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

/** Validates an endpoint URL. Throws ValidationError with a plain message. */
export async function assertWebhookUrl(raw: string, policy: UrlPolicy = defaultPolicy()): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Enter a full web address, for example https://example.com/stato-webhook');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.production)) {
    throw new ValidationError('Webhook addresses must start with https://');
  }
  if (url.username || url.password) {
    throw new ValidationError('Webhook addresses cannot contain a username or password');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = (await resolveAll(host)).map((a) => a.address);
    } catch {
      throw new ValidationError(`We couldn't find the server "${host}". Check the address.`);
    }
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a, policy))) {
    throw new ValidationError('That address points to a private or internal network, which webhooks cannot reach');
  }
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `lookup` for http(s).request — refuses blocked addresses at connect time. */
export function guardedLookup(policy: UrlPolicy = defaultPolicy()) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb): void => {
    const opts = typeof options === 'object' && options ? options : {};
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err, '');
      const bad = addrs.find((a) => isBlockedAddress(a.address, policy));
      if (bad || addrs.length === 0) {
        const e: NodeJS.ErrnoException = new Error(`Blocked webhook destination ${bad?.address ?? hostname}`);
        e.code = 'EWEBHOOKBLOCKED';
        return cb(e, '');
      }
      if (opts.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}
