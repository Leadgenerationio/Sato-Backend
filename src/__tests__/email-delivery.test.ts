import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import app from '../index.js';
import { db } from '../config/database.js';
import { emailDeliveries } from '../db/schema/index.js';
import * as svc from '../services/email-delivery.service.js';

// Sam (2026-08-20): Barry @ media-active.org.uk "never received his welcome
// email" while Resend reported success twice. These tests pin the ledger that
// makes accepted-vs-delivered distinguishable.

const addr = `barry-test-${Date.now()}@media-active.org.uk`;

describe('email delivery ledger', () => {
  let msgId: string;

  beforeAll(async () => {
    msgId = `test-msg-${Date.now()}`;
    await svc.recordSend({
      messageId: msgId,
      toAddress: addr.toUpperCase(), // must normalise
      subject: 'Welcome to your leadgeneration.io client portal',
      kind: 'portal_welcome',
      fromAddress: 'leadgeneration.io <noreply@leadform.io>',
    });
  });

  it('records an accepted send as "sent", not as delivered', async () => {
    const row = await svc.getLatestForEmail(addr);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('sent');
    expect(row!.kind).toBe('portal_welcome');
  });

  it('normalises the recipient so lookups are case-insensitive', async () => {
    expect(await svc.getLatestForEmail(addr.toUpperCase())).not.toBeNull();
  });

  it('is idempotent — a duplicate message id does not create a second row', async () => {
    await svc.recordSend({ messageId: msgId, toAddress: addr });
    const rows = await db.select().from(emailDeliveries).where(eq(emailDeliveries.messageId, msgId));
    expect(rows).toHaveLength(1);
  });

  it('advances to delivered when the webhook confirms it', async () => {
    const r = await svc.applyEvent({ type: 'email.delivered', data: { email_id: msgId } });
    expect(r.applied).toBe(true);
    expect((await svc.getLatestForEmail(addr))!.status).toBe('delivered');
  });

  it('ignores a replayed lower-ranked event instead of downgrading the record', async () => {
    const r = await svc.applyEvent({ type: 'email.sent', data: { email_id: msgId } });
    expect(r.applied).toBe(false);
    expect((await svc.getLatestForEmail(addr))!.status).toBe('delivered');
  });

  it('records a bounce with its reason even after a delivered event', async () => {
    const r = await svc.applyEvent({
      type: 'email.bounced',
      data: { email_id: msgId, bounce: { type: 'Permanent', message: 'mailbox unavailable' } },
    });
    expect(r.applied).toBe(true);
    const row = (await svc.getLatestForEmail(addr))!;
    expect(row.status).toBe('bounced');
    expect(row.failureType).toBe('Permanent');
    expect(row.failureReason).toBe('mailbox unavailable');
  });

  it('ignores events for a message id we never recorded', async () => {
    const r = await svc.applyEvent({ type: 'email.delivered', data: { email_id: 'never-seen' } });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unknown message id');
  });

  it('ignores an unhandled event type and a payload with no email_id', async () => {
    expect((await svc.applyEvent({ type: 'contact.created', data: { email_id: msgId } })).applied).toBe(false);
    expect((await svc.applyEvent({ type: 'email.delivered', data: {} })).applied).toBe(false);
  });
});

describe('POST /api/v1/webhooks/resend', () => {
  it('is reachable without auth (Resend has no bearer token)', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/resend')
      .send({ type: 'email.delivered', data: { email_id: 'unknown-id' } });
    expect(res.status).toBe(200);
  });

  it('rejects a bad signature when a secret is configured', async () => {
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('k').toString('base64');
    try {
      const res = await request(app)
        .post('/api/v1/webhooks/resend')
        .set('svix-id', 'msg_1')
        .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
        .set('svix-signature', 'v1,YmFk')
        .send({ type: 'email.delivered', data: { email_id: 'x' } });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.RESEND_WEBHOOK_SECRET;
    }
  });
});
