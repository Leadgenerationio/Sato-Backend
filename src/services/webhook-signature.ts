import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Outbound webhook signing (plan phase 4).
//
//   X-Stato-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
//
// The timestamp is part of the signed string so a captured request can't be
// replayed later: receivers reject anything older than a few minutes.
// `verifyStatoSignature` below is the reference verifier — receivers can copy
// it as-is (it only uses node:crypto).

export const SIGNATURE_HEADER = 'X-Stato-Signature';
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function buildSignatureHeader(secret: string, rawBody: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${computeSignature(secret, t, rawBody)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Reference verifier for receivers. `rawBody` must be the exact bytes received
 * (verify BEFORE JSON.parse). Several `v1=` entries are accepted so a secret
 * can be rotated without downtime.
 */
export function verifyStatoSignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = new Date() }: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: 'malformed' };
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v);
  if (!Number.isInteger(t) || sigs.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) return { ok: false, reason: 'expired' };
  const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
  const match = sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}
