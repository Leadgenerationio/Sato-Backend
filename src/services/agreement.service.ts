import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agreements } from '../db/schema/agreements.js';
import { clients } from '../db/schema/clients.js';
import { createEnvelope, downloadSignedPdf, getEnvelopeStatus } from '../integrations/signnow/signnow-client.js';
import { uploadFile, downloadFile } from '../integrations/r2/r2-client.js';
import type { R2Folder } from '../integrations/r2/r2-types.js';
import { createContact as createXeroContact, isXeroConfigured } from '../integrations/xero/xero-client.js';
import { notify } from './notification.service.js';
import { logClientActivity } from './client-activity.service.js';
import { logger } from '../utils/logger.js';
import { ForbiddenError } from '../utils/errors.js';
import type { EnvelopeStatus, SignNowWebhookEvent } from '../integrations/signnow/signnow-types.js';
import type { AuthPayload } from '../types/index.js';
import { previewTemplate, getTemplate } from './agreement-template.service.js';

/**
 * When an agreement is signed, ensure the client has a Xero contact so they're
 * ready for invoicing without manual data entry. Idempotent — skips if the
 * client already has a `xeroContactId`. Fire-and-forget — never blocks the
 * signing flow.
 */
async function ensureXeroContact(clientId: string): Promise<void> {
  if (!isXeroConfigured()) {
    logger.info({ clientId }, 'Skipping Xero contact create — not configured');
    return;
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return;
  if (client.xeroContactId) {
    logger.info({ clientId, xeroContactId: client.xeroContactId }, 'Client already linked to Xero — skipping');
    return;
  }

  try {
    const contact = await createXeroContact({
      name: client.companyName,
      contactName: client.contactName,
      email: client.contactEmail,
      phone: client.contactPhone,
      address: client.address,
    });
    await db
      .update(clients)
      .set({ xeroContactId: contact.contactId, updatedAt: new Date() })
      .where(eq(clients.id, clientId));
    logger.info({ clientId, xeroContactId: contact.contactId }, 'Xero contact auto-created on agreement signed');
  } catch (err) {
    logger.error({ err, clientId }, 'Auto Xero contact creation failed — admin can create manually');
  }
}

// #47-50 PDF editor — drag-placed field shape carried from the editor UI
// into createEnvelope. Identical wire shape as the persisted column.
export interface SendAgreementField {
  page: number;
  type: 'signature' | 'date_signed' | 'text';
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  prefillValue?: string;
}

export interface SendAgreementInput {
  clientId: string;
  signerEmail: string;
  signerName: string;
  /**
   * Sam Loom #68 — signatory title/role (e.g. "Director", "CEO", "Compliance
   * Officer"). Free text up to 100 chars. Distinct from SignNow's internal
   * workflow role — this is the legal capacity the person signs in.
   * Optional for back-compat with existing dialogs/callers.
   */
  signerRole?: string;
  /** Inline base64-encoded PDF bytes. Capped at the API body limit (~10 MB). */
  documentBase64?: string;
  /**
   * R2 key (relative to the `misc` folder by default) of a previously-uploaded
   * PDF. Bypasses the API body limit — frontend uploads via signed URL first,
   * then passes the key here. Either this OR documentBase64 must be set.
   */
  r2SourceKey?: string;
  /** Folder the r2SourceKey lives under. Defaults to 'misc' (FileUpload default). */
  /** Derived from the canonical R2Folder type so adding a folder in
   *  r2-types.ts auto-propagates here without a manual edit. */
  r2SourceFolder?: R2Folder;
  documentName?: string;
  /**
   * #47-50 PDF editor — drag-placed fields from the editor UI. When
   * provided (non-empty), the SignNow invite goes out role-based with
   * pre-placed signature/date/text boxes. When omitted or empty, the
   * legacy free-form invite is used.
   */
  fields?: SendAgreementField[];
  /** P12 — optional template to auto-populate before sending. */
  templateId?: string;
  /** P12 — per-field overrides (variable key → value) that win over resolved values. */
  overrides?: Record<string, string>;
  /** P12 — agreement effective date (ISO string) for the `agreement.effectiveDate` variable. */
  effectiveDate?: string;
}

/**
 * Create an agreement row and dispatch a signing envelope via SignNow.
 *
 * Two ways to supply the document:
 *   1. documentBase64  — for small PDFs (<10 MB), inline in the request.
 *   2. r2SourceKey     — for any size, frontend pre-uploads via signed URL.
 */
export async function sendAgreement(input: SendAgreementInput, requester?: AuthPayload) {
  // P12 — if a templateId is provided, populate the template PDF with resolved
  // variable values and upload the result to R2. The resulting key replaces the
  // caller-supplied r2SourceKey for the SignNow envelope. Signature/date_signed
  // fields are taken from the template's field_layout rather than from the caller.
  let finalR2SourceKey = input.r2SourceKey;
  let finalR2SourceFolder = input.r2SourceFolder;
  let finalFields = input.fields;
  let populatedPdfR2KeyForRow: string | undefined;

  if (input.templateId && requester) {
    const populatedBytes = await previewTemplate(
      input.templateId,
      {
        clientId: input.clientId,
        overrides: input.overrides ?? {},
        effectiveDate: input.effectiveDate ?? null,
      },
      requester,
    );
    if (!populatedBytes) {
      throw new ForbiddenError('Template or client not found for this business');
    }

    // Upload populated PDF to R2 (key relative to 'agreements' folder)
    const relKey = `populated/${Date.now()}-${input.clientId}.pdf`;
    await uploadFile({
      folder: 'agreements',
      key: relKey,
      body: Buffer.from(populatedBytes),
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=86400',
    });
    // downloadFile prepends folder, so store the full key for the DB row
    populatedPdfR2KeyForRow = `agreements/${relKey}`;
    finalR2SourceKey = relKey;
    finalR2SourceFolder = 'agreements';

    // Pull signature + date_signed fields from the template field_layout
    const template = await getTemplate(input.templateId, requester);
    if (template) {
      finalFields = template.fieldLayout
        .filter((f) => f.type === 'signature' || f.type === 'date_signed')
        .map((f) => ({
          page: f.page,
          type: f.type as 'signature' | 'date_signed',
          xPct: f.xPct,
          yPct: f.yPct,
          widthPct: f.widthPct,
          heightPct: f.heightPct,
        }));
    }
  }

  let documentBase64: string;
  if (finalR2SourceKey) {
    const buf = await downloadFile(finalR2SourceFolder ?? 'misc', finalR2SourceKey);
    documentBase64 = buf.toString('base64');
  } else if (input.documentBase64) {
    documentBase64 = input.documentBase64;
  } else {
    throw new Error('sendAgreement requires either documentBase64 or r2SourceKey');
  }

  const envelope = await createEnvelope({
    signerEmail: input.signerEmail,
    signerName: input.signerName,
    documentName: input.documentName || 'Service Agreement.pdf',
    documentBase64,
    fields: finalFields && finalFields.length > 0 ? finalFields : undefined,
  });

  const [row] = await db
    .insert(agreements)
    .values({
      clientId: input.clientId,
      providerEnvelopeId: envelope.envelopeId,
      signerEmail: input.signerEmail,
      signerName: input.signerName,
      // Sam Loom #68 — signatory role/title. Empty/whitespace-only inputs
      // collapse to null so we don't store accidental blanks.
      signerRole: input.signerRole?.trim() || null,
      status: 'sent',
      sentAt: new Date(),
      // #47-50 — persist the placed fields so we can show them on the
      // detail page later ("you sent 4 fields: 1 signature + 2 text + 1 date").
      fields: finalFields && finalFields.length > 0 ? finalFields : null,
      // P12 — template linkage
      templateId: input.templateId ?? null,
      populatedPdfR2Key: populatedPdfR2KeyForRow ?? null,
      overrides: input.overrides ?? {},
    })
    .returning();

  // L #38 — surface in the per-client activity feed.
  await logClientActivity(input.clientId, null, 'agreement_sent', {
    agreementId: row.id,
    signerEmail: input.signerEmail,
    signerName: input.signerName,
    signerRole: input.signerRole ?? null,
    fieldCount: input.fields?.length ?? 0,
  });

  logger.info(
    { agreementId: row.id, envelopeId: envelope.envelopeId, fieldCount: input.fields?.length ?? 0 },
    'Agreement sent',
  );
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

    // Fire-and-forget: provision a Xero contact for this client so finance can
    // invoice them immediately. Sam asked for this in 2026-04-22 review.
    ensureXeroContact(existing.clientId).catch((err) => {
      logger.error({ err, clientId: existing.clientId }, 'ensureXeroContact failed (background)');
    });
  }

  await db.update(agreements).set(patch).where(eq(agreements.id, existing.id));
  // L #38 — emit a typed event so the timeline can highlight signed/declined.
  const activityType =
    status === 'completed' || status === 'signed' ? 'agreement_signed'
      : status === 'declined' ? 'agreement_declined'
      : 'agreement_status_changed';
  await logClientActivity(existing.clientId, null, activityType, {
    agreementId: existing.id,
    status,
  });
  logger.info({ agreementId: existing.id, status }, 'Agreement status updated');
}

