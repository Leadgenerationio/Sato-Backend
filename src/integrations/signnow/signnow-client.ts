import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type {
  CreateEnvelopeInput,
  EnvelopeResult,
  EnvelopeStatus,
  SignNowToken,
} from './signnow-types.js';

/**
 * SignNow REST client (replaces DocuSign).
 *
 * Auth: OAuth2 password grant. The endpoint at `/oauth2/token` is the only
 * one that takes Basic auth (client_id:client_secret); every other call uses
 * `Bearer <access_token>`.
 *
 * Docs: https://docs.signnow.com/docs/signnow/welcome
 */

let cachedToken: SignNowToken | null = null;

export const __testing = {
  resetTokenCache() {
    cachedToken = null;
  },
};

function baseUrl(): string {
  return (process.env.SIGNNOW_BASE_URL || 'https://api-eval.signnow.com').replace(/\/$/, '');
}

function webhookSecret(): string {
  return process.env.SIGNNOW_WEBHOOK_SECRET || '';
}

export function isSignNowConfigured(): boolean {
  return !!(
    process.env.SIGNNOW_CLIENT_ID &&
    process.env.SIGNNOW_CLIENT_SECRET &&
    process.env.SIGNNOW_USERNAME &&
    process.env.SIGNNOW_PASSWORD
  );
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  if (!isSignNowConfigured()) {
    throw new Error('SignNow credentials not configured');
  }

  const basic = Buffer.from(
    `${process.env.SIGNNOW_CLIENT_ID}:${process.env.SIGNNOW_CLIENT_SECRET}`,
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'password',
    username: process.env.SIGNNOW_USERNAME!,
    password: process.env.SIGNNOW_PASSWORD!,
    scope: '*',
  });

  const res = await fetch(`${baseUrl()}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    logger.error({ status: res.status, body: errBody }, 'SignNow token exchange failed');
    throw new Error(`SignNow auth failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, path, body }, 'SignNow request failed');
    throw new Error(`SignNow ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function mockPdfBytes(): Buffer {
  return Buffer.from('%PDF-1.4 mock signed document');
}

export async function createEnvelope(input: CreateEnvelopeInput): Promise<EnvelopeResult> {
  if (!isSignNowConfigured()) {
    logger.warn({ signerEmail: input.signerEmail }, 'SignNow MOCK — not configured');
    const id = `mock-${Date.now()}`;
    return { envelopeId: id, status: 'sent', uri: `mock://document/${id}` };
  }

  // Step 1: upload the PDF to SignNow
  const token = await getAccessToken();
  const form = new FormData();
  const pdfBytes = Buffer.from(input.documentBase64, 'base64');
  form.append('file', new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }), input.documentName);

  const uploadRes = await fetch(`${baseUrl()}/document`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    logger.error({ status: uploadRes.status, body }, 'SignNow document upload failed');
    throw new Error(`SignNow upload failed: ${uploadRes.status}`);
  }

  const { id: documentId } = (await uploadRes.json()) as { id: string };

  // Step 2: send a free-form invite. Free-form lets the signer place their
  // signature anywhere on the document (no pre-defined fields required).
  // Reference: docs.signnow.com → Invite to sign → Free-form invite.
  //
  // Note: `subject` + `message` personalization is gated behind a paid plan
  // (SignNow error 65582 on free/trial accounts). Only include them when an
  // explicit `emailSubject` / `emailBody` is passed by the caller. On trial
  // plans, SignNow's default subject/message will be used.
  const inviteBody: Record<string, unknown> = {
    from: process.env.SIGNNOW_USERNAME,
    to: input.signerEmail,
  };
  if (input.emailSubject) inviteBody.subject = input.emailSubject;
  if (input.emailBody) inviteBody.message = input.emailBody;

  await authedJson<{ status: string }>(`/document/${documentId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inviteBody),
  });

  logger.info({ documentId, signerEmail: input.signerEmail }, 'SignNow envelope sent');
  return {
    envelopeId: documentId,
    status: 'sent',
    uri: `${baseUrl()}/document/${documentId}`,
  };
}

export async function getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
  if (!isSignNowConfigured() || envelopeId.startsWith('mock-')) {
    return 'sent';
  }

  const data = await authedJson<{
    field_invites?: Array<{ status: string }>;
    requests?: Array<{ signature_id?: string | null; canceled?: unknown }>;
  }>(`/document/${envelopeId}`);

  // Free-form invites (POST /document/{id}/invite with `to: "<email>"`) report
  // their signed state via the top-level `requests` array — not `field_invites`.
  // Each request gets a `signature_id` when the signer signs, and `canceled`
  // gets populated if they decline. Check `requests` first; fall back to
  // `field_invites` for role-based invites.
  const requests = data.requests ?? [];
  if (requests.length > 0) {
    if (requests.some((r) => r.canceled != null)) return 'declined';
    if (requests.every((r) => !!r.signature_id)) return 'completed';
    return 'sent';
  }

  const invites = data.field_invites ?? [];
  if (invites.length === 0) return 'created';
  if (invites.every((i) => i.status === 'fulfilled')) return 'completed';
  if (invites.some((i) => i.status === 'declined')) return 'declined';
  return 'sent';
}

export async function downloadSignedPdf(envelopeId: string): Promise<Buffer> {
  if (!isSignNowConfigured() || envelopeId.startsWith('mock-')) {
    return mockPdfBytes();
  }

  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}/document/${envelopeId}/download?type=collapsed`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, envelopeId, body }, 'SignNow download failed');
    throw new Error(`SignNow download failed: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verify an incoming webhook. SignNow signs the **raw body bytes** with
 * HMAC-SHA256 using the secret you set when creating the webhook subscription.
 * The signature arrives in the `X-SignNow-Signature` header.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = webhookSecret();
  if (!secret || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
