import type { Request, Response } from 'express';
import { z } from 'zod';
import * as lib from '../services/creative-library.service.js';
import * as approvalService from '../services/creative-approval.service.js';
import * as legacy from './creative.controller.js';
import { AppError } from '../utils/errors.js';
import { uuidShape } from '../utils/zod-helpers.js';

// Creative library + landing pages (Sam feedback round 1, M2).

function businessOf(req: Request): string {
  const b = req.user?.businessId;
  if (!b) throw new AppError(403, 'No business assigned to your account');
  return b;
}

export const platformEnum = z.enum(['meta', 'taboola', 'google', 'tiktok', 'manual']);

export const creativeInputSchema = z.object({
  clientId: uuidShape().nullable().optional(),
  campaignId: uuidShape().nullable().optional(),
  platform: platformEnum.default('manual'),
  platformAccountId: z.string().trim().min(1).max(100).optional(),
  platformAdId: z.string().trim().min(1).max(100).optional(),
  platformCreativeId: z.string().trim().min(1).max(100).optional(),
  platformCampaignId: z.string().trim().min(1).max(100).optional(),
  platformCampaignName: z.string().trim().max(255).optional(),
  landingPageUrl: z.string().trim().min(1).max(500).optional(),
  headline: z.string().max(2000).optional(),
  bodyText: z.string().max(10000).optional(),
  mediaType: z.enum(['image', 'video']),
  sourceUrl: z.string().url().max(2000).optional(),
  r2Key: z.string().min(1).max(500).optional(),
  contentType: z.string().max(120).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, 'sha256 must be 64 hex characters').optional(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  durationS: z.number().nonnegative().max(36000).optional(),
  name: z.string().trim().min(1).max(255).optional(),
}).refine((b) => b.r2Key || b.sourceUrl, { message: 'Send r2Key (from POST /uploads/presign, folder "creatives") or sourceUrl', path: ['r2Key'] });

export const createCreativesBodySchema = z.union([
  creativeInputSchema,
  z.object({ creatives: z.array(creativeInputSchema).min(1).max(50) }),
]);

// The pre-library campaign upload (campaign detail → Creatives card) sends
// { campaignId, name, type, r2Key, fileUrl, sizeBytes, contentType, section }.
// Keep routing that shape to the original handler so its buyer email and
// approval flow are untouched.
function isLegacyCampaignUpload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b.campaignId === 'string' && typeof b.fileUrl === 'string' && 'type' in b
    && !('creatives' in b) && !('mediaType' in b) && !('clientId' in b) && !('platform' in b);
}

export type CreatedCreative = { id: string; created: boolean; creative: lib.LibraryCreativeDto | null };

/** Shared by the JWT route and the public API (with Idempotency-Key). */
export async function createFromBody(businessId: string, body: unknown, uploadedBy: string | null): Promise<{ status: number; body: unknown }> {
  const parsed = createCreativesBodySchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { status: 'error', message: 'Validation failed', errors: parsed.error.issues.map((e) => ({ path: e.path.join('.'), message: e.message })) } };
  }
  const items = 'creatives' in parsed.data ? parsed.data.creatives : [parsed.data];
  const results: Array<CreatedCreative | { error: string; status: number; index: number }> = [];
  for (const [index, item] of items.entries()) {
    try {
      const { creative, created } = await lib.upsertPlatformCreative({ ...item, businessId, uploadedBy });
      results.push({ id: creative.id, created, creative: await lib.getCreative(businessId, creative.id) });
    } catch (err) {
      if (!(err instanceof AppError) || items.length === 1) throw err;
      results.push({ index, status: err.statusCode, error: err.message });
    }
  }
  if (!('creatives' in parsed.data)) {
    const r = results[0] as CreatedCreative;
    return { status: r.created ? 201 : 200, body: { status: 'success', data: { creative: r.creative, created: r.created } } };
  }
  const anyCreated = results.some((r) => 'created' in r && r.created);
  return { status: anyCreated ? 201 : 200, body: { status: 'success', data: { results } } };
}

export async function create(req: Request, res: Response) {
  if (isLegacyCampaignUpload(req.body)) return legacy.create(req, res);
  const out = await createFromBody(businessOf(req), req.body, req.user?.userId ?? null);
  res.status(out.status).json(out.body);
}

