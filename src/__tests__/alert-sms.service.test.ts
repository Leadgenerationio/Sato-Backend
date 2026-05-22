import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { notifications } from '../db/schema/notifications.js';
import * as twilioClient from '../integrations/twilio/twilio-client.js';
import { logger } from '../utils/logger.js';

// Import the unit under test LAST so the env-var beforeEach below runs
// before any module-load-time env reads.
import { pollOnce } from '../services/alert-sms.service.js';

const TEST_PHONE = '+447776531268';
const ATTEMPTS_CAP = 5;

async function insertSystemError(title: string, message: string): Promise<string> {
  const [row] = await db.insert(notifications).values({
    type: 'system_error',
    severity: 'warning',
    title,
    message,
  }).returning({ id: notifications.id });
  return row.id;
}

async function deleteById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(notifications).where(inArray(notifications.id, ids));
}

/**
 * Neutralise any pre-existing unsent system_error rows in the dev DB so that
 * each test starts with exactly the rows it inserts. We temporarily cap their
 * smsAttempts so the service query skips them; restored in afterEach.
 */
async function neutralisePreExisting(): Promise<string[]> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(
      eq(notifications.type, 'system_error'),
      isNull(notifications.smsNotifiedAt),
      lt(notifications.smsAttempts, ATTEMPTS_CAP),
    ));
  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    await db
      .update(notifications)
      .set({ smsAttempts: ATTEMPTS_CAP })
      .where(inArray(notifications.id, ids));
  }
  return ids;
}

async function restorePreExisting(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(notifications)
    .set({ smsAttempts: 0 })
    .where(inArray(notifications.id, ids));
}

describe('alert-sms.service — single-row happy path', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    // Live mode — both creds AND phone set.
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    process.env.OPS_ALERT_PHONE = TEST_PHONE;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('sends one SMS containing title + message and marks row notified', async () => {
    const sendSpy = vi.spyOn(twilioClient, 'sendSms').mockResolvedValue({ id: 'SM_test' });

    const id = await insertSystemError(
      'Credit check failed — Acme Ltd',
      'Endole credit_checks failed: 403 — provider balance exhausted',
    );
    createdIds.push(id);

    const result = await pollOnce();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0].to).toBe(TEST_PHONE);
    expect(sendSpy.mock.calls[0][0].body).toContain('Credit check failed — Acme Ltd');
    expect(sendSpy.mock.calls[0][0].body).toContain('provider balance exhausted');

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.smsNotifiedAt).toBeInstanceOf(Date);
    expect(row.smsAttempts).toBe(1);
  });
});

describe('alert-sms.service — coalesce multiple rows', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    process.env.OPS_ALERT_PHONE = TEST_PHONE;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('sends ONE summary SMS for 3 rows and marks all 3 notified', async () => {
    const sendSpy = vi.spyOn(twilioClient, 'sendSms').mockResolvedValue({ id: 'SM_test' });

    const id1 = await insertSystemError('Endole failed', 'msg1');
    const id2 = await insertSystemError('Xero failed', 'msg2');
    const id3 = await insertSystemError('Resend failed', 'msg3');
    createdIds.push(id1, id2, id3);

    const result = await pollOnce();

    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Summary format: "[Stato] 3 system errors. Most recent: <title>"
    expect(sendSpy.mock.calls[0][0].body).toMatch(/\[Stato\] 3 system errors/);
    // "Most recent" = the one with the latest createdAt — that's the last
    // one inserted because the ORDER BY is asc.
    expect(sendSpy.mock.calls[0][0].body).toContain('Resend failed');

    const rows = await db.select().from(notifications).where(inArray(notifications.id, [id1, id2, id3]));
    expect(rows.every(r => r.smsNotifiedAt instanceof Date)).toBe(true);
    expect(rows.every(r => r.smsAttempts === 1)).toBe(true);
  });
});

describe('alert-sms.service — Twilio failure', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    process.env.OPS_ALERT_PHONE = TEST_PHONE;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('on sendSms throw: bumps sms_attempts, leaves sms_notified_at null', async () => {
    vi.spyOn(twilioClient, 'sendSms').mockRejectedValue(new Error('Twilio send failed: 500 boom'));

    const id = await insertSystemError('Endole 500', 'msg');
    createdIds.push(id);

    const result = await pollOnce();

    expect(result).toEqual({ sent: 0, failed: 1 });

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.smsNotifiedAt).toBeNull();
    expect(row.smsAttempts).toBe(1);
  });
});

describe('alert-sms.service — 5-attempt cap', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    process.env.OPS_ALERT_PHONE = TEST_PHONE;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('skips rows where sms_attempts >= 5', async () => {
    const sendSpy = vi.spyOn(twilioClient, 'sendSms').mockResolvedValue({ id: 'SM_test' });

    const id = await insertSystemError('Permafail', 'msg');
    createdIds.push(id);
    await db.update(notifications)
      .set({ smsAttempts: 5 })
      .where(eq(notifications.id, id));

    const result = await pollOnce();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('alert-sms.service — backlog preservation: no OPS_ALERT_PHONE', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    // Twilio creds present but OPS_ALERT_PHONE deliberately absent.
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM_NUMBER = '+15551234567';
    delete process.env.OPS_ALERT_PHONE;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('returns 0/0 without DB touch when OPS_ALERT_PHONE is missing', async () => {
    const sendSpy = vi.spyOn(twilioClient, 'sendSms').mockResolvedValue({ id: 'SM_test' });

    const id = await insertSystemError('Pending alert', 'msg');
    createdIds.push(id);

    const result = await pollOnce();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendSpy).not.toHaveBeenCalled();

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.smsNotifiedAt).toBeNull();
    expect(row.smsAttempts).toBe(0);
  });
});

describe('alert-sms.service — backlog preservation: no Twilio creds', () => {
  const originalEnv = { ...process.env };
  let createdIds: string[] = [];
  let neutralisedIds: string[] = [];

  beforeEach(async () => {
    // OPS_ALERT_PHONE set but all 3 Twilio env vars absent.
    process.env.OPS_ALERT_PHONE = TEST_PHONE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    createdIds = [];
    neutralisedIds = await neutralisePreExisting();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await deleteById(createdIds);
    await restorePreExisting(neutralisedIds);
  });

  it('returns 0/0 without DB touch when Twilio creds are missing (backlog preserved)', async () => {
    const sendSpy = vi.spyOn(twilioClient, 'sendSms');

    const id = await insertSystemError('Pending alert', 'msg');
    createdIds.push(id);

    const result = await pollOnce();

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendSpy).not.toHaveBeenCalled();

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row.smsNotifiedAt).toBeNull();
    expect(row.smsAttempts).toBe(0);
  });

  it('logs a visible mock-mode deferral line so operators see why nothing was sent', async () => {
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    const id = await insertSystemError('Pending alert', 'msg');
    createdIds.push(id);

    await pollOnce();

    const calls = logSpy.mock.calls.map((args) =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
    expect(calls.some((line) => line.includes('[twilio][mock] alerts deferred'))).toBe(true);
  });
});