export async function listAgreementsForClient(clientId: string, requester?: AuthPayload) {
  if (requester) {
    if (requester.role === 'client') {
      // A client can only ever see their own agreements.
      if (requester.clientId !== clientId) {
        throw new ForbiddenError('Cannot view agreements for a different client');
      }
    } else if (requester.businessId) {
      // Internal roles must stay within their business — fetch the client to
      // verify the businessId matches before returning agreements.
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
      if (client && client.businessId !== requester.businessId) {
        throw new ForbiddenError('Client belongs to a different business');
      }
    }
  }
  return db.select().from(agreements).where(eq(agreements.clientId, clientId));
}

export async function listAllAgreements() {
  // Yash (31-May-2026): admin /agreements page used to render the raw
  // `status`/`signedAt` from the agreements row, which made Coby Benson's
  // envelope read "Sent" even though `clients.agreementSigned=true` (the
  // admin-toggleable override Sam uses for offline signatures). Portal
  // already honours that override (see portal.service.ts getAgreement);
  // admin should too so the two surfaces don't disagree. We compute the
  // effective status here and emit it as `effectiveStatus`/`effectiveSignedAt`
  // alongside the raw fields so existing consumers that read `status`
  // unchanged still work.
  const rows = await db
    .select({
      id: agreements.id,
      clientId: agreements.clientId,
      providerEnvelopeId: agreements.providerEnvelopeId,
      documentUrl: agreements.documentUrl,
      signerName: agreements.signerName,
      signerEmail: agreements.signerEmail,
      status: agreements.status,
      sentAt: agreements.sentAt,
      signedAt: agreements.signedAt,
      signedByClient: agreements.signedByClient,
      declinedAt: agreements.declinedAt,
      createdAt: agreements.createdAt,
      updatedAt: agreements.updatedAt,
      clientAgreementSigned: clients.agreementSigned,
    })
    .from(agreements)
    .leftJoin(clients, eq(clients.id, agreements.clientId));

  return rows.map((r) => {
    const overrideActive = r.clientAgreementSigned === true;
    const rawStatus = r.status ?? 'pending';
    const rawSigned = rawStatus === 'completed' || rawStatus === 'signed' || !!r.signedAt;
    const effectiveStatus = rawSigned || overrideActive ? 'completed' : rawStatus;
    const effectiveSignedAt = r.signedAt
      ?? (overrideActive ? r.sentAt ?? r.updatedAt ?? r.createdAt : null);
    return {
      id: r.id,
      clientId: r.clientId,
      providerEnvelopeId: r.providerEnvelopeId,
      documentUrl: r.documentUrl,
      signerName: r.signerName,
      signerEmail: r.signerEmail,
      status: effectiveStatus,
      rawStatus,
      sentAt: r.sentAt,
      signedAt: effectiveSignedAt,
      signedByClient: r.signedByClient,
      declinedAt: r.declinedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function getAgreement(id: string, requester?: AuthPayload) {
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id));
  if (!row) return null;
  if (requester) {
    if (requester.role === 'client') {
      if (row.clientId !== requester.clientId) {
        throw new ForbiddenError('Cannot view another client\'s agreement');
      }
    } else if (requester.businessId) {
      const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId));
      if (client && client.businessId !== requester.businessId) {
        throw new ForbiddenError('Agreement belongs to a different business');
      }
    }
  }
  return row;
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

  // If we just transitioned to signed/completed via the polling path (not
  // webhook), still provision the Xero contact. Idempotent — no-op if already
  // linked.
  if ((current === 'completed' || current === 'signed') && !row.signedAt) {
    ensureXeroContact(row.clientId).catch((err) => {
      logger.error({ err, clientId: row.clientId }, 'ensureXeroContact failed (refresh path)');
    });
  }

  return updated;
}
