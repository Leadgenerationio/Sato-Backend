import type { Request, Response } from 'express';
import { z } from 'zod';
import * as creativeService from '../services/creative.service.js';
import { uuidShape } from '../utils/zod-helpers.js';

export async function listForCampaign(req: Request, res: Response) {
  const creatives = await creativeService.listCreativesForCampaign(
    req.params.campaignId as string,
    req.user!,
  );
  res.json({ status: 'success', data: { creatives } });
}

const createSchema = z.object({
  campaignId: uuidShape(),
  name: z.string().min(1).max(255),
  type: z.enum(['image', 'video', 'text']),
  r2Key: z.string().min(1),
  fileUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
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
