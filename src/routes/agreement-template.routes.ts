import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as controller from '../controllers/agreement-template.controller.js';

export const agreementTemplateRoutes: RouterType = Router();

const fieldLayoutSchema = z.array(z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['variable', 'signature', 'date_signed', 'text']),
  variableKey: z.string().max(100).optional(),
  text: z.string().max(500).optional(),
  page: z.number().int().min(0).max(50),
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  widthPct: z.number().min(0).max(1),
  heightPct: z.number().min(0).max(1),
  fontSize: z.number().min(6).max(72).optional(),
}));

const createSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    pdfR2Key: z.string().min(1).max(500),
    fieldLayout: fieldLayoutSchema.optional(),
    signerRole: z.string().max(100).optional(),
  }),
});

const updateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    fieldLayout: fieldLayoutSchema.optional(),
    signerRole: z.string().max(100).optional(),
  }),
});

const previewSchema = z.object({
  body: z.object({
    clientId: z.string().uuid(),
    overrides: z.record(z.string(), z.string()).optional(),
    effectiveDate: z.string().optional(),
  }),
});

agreementTemplateRoutes.use(authMiddleware);
agreementTemplateRoutes.use(requireRole('owner', 'finance_admin'));

agreementTemplateRoutes.get('/', controller.list);
agreementTemplateRoutes.post('/', validate(createSchema), controller.create);
agreementTemplateRoutes.get('/:id', controller.get);
agreementTemplateRoutes.put('/:id', validate(updateSchema), controller.update);
agreementTemplateRoutes.delete('/:id', controller.archive);
agreementTemplateRoutes.post('/:id/duplicate', controller.duplicate);
agreementTemplateRoutes.post('/:id/preview', validate(previewSchema), controller.preview);
