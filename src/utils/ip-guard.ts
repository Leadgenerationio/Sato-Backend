// One IP classifier shared by both SSRF guards (remote-media sourceUrl fetches and webhook delivery). Keeping the
// ranges in a single place stops the two lists from drifting apart — the reason this was extracted. "Blocked" means the
// address is not a public unicast address the server may connect to: loopback, private, link/site-local, ULA, CGNAT,
// multicast, the IANA special/documentation ranges, and the v4 carried inside v4-mapped / 6to4 / NAT64 IPv6 forms.
//
// `allowLoopback` is the only policy knob: upload fetches always refuse loopback (SSRF), but a webhook receiver on
// localhost is legitimate in development, so that guard passes allowLoopback = true outside production.

import { isIP } from 'node:net';

export interface IpGuardOptions { allowLoopback?: boolean }

// Expand an IPv6 literal into 8 16-bit groups (null when it is not valid IPv6). Handles a %zone suffix and a trailing
// dotted quad (::ffff:127.0.0.1 → two hex groups).
export function ipv6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const quad = v.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const o = [quad[2], quad[3], quad[4], quad[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    v = `${quad[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

// Private/special IPv4 ranges EXCEPT loopback (127/8), which the caller gates on allowLoopback.
function isPrivateIPv4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function blockedV4(a: number, b: number, c: number, opts: IpGuardOptions): boolean {
  if (a === 127) return !opts.allowLoopback; // loopback
  return isPrivateIPv4(a, b, c);
}

/** True when the server must refuse to connect to `ip`. See the module comment for the policy. */
export function isBlockedIp(ip: string, opts: IpGuardOptions = {}): boolean {
  const family = isIP(ip.replace(/^\[|\]$/g, ''));
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
    return blockedV4(a, b, c, opts);
  }
  const g = ipv6Groups(ip);
  if (!g) return true; // not a parseable IP → refuse
  // v4-mapped (::ffff:a.b.c.d /96) and v4-compatible (::/96) carry a v4 address; :: and ::1 are special.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] === 0) return true; // :: unspecified
    if (g[5] === 0 && g[6] === 0 && g[7] === 1) return !opts.allowLoopback; // ::1 loopback
    return blockedV4(g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, opts);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, opts); // 64:ff9b::/96 NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return blockedV4(g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, opts); // 2002::/16 6to4 wraps a v4
  return false;
}
