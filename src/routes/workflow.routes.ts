import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as workflowController from '../controllers/workflow.controller.js';

export const workflowRoutes: RouterType = Router();

const createWorkflowSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(200),
      steps: z.array(z.unknown()).optional(),
    })
    .passthrough(),
});

const updateWorkflowSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(200).optional(),
      steps: z.array(z.unknown()).optional(),
    })
    .passthrough(),
});

workflowRoutes.use(authMiddleware);
workflowRoutes.use(requireRole('owner', 'ops_manager'));

workflowRoutes.get('/step-types', workflowController.getStepTypes);
workflowRoutes.get('/', workflowController.listWorkflows);
workflowRoutes.post('/', validate(createWorkflowSchema), workflowController.createWorkflow);
workflowRoutes.get('/:id', workflowController.getWorkflow);
workflowRoutes.put('/:id', validate(updateWorkflowSchema), workflowController.updateWorkflow);
workflowRoutes.post('/:id/toggle-status', workflowController.toggleStatus);
// T4 (Sam, 2026-05-20): explicit pause / resume so the FE doesn't have to
// guess state. Idempotent — same call twice returns 200 each time without
// flipping into the wrong state, which is what the toggle endpoint does
// under race conditions.
workflowRoutes.post('/:id/pause', workflowController.pauseWorkflow);
workflowRoutes.post('/:id/resume', workflowController.resumeWorkflow);
workflowRoutes.post('/:id/execute', workflowController.executeWorkflow);
