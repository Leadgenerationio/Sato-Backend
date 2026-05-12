import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { isValidCron } from '../utils/cron-next.js';
import * as taskController from '../controllers/task.controller.js';

export const taskRoutes: RouterType = Router();

// Slice 5 Day 5 — explicit validation for the new fields so the controller
// gets clean inputs and bad calls fail fast at the edge instead of partial-
// applying. `passthrough()` is retained for forward-compat with FE that may
// send extra keys (template hints etc.).
const slice5OptionalFields = {
  timeBlockMinutes: z.number().int().positive().max(60 * 24 * 7).nullable().optional(),
  linkedSopId: z.string().uuid().nullable().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  recurrenceCron: z.string().max(100).nullable().optional().refine(
    (v) => v === null || v === undefined || isValidCron(v),
    { message: 'recurrenceCron must be a valid 5-field cron expression' },
  ),
  recurrenceNextRun: z.string().datetime().nullable().optional(),
};

const createTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300),
      ...slice5OptionalFields,
    })
    .passthrough(),
});

const updateTaskSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(300).optional(),
      ...slice5OptionalFields,
    })
    .passthrough(),
});

const updateTaskStatusSchema = z.object({
  body: z.object({ status: z.string().min(1).max(50) }),
});

const addCommentSchema = z.object({
  body: z.object({ text: z.string().min(1).max(5000) }),
});

// Slice 5 Day 2 — subtasks / attachments
const createSubtaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255),
    isDone: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
  }),
});
const updateSubtaskSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(255).optional(),
    isDone: z.boolean().optional(),
    position: z.number().int().nonnegative().optional(),
  }),
});
const addAttachmentSchema = z.object({
  body: z.object({
    r2Key: z.string().min(1).max(500),
    folder: z.string().max(50).optional(),
    name: z.string().min(1).max(255),
    contentType: z.string().max(100).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
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

// Slice 5 Day 2 — subtasks / attachments / activity feed
taskRoutes.get('/:id/subtasks', internalRoles, taskController.listSubtasks);
taskRoutes.post('/:id/subtasks', internalRoles, validate(createSubtaskSchema), taskController.createSubtask);
taskRoutes.patch('/:id/subtasks/:subtaskId', internalRoles, validate(updateSubtaskSchema), taskController.updateSubtask);
taskRoutes.delete('/:id/subtasks/:subtaskId', internalRoles, taskController.deleteSubtask);

taskRoutes.get('/:id/attachments', internalRoles, taskController.listAttachments);
taskRoutes.post('/:id/attachments', internalRoles, validate(addAttachmentSchema), taskController.addAttachment);
taskRoutes.delete('/:id/attachments/:attachmentId', internalRoles, taskController.removeAttachment);

taskRoutes.get('/:id/activity', internalRoles, taskController.listActivity);

// Slice 5 Day 5 — children of a parent task (project-tree view)
taskRoutes.get('/:id/children', internalRoles, taskController.listChildTasks);
