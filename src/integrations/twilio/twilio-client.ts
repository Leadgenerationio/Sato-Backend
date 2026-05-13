import { logger } from '../../utils/logger.js';
import type { TwilioSendRequest, TwilioSendResponse } from './twilio-types.js';

/**
 * Twilio Programmable Messaging — outbound SMS only.
 *
 * Auth: HTTP Basic with `{ACCOUNT_SID}:{AUTH_TOKEN}` (base64).
 * Endpoint: POST /2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json
 * Body: application/x-www-form-urlencoded with From/To/Body fields.
 *
 * Mock mode: when any of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_FROM_NUMBER is missing, we log and return a mock id. The
 * alert-sms.service worker additionally hard-no-ops in mock mode so the
 * notifications backlog is preserved until real creds land.
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export function isTwilioConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

export async function sendSms(req: TwilioSendRequest): Promise<TwilioSendResponse> {
  if (!isTwilioConfigured()) {
    logger.info(
      { to: req.to, bodyPreview: req.body.slice(0, 80) },
      'Twilio MOCK — no TWILIO_* env configured, logging instead of sending',
    );
    return { id: `mock-${Date.now()}` };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_FROM_NUMBER!;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

  const form = new URLSearchParams({ From: from, To: req.to, Body: req.body });

  const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, to: req.to }, 'Twilio send failed');
    throw new Error(`Twilio send failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { sid: string };
  logger.info({ to: req.to, twilioSid: data.sid }, 'Twilio SMS sent');
  return { id: data.sid };
}
