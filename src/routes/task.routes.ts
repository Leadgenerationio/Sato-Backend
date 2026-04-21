import { Router, type Router as RouterType } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import * as taskController from '../controllers/task.controller.js';

export const taskRoutes: RouterType = Router();

taskRoutes.use(authMiddleware);

taskRoutes.get('/', taskController.listTasks);
taskRoutes.get('/stats', taskController.getTaskStats);
taskRoutes.get('/templates', taskController.listTemplates);
taskRoutes.post('/templates/:id/create', taskController.createFromTemplate);
taskRoutes.get('/:id', taskController.getTask);
taskRoutes.post('/', taskController.createTask);
taskRoutes.put('/:id', taskController.updateTask);
taskRoutes.patch('/:id/status', taskController.updateTaskStatus);
taskRoutes.post('/:id/comments', taskController.addComment);
