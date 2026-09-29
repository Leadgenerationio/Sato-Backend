import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildSignatureHeader, computeSignature, generateWebhookSecret, verifyStatoSignature,
} from '../services/webhook-signature.js';
import { openSecret, sealSecret } from '../utils/secret-box.js';

// Plan phase 4: X-Stato-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>

const secret = 'whsec_test_secret';
const body = JSON.stringify({ id: 'd1', event: 'creative.added', data: { creative: { id: 'c1' } } });
const at = new Date('2026-09-29T12:00:00Z');
const t = Math.floor(at.getTime() / 1000);

describe('webhook signature', () => {
  it('matches an independent HMAC-SHA256 over "<t>.<body>"', () => {
    const independent = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(computeSignature(secret, t, body)).toBe(independent);
    expect(buildSignatureHeader(secret, body, at)).toBe(`t=${t},v1=${independent}`);
  });

  it('the reference verifier accepts a genuine header', () => {
    const header = buildSignatureHeader(secret, body, at);
    expect(verifyStatoSignature(header, body, secret, { now: at })).toEqual({ ok: true });
  });

  it('rejects a changed body, a wrong secret and a missing/garbled header', () => {
    const header = buildSignatureHeader(secret, body, at);
    expect(verifyStatoSignature(header, body.replace('c1', 'c2'), secret, { now: at })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyStatoSignature(header, body, 'whsec_other', { now: at })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyStatoSignature(undefined, body, secret, { now: at })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStatoSignature('v1=abc', body, secret, { now: at })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a replay outside the 5-minute window', () => {
    const header = buildSignatureHeader(secret, body, at);
    const later = new Date(at.getTime() + 6 * 60_000);
    expect(verifyStatoSignature(header, body, secret, { now: later })).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts any of several v1 entries (secret rotation)', () => {
    const good = computeSignature(secret, t, body);
    expect(verifyStatoSignature(`t=${t},v1=${'0'.repeat(64)},v1=${good}`, body, secret, { now: at })).toEqual({ ok: true });
  });

  it('generates distinct, prefixed secrets', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe('secret box (signing secret encrypted at rest)', () => {
  it('round-trips and never stores the plain secret', () => {
    const sealed = sealSecret('whsec_abc123');
    expect(sealed).not.toContain('whsec_abc123');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(openSecret(sealed)).toBe('whsec_abc123');
  });

  it('refuses a tampered ciphertext', () => {
    const [v, iv, tag, ct] = sealSecret('whsec_abc123').split(':');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => openSecret([v, iv, tag, flipped.toString('base64url')].join(':'))).toThrow();
  });
});
