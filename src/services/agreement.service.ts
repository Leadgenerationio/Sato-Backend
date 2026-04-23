import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agreements } from '../db/schema/agreements.js';
import { clients } from '../db/schema/clients.js';
import { createEnvelope, downloadSignedPdf, getEnvelopeStatus } from '../integrations/signnow/signnow-client.js';
import { uploadFile } from '../integrations/r2/r2-client.js';
import { notify } from './notification.service.js';
import { logger } from '../utils/logger.js';
import type { EnvelopeStatus, SignNowWebhookEvent } from '../integrations/signnow/signnow-types.js';

export interface SendAgreementInput {
  clientId: string;
  signerEmail: string;
  signerName: string;
  documentBase64: string;
  documentName?: string;
}

/**
 * Create an agreement row and dispatch a signing envelope via SignNow.
 */
export async function sendAgreement(input: SendAgreementInput) {
  const envelope = await createEnvelope({
    signerEmail: input.signerEmail,
    signerName: input.signerName,
    documentName: input.documentName || 'Service Agreement.pdf',
    documentBase64: input.documentBase64,
  });

  const [row] = await db
    .insert(agreements)
    .values({
      clientId: input.clientId,
      providerEnvelopeId: envelope.envelopeId,
      signerEmail: input.signerEmail,
      signerName: input.signerName,
      status: 'sent',
      sentAt: new Date(),
    })
    .returning();

  logger.info({ agreementId: row.id, envelopeId: envelope.envelopeId }, 'Agreement sent');
  return row;
}

/**
 * Handle a SignNow webhook event.
 * Updates the agreement row. On `document.complete` downloads the signed PDF
 * and archives it to R2.
 */
export async function handleSignNowWebhook(event: SignNowWebhookEvent) {
  const envelopeId = event.meta?.document_id || event.meta?.id;
  if (!envelopeId) {
    logger.warn({ event }, 'SignNow webhook missing document id — ignoring');
    return;
  }

  const [existing] = await db
    .select()
    .from(agreements)
    .where(eq(agreements.providerEnvelopeId, envelopeId));

  if (!existing) {
    logger.warn({ envelopeId }, 'SignNow webhook for unknown envelope — ignoring');
    return;
  }

  // SignNow reports status via event_type rather than a flat status field.
  // Translate to our generic EnvelopeStatus enum.
  let status: EnvelopeStatus;
  if (event.event_type === 'document.complete') {
    status = 'completed';
  } else if (event.event_type === 'document.update' || event.event_type === 'invite.update') {
    // A status update that isn't completion — could be decline or mid-flow.
    // Fall back to a live status poll for accuracy.
    status = await getEnvelopeStatus(envelopeId);
  } else {
    // create/delete/invite.create events — nothing to do.
    return;
  }

  const patch: Record<string, unknown> = { status, updatedAt: new Date() };

  if (status === 'declined') {
    patch.declinedAt = new Date();
    patch.declinedReason = 'Declined by signer';
  }

  if (status === 'completed' || status === 'signed') {
    patch.signedAt = new Date();
    patch.signedByClient = true;

    // Download and archive signed PDF to R2
    try {
      const pdf = await downloadSignedPdf(envelopeId);
      const r2 = await uploadFile({
        folder: 'agreements',
        key: `${existing.clientId}/${envelopeId}.pdf`,
        body: pdf,
        contentType: 'application/pdf',
        cacheControl: 'private, max-age=86400',
      });
      patch.pdfR2Key = r2.key;
      patch.documentUrl = r2.publicUrl;
    } catch (err) {
      logger.error({ err, envelopeId }, 'Failed to archive signed PDF to R2 — will retry');
    }

    // Lookup client for notification
    const [client] = await db.select().from(clients).where(eq(clients.id, existing.clientId));
    if (client) {
      await notify.agreementSigned({
        clientName: client.companyName,
        signedAt: new Date().toISOString(),
        agreementUrl: `/clients/${client.id}?tab=agreements`,
        emailTo: client.contactEmail ?? undefined,
      });
    }
  }

  await db.update(agreements).set(patch).where(eq(agreements.id, existing.id));
  logger.info({ agreementId: existing.id, status }, 'Agreement status updated');
}

export async function listAgreementsForClient(clientId: string) {
  return db.select().from(agreements).where(eq(agreements.clientId, clientId));
}

export async function listAllAgreements() {
  return db.select().from(agreements);
}

export async function getAgreement(id: string) {
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  return row ?? null;
}

export async function refreshAgreementStatus(id: string) {
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  if (!row) return null;
  if (!row.providerEnvelopeId) return row;

  const current = await getEnvelopeStatus(row.providerEnvelopeId);
  if (current === row.status) return row;

  const patch: Record<string, unknown> = { status: current, updatedAt: new Date() };
  if ((current === 'completed' || current === 'signed') && !row.signedAt) {
    patch.signedAt = new Date();
    patch.signedByClient = true;
  }
  if (current === 'declined' && !row.declinedAt) {
    patch.declinedAt = new Date();
  }

  const [updated] = await db.update(agreements).set(patch).where(eq(agreements.id, id)).returning();
  return updated;
}
