import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyResendSignature } from '../integrations/resend/resend-webhook.js';
import { mapEvent, rankOf } from '../services/email-delivery.service.js';

const SECRET = 'whsec_' + Buffer.from('barry-media-active-test-key').toString('base64');

function sign(rawBody: string, id: string, ts: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

describe('verifyResendSignature', () => {
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'abc' } });
  const id = 'msg_2abc';
  const now = 1_787_203_445;
  const ts = String(now);

  it('accepts a correctly signed payload', () => {
    expect(verifyResendSignature({
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: sign(body, id, ts), secret: SECRET, nowSeconds: now,
    })).toBe(true);
  });

  it('rejects a tampered body — the whole point of signing', () => {
    expect(verifyResendSignature({
      rawBody: body.replace('bounced', 'delivered'),
      svixId: id, svixTimestamp: ts,
      svixSignature: sign(body, id, ts), secret: SECRET, nowSeconds: now,
    })).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const other = 'whsec_' + Buffer.from('wrong-key').toString('base64');
    expect(verifyResendSignature({
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: sign(body, id, ts, other), secret: SECRET, nowSeconds: now,
    })).toBe(false);
  });

  it('rejects a replayed event outside the tolerance window', () => {
    expect(verifyResendSignature({
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: sign(body, id, ts), secret: SECRET,
      nowSeconds: now + 6 * 60,
    })).toBe(false);
  });

  it('accepts when one of several rotated v1 signatures matches', () => {
    const bogus = 'v1,' + Buffer.from('nope').toString('base64');
    expect(verifyResendSignature({
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: `${bogus} ${sign(body, id, ts)}`,
      secret: SECRET, nowSeconds: now,
    })).toBe(true);
  });

  it('rejects when headers or secret are missing rather than defaulting open', () => {
    const base = {
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: sign(body, id, ts), secret: SECRET, nowSeconds: now,
    };
    expect(verifyResendSignature({ ...base, svixId: '' })).toBe(false);
    expect(verifyResendSignature({ ...base, svixSignature: '' })).toBe(false);
    expect(verifyResendSignature({ ...base, secret: '' })).toBe(false);
    expect(verifyResendSignature({ ...base, svixTimestamp: 'not-a-number' })).toBe(false);
  });

  it('does not throw on a signature of a different length', () => {
    expect(() => verifyResendSignature({
      rawBody: body, svixId: id, svixTimestamp: ts,
      svixSignature: 'v1,short', secret: SECRET, nowSeconds: now,
    })).not.toThrow();
  });
});

describe('event ranking', () => {
  it('ranks failures above every engagement state so a bounce is never masked', () => {
    expect(mapEvent('email.bounced')!.rank).toBeGreaterThan(mapEvent('email.clicked')!.rank);
    expect(mapEvent('email.complained')!.rank).toBeGreaterThan(mapEvent('email.delivered')!.rank);
  });

  it('ranks delivered above sent, so a replayed sent cannot downgrade it', () => {
    expect(mapEvent('email.delivered')!.rank).toBeGreaterThan(mapEvent('email.sent')!.rank);
    expect(rankOf('delivered')).toBeGreaterThan(rankOf('sent'));
  });

  it('returns null for event types we do not handle', () => {
    expect(mapEvent('email.unknown_future_event')).toBeNull();
    expect(mapEvent('')).toBeNull();
  });

  it('rankOf returns 0 for an unknown status so any real event wins', () => {
    expect(rankOf('nonsense')).toBe(0);
  });
});
