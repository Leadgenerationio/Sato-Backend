import { Request, Response } from 'express';
import * as taskService from '../services/task.service.js';

export async function listTasks(req: Request, res: Response) {
  const { status, priority, assignee, search } = req.query;

  const filters: taskService.TaskFilters = {};
  if (status) filters.status = status as string;
  if (priority) filters.priority = priority as string;
  if (assignee) filters.assignee = assignee as string;
  if (search) filters.search = search as string;

  let tasks = await taskService.listTasks(req.user!, filters);

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const total = tasks.length;
  const start = (page - 1) * limit;
  const items = tasks.slice(start, start + limit);

  res.json({ status: 'success', data: { tasks: items, total, page, pageSize: limit } });
}

export async function getTask(req: Request, res: Response) {
  const task = await taskService.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { task } });
}

export async function createTask(req: Request, res: Response) {
  const task = await taskService.createTask(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { task } });
}

export async function updateTask(req: Request, res: Response) {
  const task = await taskService.updateTask(req.params.id, req.body);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { task } });
}

export async function updateTaskStatus(req: Request, res: Response) {
  const { status } = req.body;
  if (!status) {
    res.status(400).json({ status: 'error', message: 'Status is required' });
    return;
  }
  const task = await taskService.updateTaskStatus(req.params.id, status);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { task } });
}

export async function addComment(req: Request, res: Response) {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ status: 'error', message: 'Comment text is required' });
    return;
  }
  const comment = await taskService.addComment(req.params.id, {
    author: req.user!.email,
    text,
  });
  if (!comment) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { comment } });
}

export async function getTaskStats(req: Request, res: Response) {
  const stats = await taskService.getTaskStats(req.user!);
  res.json({ status: 'success', data: { stats } });
}

export async function listTemplates(_req: Request, res: Response) {
  const templates = await taskService.listTemplates();
  res.json({ status: 'success', data: { templates } });
}

export async function createFromTemplate(req: Request, res: Response) {
  const { assignee } = req.body;
  const task = await taskService.createFromTemplate(req.params.id, assignee || req.user!.email, req.user!);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { task } });
}
