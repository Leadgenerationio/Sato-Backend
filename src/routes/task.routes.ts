import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as taskController from '../controllers/task.controller.js';

export const taskRoutes: RouterType = Router();

const createTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300),
    })
    .passthrough(),
});

const updateTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300).optional(),
    })
    .passthrough(),
});

const updateTaskStatusSchema = z.object({
  body: z.object({ status: z.string().min(1).max(50) }),
});

const addCommentSchema = z.object({
  body: z.object({ text: z.string().min(1).max(5000) }),
});

const createFromTemplateSchema = z.object({
  body: z
    .object({
      templateId: z.string().min(1).optional(),
      assignee: z.string().max(200).optional(),
      dueDate: z.string().optional(),
    })
    .passthrough(),
});

taskRoutes.use(authMiddleware);

// Tasks are an internal ops surface — clients/readonly users have no business
// reading or modifying them. Lock everything below to internal roles. The
// `templates` endpoint is also internal config so it sits behind the same gate.
const internalRoles = requireRole('owner', 'ops_manager', 'finance_admin');

taskRoutes.get('/', internalRoles, taskController.listTasks);
taskRoutes.get('/stats', internalRoles, taskController.getTaskStats);
taskRoutes.get('/templates', internalRoles, taskController.listTemplates);
taskRoutes.post('/templates/:id/create', internalRoles, validate(createFromTemplateSchema), taskController.createFromTemplate);
// FE alias: POST /from-template with { templateId, assignee?, dueDate? } in body.
taskRoutes.post('/from-template', internalRoles, validate(createFromTemplateSchema), taskController.createFromTemplate);
taskRoutes.get('/:id', internalRoles, taskController.getTask);
taskRoutes.post('/', internalRoles, validate(createTaskSchema), taskController.createTask);
taskRoutes.put('/:id', internalRoles, validate(updateTaskSchema), taskController.updateTask);
taskRoutes.patch('/:id/status', internalRoles, validate(updateTaskStatusSchema), taskController.updateTaskStatus);
taskRoutes.post('/:id/comments', internalRoles, validate(addCommentSchema), taskController.addComment);
