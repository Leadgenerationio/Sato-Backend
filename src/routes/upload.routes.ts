import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { getSignedUploadUrl, getSignedDownloadUrl, isR2Configured, objectExists } from '../integrations/r2/r2-client.js';
import { R2_FOLDERS, R2_FOLDER_TUPLE, type R2Folder } from '../integrations/r2/r2-types.js';
import { assertCanReadObject, UploadAccessError } from '../services/upload-authz.service.js';

export const uploadRoutes: RouterType = Router();

uploadRoutes.use(authMiddleware);

export const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const presignSchema = z.object({
  // Derived from the canonical R2_FOLDER_TUPLE so a new folder added in
  // r2-types.ts is automatically accepted by the presign endpoint.
  folder: z.enum(R2_FOLDER_TUPLE),
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1),
  // Size is checked in checkUploadAllowed() so the error can say the limit.
  sizeBytes: z.number().int().positive(),
});

// Sam feedback S9 (29 Sep 2026): "a .exe got as far as the upload request".
// Executables/scripts are refused for every folder; the creatives folder
// (campaign media + "copy & landing page" docs) only takes the types below.
// Mirrors the FE allow-list in Sato-Frontend src/lib/upload-rules.ts.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'dll', 'sh', 'ps1', 'vbs',
  'js', 'mjs', 'jar', 'app', 'dmg', 'pkg', 'apk', 'deb', 'rpm', 'hta', 'lnk',
]);
const BLOCKED_CONTENT_TYPES = new Set([
  'application/x-msdownload', 'application/x-msdos-program', 'application/x-executable',
  'application/x-sh', 'application/x-bat', 'application/java-archive',
  'application/vnd.microsoft.portable-executable', 'application/x-apple-diskimage',
  'text/javascript', 'application/javascript',
]);
const CREATIVE_CONTENT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
  'application/pdf', 'text/plain', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** Plain-words reason the upload is refused, or null when it's allowed. */
export function checkUploadAllowed(folder: string, filename: string, contentType: string, sizeBytes: number): string | null {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_CONTENT_TYPES.has(type)) {
    return "This file type can't be uploaded.";
  }
  if (folder === 'creatives' && !CREATIVE_CONTENT_TYPES.has(type)) {
    return 'Creatives must be images (PNG, JPG, GIF, WebP), videos (MP4, MOV, WebM) or PDF / Word / text documents.';
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return `File too large: max ${MAX_UPLOAD_MB} MB.`;
  }
  return null;
}

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
      const refusal = checkUploadAllowed(folder, filename, contentType, sizeBytes);
      if (refusal) {
        res.status(400).json({ status: 'error', message: refusal });
        return;
      }

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

      // Authz BEFORE object-existence so we don't leak which keys exist via
      // timing/error differences. Both denials and missing objects look
      // identical from the outside (404 "Not found").
      try {
        await assertCanReadObject(req.user!, folder, key);
      } catch (authErr) {
        if (authErr instanceof UploadAccessError) {
          res.status(404).json({ status: 'error', message: 'Not found' });
          return;
        }
        throw authErr;
      }

      // Stale/mistyped key → return 404 too, so the FE toasts cleanly
      // instead of opening a window that gets R2's NoSuchKey XML.
      if (!(await objectExists(folder, key))) {
        res.status(404).json({ status: 'error', message: 'Not found' });
        return;
      }

      const url = await getSignedDownloadUrl({ folder, key, expiresInSeconds: 3600 });
      res.json({ status: 'success', data: { url } });
    } catch (err) {
      next(err);
    }
  },
);
