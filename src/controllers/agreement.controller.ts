import type { Request, Response } from 'express';
import { z } from 'zod';
import * as agreementService from '../services/agreement.service.js';

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
  const rows = await agreementService.listAgreementsForClient(req.params.clientId);
  res.json({ status: 'success', data: { agreements: rows } });
}

export async function listAll(_req: Request, res: Response) {
  const rows = await agreementService.listAllAgreements();
  res.json({ status: 'success', data: { agreements: rows } });
}

export async function refreshStatus(req: Request, res: Response) {
  const row = await agreementService.refreshAgreementStatus(req.params.id);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Agreement not found' });
    return;
  }
  res.json({ status: 'success', data: { agreement: row } });
}

export async function getOne(req: Request, res: Response) {
  const row = await agreementService.getAgreement(req.params.id);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Agreement not found' });
    return;
  }
  res.json({ status: 'success', data: { agreement: row } });
}

/**
 * DocuSign Connect webhook. Body is JSON sent by DocuSign on envelope events.
 * For production, verify the HMAC signature using DOCUSIGN_WEBHOOK_SECRET.
 */
export async function docusignWebhook(req: Request, res: Response) {
  try {
    await agreementService.handleDocuSignWebhook(req.body);
    res.status(200).json({ status: 'success' });
  } catch (err) {
    // Always 200 to avoid DocuSign retry storm; we've logged the error internally.
    res.status(200).json({ status: 'received' });
  }
}
