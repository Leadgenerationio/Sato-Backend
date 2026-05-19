import { Request, Response } from 'express';
import * as dashboardService from '../services/dashboard.service.js';
import { parseDashboardWindow } from '../utils/dashboard-window.js';

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

export async function stats(req: Request, res: Response) {
  // Optional `?window=this_week|this_month|last_month|last_90d|last_6m|last_year`
  // — pivots the Leads tile + trend chip. Unknown / missing values fall back
  // to 'this_month' so legacy callers see the exact same response.
  const leadsWindow = parseDashboardWindow(req.query.window) ?? undefined;
  const data = await dashboardService.getDashboardStats(req.user!, { leadsWindow });
  res.json({ status: 'success', data });
}
