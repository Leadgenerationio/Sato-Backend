import { Request, Response } from 'express';
import * as sopService from '../services/sop.service.js';

export async function listSops(req: Request, res: Response) {
  const { category, search, status } = req.query;

  const filters: sopService.SopFilters = {};
  if (category) filters.category = category as string;
  if (search) filters.search = search as string;
  if (status) filters.status = status as string;

  let sops = await sopService.listSops(req.user!, filters);

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const total = sops.length;
  const start = (page - 1) * limit;
  const items = sops.slice(start, start + limit);

  res.json({ status: 'success', data: { sops: items, total, page, pageSize: limit } });
}

export async function getSop(req: Request, res: Response) {
  const sop = await sopService.getSop(req.params.id);
  if (!sop) {
    res.status(404).json({ status: 'error', message: 'SOP not found' });
    return;
  }
  res.json({ status: 'success', data: { sop } });
}

export async function createSop(req: Request, res: Response) {
  const sop = await sopService.createSop(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { sop } });
}

export async function updateSop(req: Request, res: Response) {
  const sop = await sopService.updateSop(req.params.id, req.body);
  if (!sop) {
    res.status(404).json({ status: 'error', message: 'SOP not found' });
    return;
  }
  res.json({ status: 'success', data: { sop } });
}