export const listQuerySchema = z.object({
  clientId: uuidShape().optional(),
  platform: platformEnum.optional(),
  campaignId: uuidShape().optional(),
  landingPageId: uuidShape().optional(),
  landingPage: z.string().max(500).optional(),
  status: z.enum(['draft', 'sent_for_approval', 'approved', 'rejected', 'changes_requested']).optional(),
  q: z.string().max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  includeArchived: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['created', 'last_seen', 'name']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function list(req: Request, res: Response) {
  const q = listQuerySchema.parse(req.query);
  // `landingPage` (spec name) accepts a landing page id.
  const data = await lib.listCreatives(businessOf(req), { ...q, landingPageId: q.landingPageId ?? (q.landingPage && /^[0-9a-f-]{36}$/i.test(q.landingPage) ? q.landingPage : undefined) });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data });
}

export async function get(req: Request, res: Response) {
  const businessId = businessOf(req);
  const creative = await lib.getCreative(businessId, String(req.params.id));
  if (!creative) throw new AppError(404, 'Creative not found');
  const { url: fileUrl, missing: fileMissing } = await lib.signedFile(businessId, creative.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { creative: { ...creative, fileUrl, fileMissing } } });
}

export const patchSchema = z.object({
  clientId: uuidShape().nullable().optional(),
  campaignId: uuidShape().nullable().optional(),
  landingPageId: uuidShape().nullable().optional(),
  name: z.string().trim().min(1).max(255).optional(),
  headline: z.string().max(2000).nullable().optional(),
  bodyText: z.string().max(10000).nullable().optional(),
});

export async function patch(req: Request, res: Response) {
  const body = patchSchema.parse(req.body);
  const creative = await lib.updateCreative(businessOf(req), String(req.params.id), body);
  res.json({ status: 'success', data: { creative } });
}

export const attachSchema = z.object({
  url: z.string().trim().min(1).max(500).optional(),
  landingPageId: uuidShape().optional(),
}).refine((b) => b.url || b.landingPageId, { message: 'Send url or landingPageId' });

export async function attachLandingPage(req: Request, res: Response) {
  const body = attachSchema.parse(req.body);
  const creative = await lib.attachLandingPage(businessOf(req), String(req.params.id), body);
  res.json({ status: 'success', data: { creative } });
}

export const bulkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign_landing_page'), ids: z.array(uuidShape()).min(1).max(200), landingPageId: uuidShape().optional(), url: z.string().max(500).optional() }),
  z.object({ action: z.literal('move_client'), ids: z.array(uuidShape()).min(1).max(200), clientId: uuidShape() }),
  z.object({ action: z.literal('submit_for_approval'), ids: z.array(uuidShape()).min(1).max(200) }),
]);

export async function bulk(req: Request, res: Response) {
  const body = bulkSchema.parse(req.body);
  const result = await lib.bulkUpdate(businessOf(req), body, (creativeId) => approvalService.submitForApproval({
    creativeId,
    submittedByUserId: req.user!.userId,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  }));
  res.json({ status: 'success', data: result });
}

// ─── Landing pages ───

export const lpListQuery = z.object({ clientId: uuidShape().optional(), q: z.string().max(200).optional(), includeArchived: z.enum(['true', 'false']).optional() });
export const lpCreateSchema = z.object({
  clientId: uuidShape(),
  url: z.string().trim().min(1).max(500),
  title: z.string().trim().max(255).nullable().optional(),
  campaignId: uuidShape().nullable().optional(),
});
export const lpPatchSchema = z.object({
  url: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().max(255).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export async function listLandingPages(req: Request, res: Response) {
  const q = lpListQuery.parse(req.query);
  const pages = await lib.listLandingPages(businessOf(req), { clientId: q.clientId, q: q.q, includeArchived: q.includeArchived === 'true' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { landingPages: pages } });
}

export async function listClientLandingPages(req: Request, res: Response) {
  const pages = await lib.listLandingPages(businessOf(req), { clientId: String(req.params.id) });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { landingPages: pages } });
}

export async function createLandingPage(req: Request, res: Response) {
  const body = lpCreateSchema.parse(req.body);
  const { page, created } = await lib.createLandingPage(businessOf(req), body);
  res.status(created ? 201 : 200).json({ status: 'success', data: { landingPage: page, created } });
}

export async function patchLandingPage(req: Request, res: Response) {
  const body = lpPatchSchema.parse(req.body);
  const page = await lib.updateLandingPage(businessOf(req), String(req.params.id), body);
  res.json({ status: 'success', data: { landingPage: page } });
}

export async function deleteLandingPage(req: Request, res: Response) {
  await lib.archiveLandingPage(businessOf(req), String(req.params.id));
  res.json({ status: 'success' });
}
