import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import { AppError } from '../utils/errors.js';
import * as keys from '../services/api-key.service.js';
import { listApiActivity, exportApiActivityCsv, ACTIVITY_MAX_LIMIT } from '../services/api-audit-activity.service.js';
import { db } from '../config/database.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { and, eq } from 'drizzle-orm';

// Settings → API keys. Owner only (default for Sam's open question 3 in the
// plan): create (the key is shown ONCE), list, revoke, recent usage, and the
// audit activity of every call made with a key (MCP spec v1.0 §3).
export const apiKeyRoutes: RouterType = Router();
apiKeyRoutes.use(authMiddleware, requireRole('owner'));

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(keys.API_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
  // MCP spec §3, step 1h: limit the key to some clients (null = every client), and the bot name for the activity log.
  allowedClientIds: z.array(uuidShape()).min(1).max(500).nullable().optional(),
  agentLabel: z.string().trim().max(100).nullable().optional(),
});

export const updateKeySchema = z.object({
  allowedClientIds: z.array(uuidShape()).min(1).max(500).nullable().optional(),
  agentLabel: z.string().trim().max(100).nullable().optional(),
}).refine((b) => b.allowedClientIds !== undefined || b.agentLabel !== undefined, { message: 'Send allowedClientIds or agentLabel' });

const businessOf = (req: Request) => {
  if (!req.user?.businessId) throw new AppError(403, 'No business assigned to your account');
  return req.user.businessId;
};

export const activityQuerySchema = z.object({
  keyId: uuidShape().optional(),
  tool: z.string().trim().min(1).max(100).optional(),
  transport: z.enum(['rest', 'mcp']).optional(),
  outcome: z.enum(['ok', 'error']).optional(),
  errorCode: z.string().trim().min(1).max(60).optional(),
  creativeId: uuidShape().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional(),
  cursor: z.string().regex(/^\d{1,17}\.\d{1,15}$/, 'Use nextCursor from the previous page').optional(),
});

function activityFilters(q: z.infer<typeof activityQuerySchema>) {
  return { ...q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined };
}

// Settings → API keys → Activity: every key's calls, newest first.
apiKeyRoutes.get('/activity', validate(z.object({ query: activityQuerySchema })), async (req: Request, res: Response) => {
  const q = activityQuerySchema.parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: await listApiActivity(businessOf(req), activityFilters(q)) });
});

// The same list as a CSV (spec D9), every matching row up to ACTIVITY_EXPORT_LIMIT.
const exportQuerySchema = activityQuerySchema.omit({ limit: true, cursor: true });
apiKeyRoutes.get('/activity.csv', validate(z.object({ query: exportQuerySchema })), async (req: Request, res: Response) => {
  const q = exportQuerySchema.parse(req.query);
  const { csv, count, truncated } = await exportApiActivityCsv(businessOf(req), activityFilters(q));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="api-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-Row-Count', String(count));
  if (truncated) res.setHeader('X-Truncated', 'true');
  // BOM so Excel reads names with accents correctly.
  res.send('\uFEFF' + csv);
});

apiKeyRoutes.get('/', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { apiKeys: await keys.listApiKeys(businessOf(req)), scopes: keys.API_SCOPES } });
});

apiKeyRoutes.post('/', validate(z.object({ body: createKeySchema })), async (req: Request, res: Response) => {
  const body = createKeySchema.parse(req.body);
  const out = await keys.createApiKey(businessOf(req), req.user!.userId, body);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ status: 'success', data: { ...out, note: 'Copy this key now — it is not shown again.' } });
});

// Change who a key can see (its client limit) or its agent label. Scopes are fixed at creation.
apiKeyRoutes.patch('/:id', validate(z.object({ params: z.object({ id: uuidShape() }), body: updateKeySchema })), async (req: Request, res: Response) => {
  const body = updateKeySchema.parse(req.body);
  res.json({ status: 'success', data: { apiKey: await keys.updateApiKeyLimits(businessOf(req), String(req.params.id), body) } });
});

apiKeyRoutes.delete('/:id', validate(z.object({ params: z.object({ id: uuidShape() }) })), async (req: Request, res: Response) => {
  await keys.revokeApiKey(businessOf(req), String(req.params.id));
  res.json({ status: 'success' });
});

apiKeyRoutes.get('/:id/usage', validate(z.object({ params: z.object({ id: uuidShape() }) })), async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { usage: await keys.listApiKeyUsage(businessOf(req), String(req.params.id)) } });
});

// One key's activity. A key from another business is not found.
apiKeyRoutes.get('/:id/activity', validate(z.object({ params: z.object({ id: uuidShape() }), query: activityQuerySchema.omit({ keyId: true }) })), async (req: Request, res: Response) => {
  const businessId = businessOf(req);
  const id = String(req.params.id);
  const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.businessId, businessId)));
  if (!key) throw new AppError(404, 'API key not found');
  const q = activityQuerySchema.omit({ keyId: true }).parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: await listApiActivity(businessId, { ...activityFilters(q), keyId: id }) });
});
