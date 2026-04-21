import { Request, Response } from 'express';
import * as notificationService from '../services/notification.service.js';

export async function listNotifications(req: Request, res: Response) {
  let notifications = await notificationService.listNotifications(req.user!);

  const { filter } = req.query;
  if (filter === 'unread') {
    notifications = notifications.filter((n) => !n.read);
  }

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const total = notifications.length;
  const start = (page - 1) * limit;
  const items = notifications.slice(start, start + limit);

  res.json({
    status: 'success',
    data: { notifications: items, total, page, pageSize: limit },
  });
}

export async function markAsRead(req: Request, res: Response) {
  const notification = await notificationService.markAsRead(req.params.id, req.user!);

  if (!notification) {
    res.status(404).json({ status: 'error', message: 'Notification not found' });
    return;
  }

  res.json({ status: 'success', data: { notification } });
}

export async function markAllAsRead(req: Request, res: Response) {
  const result = await notificationService.markAllAsRead(req.user!);
  res.json({ status: 'success', data: result });
}
