import type { Request, Response } from 'express';
import { z } from 'zod';
import * as agreementService from '../services/agreement.service.js';
import { verifyWebhookSignature } from '../integrations/signnow/signnow-client.js';
import { logger } from '../utils/logger.js';

const sendSchema = z.object({
  clientId: z.string().uuid(),
  signerEmail: z.string().email(),
  signerName: z.string().min(1),
  documentBase64: z.string().min(1),
  documentName: z.string().optional(),
});

export async function send(req: Request, res: Response) {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  const agreement = await agreementService.sendAgreement(parsed.data);
  res.status(201).json({ status: 'success', data: { agreement } });
}

export async function listForClient(req: Request, res: Response) {
  const rows = await agreementService.listAgreementsForClient(req.params.clientId as string);
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
  const row = await agreementService.getAgreement(req.params.id as string);
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
      const rawBody = typeof (req as Request & { rawBody?: string }).rawBody === 'string'
        ? (req as Request & { rawBody?: string }).rawBody!
        : JSON.stringify(req.body);
      if (!verifyWebhookSignature(rawBody, sig)) {
        logger.warn('SignNow webhook signature verification failed — rejecting');
        res.status(401).json({ status: 'error', message: 'Invalid signature' });
        return;
      }
    }

    await agreementService.handleSignNowWebhook(req.body);
    res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error({ err }, 'SignNow webhook handler threw');
    // Always 200 to avoid retry storms; error is logged internally.
    res.status(200).json({ status: 'received' });
  }
}
