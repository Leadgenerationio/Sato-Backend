import { Request, Response } from 'express';
import * as dashboardService from '../services/dashboard.service.js';

export async function leadsByDay(req: Request, res: Response) {
  const days = req.query.days ? Number(req.query.days) : 7;
  const data = await dashboardService.getLeadsByDay(req.user!, days);
  res.json({ status: 'success', data: { points: data } });
}

export async function recentActivity(req: Request, res: Response) {
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  const data = await dashboardService.getRecentActivity(req.user!, limit);
  res.json({ status: 'success', data: { items: data } });
}
