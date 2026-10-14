import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { ValidationError } from '../utils/errors.js';
import { isBlockedIp } from '../utils/ip-guard.js';

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

/**
 * True when a connection to `ip` must be refused under `policy`. Delegates to the shared ip-guard classifier so the
 * webhook and upload-fetch SSRF guards can never drift apart. Loopback is allowed outside production so a local
 * receiver (tests, `nc -l`) works; everything else internal is always refused.
 */
export function isBlockedAddress(ip: string, policy: UrlPolicy = defaultPolicy()): boolean {
  return isBlockedIp(ip, { allowLoopback: !policy.production });
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
