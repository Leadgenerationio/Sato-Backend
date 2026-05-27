import { Request, Response } from 'express';
import * as taskService from '../services/task.service.js';
import * as subtasksService from '../services/task-subtasks.service.js';
import * as attachmentsService from '../services/task-attachments.service.js';
import * as activityService from '../services/task-activity.service.js';

export async function listTasks(req: Request, res: Response) {
  const { status, priority, assignee, search, archive } = req.query;

  const filters: taskService.TaskFilters = {};
  if (status) filters.status = status as string;
  if (priority) filters.priority = priority as string;
  if (assignee) filters.assignee = assignee as string;
  if (search) filters.search = search as string;
  // Sam-Loom #7 — archive split. Defaults to 'today' so the FE doesn't
  // have to opt in; pass ?archive=archive for the archived view and
  // ?archive=all to disable the filter (used by stats / cross-cutting reports).
  if (archive === 'today' || archive === 'all' || archive === 'archive') {
    filters.archive = archive;
  }

  const tasks = await taskService.listTasks(req.user!, filters);

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const total = tasks.length;
  const start = (page - 1) * limit;
  const items = tasks.slice(start, start + limit);

  res.json({ status: 'success', data: { tasks: items, total, page, pageSize: limit } });
}

export async function getTask(req: Request, res: Response) {
  const task = await taskService.getTask(req.params.id as string);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { task } });
}

export async function listChildTasks(req: Request, res: Response) {
  const children = await taskService.listChildTasks(req.params.id as string);
  res.json({ status: 'success', data: { children } });
}

export async function createTask(req: Request, res: Response) {
  const task = await taskService.createTask(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { task } });
}

export async function updateTask(req: Request, res: Response) {
  const task = await taskService.updateTask(req.params.id as string, req.body, req.user!);
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { task } });
}

export async function deleteTask(req: Request, res: Response) {
  const ok = await taskService.deleteTask(req.params.id as string, req.user!);
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { deleted: true } });
}

export async function updateTaskStatus(req: Request, res: Response) {
  const { status } = req.body;
  if (!status) {
    res.status(400).json({ status: 'error', message: 'Status is required' });
    return;
  }
  const task = await taskService.updateTaskStatus(req.params.id as string, status, req.user!);
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
  const comment = await taskService.addComment(
    req.params.id as string,
    { author: req.user!.email, text },
    req.user!,
  );
  if (!comment) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { comment } });
}

// ─── Slice 5 — subtasks / attachments / activity feed ──────────────────────

export async function listSubtasks(req: Request, res: Response) {
  const out = await subtasksService.listSubtasks(req.params.id as string);
  if (out === null) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { subtasks: out } });
}

export async function createSubtask(req: Request, res: Response) {
  const out = await subtasksService.createSubtask(req.params.id as string, req.body, req.user!);
  if (!out) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { subtask: out } });
}

export async function updateSubtask(req: Request, res: Response) {
  const out = await subtasksService.updateSubtask(
    req.params.id as string,
    req.params.subtaskId as string,
    req.body,
    req.user!,
  );
  if (!out) {
    res.status(404).json({ status: 'error', message: 'Subtask not found' });
    return;
  }
  res.json({ status: 'success', data: { subtask: out } });
}

export async function deleteSubtask(req: Request, res: Response) {
  const ok = await subtasksService.deleteSubtask(
    req.params.id as string,
    req.params.subtaskId as string,
    req.user!,
  );
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Subtask not found' });
    return;
  }
  res.status(204).end();
}

export async function listAttachments(req: Request, res: Response) {
  const out = await attachmentsService.listAttachments(req.params.id as string);
  if (out === null) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.json({ status: 'success', data: { attachments: out } });
}

export async function addAttachment(req: Request, res: Response) {
  const out = await attachmentsService.addAttachment(req.params.id as string, req.body, req.user!);
  if (!out) {
    res.status(404).json({ status: 'error', message: 'Task not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { attachment: out } });
}

export async function removeAttachment(req: Request, res: Response) {
  const ok = await attachmentsService.removeAttachment(
    req.params.id as string,
    req.params.attachmentId as string,
    req.user!,
  );
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Attachment not found' });
    return;
  }
  res.status(204).end();
}

export async function listActivity(req: Request, res: Response) {
  const events = await activityService.listActivityForTask(req.params.id as string);
  res.json({ status: 'success', data: { activity: events } });
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
  const { assignee, templateId, dueDate } = req.body ?? {};
  // Accept the templateId from either the path param (legacy
  // /templates/:id/create route) or the request body (new /from-template
  // alias the FE uses).
  const id = (req.params.id as string | undefined) || templateId;
  if (!id) {
    res.status(400).json({ status: 'error', message: 'templateId is required' });
    return;
  }
  const task = await taskService.createFromTemplate(id, assignee || req.user!.email, req.user!, { dueDate });
  if (!task) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { task } });
}
