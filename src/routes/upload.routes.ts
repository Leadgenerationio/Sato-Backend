import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { getSignedUploadUrl, getSignedDownloadUrl, isR2Configured } from '../integrations/r2/r2-client.js';
import { R2_FOLDERS, R2_FOLDER_TUPLE, type R2Folder } from '../integrations/r2/r2-types.js';

export const uploadRoutes: RouterType = Router();

uploadRoutes.use(authMiddleware);

const presignSchema = z.object({
  // Derived from the canonical R2_FOLDER_TUPLE so a new folder added in
  // r2-types.ts is automatically accepted by the presign endpoint.
  folder: z.enum(R2_FOLDER_TUPLE),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
});

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

uploadRoutes.post(
  '/presign',
  requireRole('owner', 'ops_manager', 'finance_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = presignSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ status: 'error', message: 'Invalid input', issues: parsed.error.issues });
        return;
      }
      const { folder, filename, contentType, sizeBytes } = parsed.data;

      const key = `${Date.now()}-${sanitizeFilename(filename)}`;
      const uploadUrl = await getSignedUploadUrl({ folder, key, contentType, expiresInSeconds: 900 });
      const downloadUrl = await getSignedDownloadUrl({ folder, key, expiresInSeconds: 3600 });

      res.json({
        status: 'success',
        data: {
          uploadUrl,
          downloadUrl,
          key,
          folder,
          contentType,
          sizeBytes,
          configured: isR2Configured(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

uploadRoutes.get(
  '/signed-url',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const folder = String(req.query.folder || 'misc') as R2Folder;
      const key = String(req.query.key || '');
      if (!(R2_FOLDERS as readonly string[]).includes(folder) || !key) {
        res.status(400).json({ status: 'error', message: 'Invalid folder or key' });
        return;
      }
      const url = await getSignedDownloadUrl({ folder, key, expiresInSeconds: 3600 });
      res.json({ status: 'success', data: { url } });
    } catch (err) {
      next(err);
    }
  },
);
