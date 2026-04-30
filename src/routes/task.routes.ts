import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
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
  body: z.object({ assignee: z.string().max(200).optional() }),
});

taskRoutes.use(authMiddleware);

taskRoutes.get('/', taskController.listTasks);
taskRoutes.get('/stats', taskController.getTaskStats);
taskRoutes.get('/templates', taskController.listTemplates);
taskRoutes.post('/templates/:id/create', validate(createFromTemplateSchema), taskController.createFromTemplate);
taskRoutes.get('/:id', taskController.getTask);
taskRoutes.post('/', validate(createTaskSchema), taskController.createTask);
taskRoutes.put('/:id', validate(updateTaskSchema), taskController.updateTask);
taskRoutes.patch('/:id/status', validate(updateTaskStatusSchema), taskController.updateTaskStatus);
taskRoutes.post('/:id/comments', validate(addCommentSchema), taskController.addComment);
