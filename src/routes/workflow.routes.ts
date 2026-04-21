import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as workflowController from '../controllers/workflow.controller.js';

export const workflowRoutes: RouterType = Router();

workflowRoutes.use(authMiddleware);
workflowRoutes.use(requireRole('owner', 'ops_manager'));

workflowRoutes.get('/step-types', workflowController.getStepTypes);
workflowRoutes.get('/', workflowController.listWorkflows);
workflowRoutes.post('/', workflowController.createWorkflow);
workflowRoutes.get('/:id', workflowController.getWorkflow);
workflowRoutes.put('/:id', workflowController.updateWorkflow);
workflowRoutes.post('/:id/toggle-status', workflowController.toggleStatus);
workflowRoutes.post('/:id/execute', workflowController.executeWorkflow);
