import type { Request, Response } from 'express';
import { z } from 'zod';
import * as creativeService from '../services/creative.service.js';
import * as approvalService from '../services/creative-approval.service.js';
import { CreativeApprovalError } from '../services/creative-approval.service.js';

export async function listForCampaign(req: Request, res: Response) {
  const creatives = await creativeService.listCreativesForCampaign(
    req.params.campaignId as string,
    req.user!,
  );
  res.json({ status: 'success', data: { creatives } });
}

// campaignId accepts either Sato uuid or LeadByte numeric id — the service
// layer resolves it via resolveSatoCampaignId. Was uuidShape() previously,
// which 400'd every upload from the campaign detail page since that page
// keys campaigns by LeadByte's numeric id.
//
// section drives which card the asset shows up in on the buyer's review
// tab (`media` = image/video card, `copy_lp` = copy + landing-page card).
// Defaults to 'media' for legacy uploaders that don't send it.
const createSchema = z.object({
  campaignId: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  type: z.enum(['image', 'video', 'text']),
  r2Key: z.string().min(1),
  fileUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  section: z.enum(['media', 'copy_lp']).optional(),
});

export async function create(req: Request, res: Response) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const creative = await creativeService.createCreative(parsed.data, req.user!);
  if (!creative) {
    res.status(404).json({ status: 'error', message: 'Campaign not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { creative } });
}

export async function remove(req: Request, res: Response) {
  const ok = await creativeService.softDeleteCreative(req.params.id as string, req.user!);
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Creative not found' });
    return;
  }
  res.json({ status: 'success' });
}

/**
 * Admin-side audit trail for a single creative — every approve/reject row
 * with IP, UA, user, timestamp. This is the legal-evidence view used when
 * a client later disputes whether they approved an ad.
 */
export async function approvalHistory(req: Request, res: Response) {
  const events = await approvalService.getApprovalHistory(req.params.id as string);
  res.json({ status: 'success', data: { events } });
}

/**
 * T2 (Sam, 2026-05-20) — staff flips a draft → sent_for_approval. Only
 * works from 'draft' or 'changes_requested'; any other state returns 409.
 * Emits an audit row (action='submitted') so the timeline shows who sent
 * it and when. The buyer only starts seeing the creative on portal pages
 * once this endpoint has been called.
 */
export async function submitForApproval(req: Request, res: Response) {
  try {
    const event = await approvalService.submitForApproval({
      creativeId: req.params.id as string,
      submittedByUserId: req.user!.userId,
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.json({ status: 'success', data: { event } });
  } catch (err) {
    if (err instanceof CreativeApprovalError) {
      const httpStatus =
        err.code === 'NOT_FOUND' ? 404 :
        err.code === 'INVALID_STATE' ? 409 :
        err.code === 'ACCESS_DENIED' ? 403 :
        400;
      res.status(httpStatus).json({ status: 'error', code: err.code, message: err.message });
      return;
    }
    throw err;
  }
}
