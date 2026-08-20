import crypto from 'node:crypto';

// Resend signs webhooks with Svix. The signed payload is
//   `${svix-id}.${svix-timestamp}.${rawBody}`
// HMAC-SHA256'd with the base64 secret that follows the `whsec_` prefix, and
// the result is base64. `svix-signature` carries a space-separated list of
// `v1,<sig>` entries (Svix sends more than one during secret rotation), so we
// accept the event if ANY entry matches.
const TOLERANCE_SECONDS = 5 * 60;

export function verifyResendSignature(args: {
  rawBody: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  secret: string;
  nowSeconds?: number;
}): boolean {
  const { rawBody, svixId, svixTimestamp, svixSignature, secret } = args;
  if (!rawBody || !svixId || !svixTimestamp || !svixSignature || !secret) return false;

  // Replay guard — reject timestamps outside the tolerance window.
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');

  const expectedBuf = Buffer.from(expected);
  return svixSignature
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .some((part) => {
      const provided = Buffer.from(part.slice(3));
      // Length check first — timingSafeEqual throws on a length mismatch.
      if (provided.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(provided, expectedBuf);
    });
}
