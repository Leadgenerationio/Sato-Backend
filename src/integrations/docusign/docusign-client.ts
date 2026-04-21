import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateEnvelopeInput,
  EnvelopeResult,
  EnvelopeStatus,
  DocuSignJwtToken,
} from './docusign-types.js';

let cachedToken: DocuSignJwtToken | null = null;

export function isDocuSignConfigured(): boolean {
  return !!(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
    process.env.DOCUSIGN_SECRET &&
    process.env.DOCUSIGN_USER_ID &&
    process.env.DOCUSIGN_ACCOUNT_ID
  );
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  if (!isDocuSignConfigured()) {
    throw new Error('DocuSign credentials not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.DOCUSIGN_INTEGRATION_KEY,
    sub: env.DOCUSIGN_USER_ID,
    aud: env.DOCUSIGN_OAUTH_BASE,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  };

  const assertion = jwt.sign(payload, env.DOCUSIGN_SECRET, { algorithm: 'RS256' });

  const res = await fetch(`https://${env.DOCUSIGN_OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'DocuSign JWT grant failed');
    throw new Error(`DocuSign auth failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

export async function createEnvelope(input: CreateEnvelopeInput): Promise<EnvelopeResult> {
  if (!isDocuSignConfigured()) {
    logger.warn({ signerEmail: input.signerEmail }, 'DocuSign MOCK — not configured');
    return {
      envelopeId: `mock-${Date.now()}`,
      status: 'sent',
      uri: `mock://envelope/${Date.now()}`,
    };
  }

  const token = await getAccessToken();
  const body = {
    emailSubject: input.emailSubject || `Please sign: ${input.documentName}`,
    emailBlurb: input.emailBody || 'Your service agreement is ready for signature.',
    status: 'sent',
    documents: [
      {
        documentBase64: input.documentBase64,
        name: input.documentName,
        fileExtension: 'pdf',
        documentId: '1',
      },
    ],
    recipients: {
      signers: [
        {
          email: input.signerEmail,
          name: input.signerName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              { documentId: '1', pageNumber: '1', xPosition: '100', yPosition: '150' },
            ],
          },
        },
      ],
    },
  };

  const res = await fetch(
    `${env.DOCUSIGN_BASE_PATH}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    logger.error({ status: res.status, err }, 'DocuSign envelope create failed');
    throw new Error(`DocuSign create failed: ${res.status}`);
  }

  const data = (await res.json()) as { envelopeId: string; status: EnvelopeStatus; uri: string };
  logger.info({ envelopeId: data.envelopeId, signerEmail: input.signerEmail }, 'DocuSign envelope sent');
  return data;
}

export async function getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
  if (!isDocuSignConfigured() || envelopeId.startsWith('mock-')) {
    return 'sent';
  }

  const token = await getAccessToken();
  const res = await fetch(
    `${env.DOCUSIGN_BASE_PATH}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) throw new Error(`DocuSign status fetch failed: ${res.status}`);
  const data = (await res.json()) as { status: EnvelopeStatus };
  return data.status;
}

export async function downloadSignedPdf(envelopeId: string): Promise<Buffer> {
  if (!isDocuSignConfigured() || envelopeId.startsWith('mock-')) {
    return Buffer.from('%PDF-1.4 mock signed document');
  }

  const token = await getAccessToken();
  const res = await fetch(
    `${env.DOCUSIGN_BASE_PATH}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) throw new Error(`DocuSign PDF download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
