import { Request, Response } from 'express';
import * as notificationService from '../services/notification.service.js';

export async function listNotifications(req: Request, res: Response) {
  const result = await notificationService.listNotifications(req.user!, {
    unreadOnly: req.query.filter === 'unread',
    page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  });

  res.json({
    status: 'success',
    data: {
      notifications: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    },
  });
}

export async function markAsRead(req: Request, res: Response) {
  if (!req.user?.userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId on request' });
    return;
  }
  const notification = await notificationService.markAsRead(req.params.id as string, req.user);

  if (!notification) {
    res.status(404).json({ status: 'error', message: 'Notification not found' });
    return;
  }

  res.json({ status: 'success', data: { notification } });
}

export async function markAllAsRead(req: Request, res: Response) {
  if (!req.user?.userId) {
    res.status(400).json({ status: 'error', message: 'Missing userId on request' });
    return;
  }
  const result = await notificationService.markAllAsRead(req.user);
  res.json({ status: 'success', data: result });
}
