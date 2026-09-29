import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import { AppError } from '../utils/errors.js';
import * as keys from '../services/api-key.service.js';

// Settings → API keys. Owner only (default for Sam's open question 3 in the
// plan): create (the key is shown ONCE), list, revoke, recent usage.
export const apiKeyRoutes: RouterType = Router();
apiKeyRoutes.use(authMiddleware, requireRole('owner'));

export const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(keys.API_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

const businessOf = (req: Request) => {
  if (!req.user?.businessId) throw new AppError(403, 'No business assigned to your account');
  return req.user.businessId;
};

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

apiKeyRoutes.delete('/:id', validate(z.object({ params: z.object({ id: uuidShape() }) })), async (req: Request, res: Response) => {
  await keys.revokeApiKey(businessOf(req), String(req.params.id));
  res.json({ status: 'success' });
});

apiKeyRoutes.get('/:id/usage', validate(z.object({ params: z.object({ id: uuidShape() }) })), async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { usage: await keys.listApiKeyUsage(businessOf(req), String(req.params.id)) } });
});
