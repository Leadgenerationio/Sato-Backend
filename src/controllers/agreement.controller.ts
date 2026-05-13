import type { Request, Response } from 'express';
import { z } from 'zod';
import * as agreementService from '../services/agreement.service.js';
import { verifyWebhookSignature } from '../integrations/signnow/signnow-client.js';
import { R2_FOLDER_TUPLE } from '../integrations/r2/r2-types.js';
import { logger } from '../utils/logger.js';
import { uuidShape } from '../utils/zod-helpers.js';

// #47-50 PDF editor — drag-placed field schema. Coordinates are 0..1
// fractions of the page; the SignNow integration converts to pixels.
const fieldSchema = z.object({
  page: z.number().int().min(1).max(500),
  type: z.enum(['signature', 'date_signed', 'text']),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  widthPct: z.number().min(0.005).max(1),
  heightPct: z.number().min(0.005).max(1),
  prefillValue: z.string().max(500).optional(),
});

const sendSchema = z
  .object({
    clientId: uuidShape(),
    signerEmail: z.string().email(),
    signerName: z.string().min(1),
    // Sam Loom #68 — signatory role/title. Optional + bounded to 100 chars
    // (matches the DB column). Empty string is allowed and collapses to
    // null in the service.
    signerRole: z.string().max(100).optional(),
    /** Either documentBase64 OR r2SourceKey must be set; never both. */
    documentBase64: z.string().min(1).optional(),
    r2SourceKey: z.string().min(1).optional(),
    // Derived from the canonical R2_FOLDER_TUPLE so a new folder added in
    // r2-types.ts shows up here without a manual edit.
    r2SourceFolder: z.enum(R2_FOLDER_TUPLE).optional(),
    documentName: z.string().optional(),
    // #47-50 — optional drag-placed fields from the editor. Capped at 50
    // boxes — a typical agreement has 1-6.
    fields: z.array(fieldSchema).max(50).optional(),
  })
  .refine(
    (v) => Boolean(v.documentBase64) !== Boolean(v.r2SourceKey),
    { message: 'Provide exactly one of documentBase64 or r2SourceKey' },
  );

export async function send(req: Request, res: Response) {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    // Build a human-readable summary of the first failing field so the FE
    // toast tells Sam exactly what's wrong (e.g. "signerEmail: Invalid email")
    // instead of the generic "Invalid input" that hid real bugs.
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || 'request';
    const message = first ? `${path}: ${first.message}` : 'Invalid input';
    res.status(400).json({ status: 'error', message, issues: parsed.error.issues });
    return;
  }

  const agreement = await agreementService.sendAgreement(parsed.data);
  res.status(201).json({ status: 'success', data: { agreement } });
}

export async function listForClient(req: Request, res: Response) {
  const rows = await agreementService.listAgreementsForClient(req.params.clientId as string, req.user);
  res.json({ status: 'success', data: { agreements: rows } });
}

export async function listAll(_req: Request, res: Response) {
  const rows = await agreementService.listAllAgreements();
  res.json({ status: 'success', data: { agreements: rows } });
}

export async function refreshStatus(req: Request, res: Response) {
  const row = await agreementService.refreshAgreementStatus(req.params.id as string);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Agreement not found' });
    return;
  }
  res.json({ status: 'success', data: { agreement: row } });
}

export async function getOne(req: Request, res: Response) {
  const row = await agreementService.getAgreement(req.params.id as string, req.user);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Agreement not found' });
    return;
  }
  res.json({ status: 'success', data: { agreement: row } });
}

/**
 * SignNow webhook. Body is JSON sent on document events.
 * Verifies HMAC-SHA256 signature in `X-SignNow-Signature` using
 * `SIGNNOW_WEBHOOK_SECRET` when configured. In dev / when secret is missing,
 * signature check is skipped so local testing still works.
 */
export async function signnowWebhook(req: Request, res: Response) {
  try {
    const secret = process.env.SIGNNOW_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.header('x-signnow-signature') || req.header('X-SignNow-Signature') || '';
      // Use the raw request body bytes captured by the webhook-scoped JSON
      // parser (see src/index.ts). HMAC must be computed over the exact bytes
      // the provider signed — JSON.stringify(req.body) does NOT round-trip
      // (key order, whitespace, escape sequences differ).
      const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
      if (!verifyWebhookSignature(rawBody, sig)) {
        logger.warn('SignNow webhook signature verification failed — rejecting');
        res.status(401).json({ status: 'error', message: 'Invalid signature' });
        return;
      }
    } else if (process.env.NODE_ENV === 'production') {
      // In prod, refuse unsigned webhooks. Returning 503 (rather than 200)
      // surfaces the misconfiguration to SignNow's retry queue + monitoring
      // so the missing secret gets noticed instead of silently accepting
      // forged webhooks.
      logger.error('SIGNNOW_WEBHOOK_SECRET not set in production — refusing webhook');
      res.status(503).json({ status: 'error', message: 'Webhook secret not configured' });
      return;
    } else {
      // Dev / non-prod: allow unsigned for local testing, but log loudly.
      logger.warn('SignNow webhook accepted without signature (non-production environment)');
    }

    await agreementService.handleSignNowWebhook(req.body);
    res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error({ err }, 'SignNow webhook handler threw');
    // Always 200 to avoid retry storms; error is logged internally.
    res.status(200).json({ status: 'received' });
  }
}
