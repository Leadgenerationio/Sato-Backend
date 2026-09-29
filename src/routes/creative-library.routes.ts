import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { uuidShape } from '../utils/zod-helpers.js';
import * as ctrl from '../controllers/creative-library.controller.js';
import { apiKeyOrJwt, allow, apiKeyRateLimit, idempotency } from '../middleware/api-key.middleware.js';

// Creative library + landing pages (M2). Mounted at '/' BEFORE creativeRoutes,
// which has a router-level owner/ops guard that would 403 Finance before these
// read routes were reached. Guards here are per route: owner/ops write,
// finance reads.
export const creativeLibraryRoutes: RouterType = Router();

const READ = requireRole('owner', 'ops_manager', 'finance_admin');
const WRITE = requireRole('owner', 'ops_manager');
const idParam = z.object({ params: z.object({ id: uuidShape() }) });

// Public API (X-API-Key) as well as JWT: list/get/create creatives, attach a
// landing page, create a landing page. Everything else is JWT only.
const KEY_OR_JWT = [apiKeyOrJwt, apiKeyRateLimit];
const READ_ROLES = ['owner', 'ops_manager', 'finance_admin'] as const;
const WRITE_ROLES = ['owner', 'ops_manager'] as const;

creativeLibraryRoutes.get('/creatives', ...KEY_OR_JWT, allow([...READ_ROLES], 'creatives:read'), validate(z.object({ query: ctrl.listQuerySchema })), ctrl.list);
// POST /creatives also accepts the pre-library campaign upload shape (see controller).
creativeLibraryRoutes.post('/creatives', ...KEY_OR_JWT, allow([...WRITE_ROLES], 'creatives:write'), idempotency, ctrl.create);
creativeLibraryRoutes.post('/creatives/bulk', authMiddleware, WRITE, validate(z.object({ body: ctrl.bulkSchema })), ctrl.bulk);
creativeLibraryRoutes.get('/creatives/:id', ...KEY_OR_JWT, allow([...READ_ROLES], 'creatives:read'), validate(idParam), ctrl.get);
creativeLibraryRoutes.patch('/creatives/:id', authMiddleware, WRITE, validate(idParam.extend({ body: ctrl.patchSchema })), ctrl.patch);
creativeLibraryRoutes.post('/creatives/:id/landing-page', ...KEY_OR_JWT, allow([...WRITE_ROLES], 'creatives:write'), validate(idParam.extend({ body: ctrl.attachSchema })), ctrl.attachLandingPage);

creativeLibraryRoutes.get('/landing-pages', authMiddleware, READ, validate(z.object({ query: ctrl.lpListQuery })), ctrl.listLandingPages);
creativeLibraryRoutes.post('/landing-pages', ...KEY_OR_JWT, allow([...WRITE_ROLES], 'landing_pages:write'), validate(z.object({ body: ctrl.lpCreateSchema })), ctrl.createLandingPage);
creativeLibraryRoutes.patch('/landing-pages/:id', authMiddleware, WRITE, validate(idParam.extend({ body: ctrl.lpPatchSchema })), ctrl.patchLandingPage);
creativeLibraryRoutes.delete('/landing-pages/:id', authMiddleware, WRITE, validate(idParam), ctrl.deleteLandingPage);
creativeLibraryRoutes.get('/clients/:id/landing-pages', authMiddleware, READ, validate(idParam), ctrl.listClientLandingPages);
