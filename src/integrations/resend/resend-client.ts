import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { ResendSendRequest, ResendSendResponse } from './resend-types.js';

const RESEND_API = 'https://api.resend.com';

export function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function getApiKey(): string {
  return process.env.RESEND_API_KEY || '';
}

export async function sendEmail(req: ResendSendRequest): Promise<ResendSendResponse> {
  const from = `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`;

  if (!isResendConfigured()) {
    logger.info(
      { to: req.to, subject: req.subject, from },
      'Resend MOCK — no RESEND_API_KEY configured, logging instead of sending',
    );
    return { id: `mock-${Date.now()}` };
  }

  const res = await fetch(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(req.to) ? req.to : [req.to],
      subject: req.subject,
      html: req.html,
      text: req.text,
      reply_to: req.replyTo,
      cc: req.cc,
      bcc: req.bcc,
      tags: req.tags,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Resend send failed');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as ResendSendResponse;
  logger.info({ id: data.id, to: req.to, subject: req.subject }, 'Email sent');
  return data;
}
