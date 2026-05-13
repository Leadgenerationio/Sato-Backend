import type { Request, Response } from 'express';
import * as service from '../services/agreement-template.service.js';

export async function list(req: Request, res: Response) {
  const templates = await service.listTemplates(req.user!);
  res.json({ status: 'success', data: { templates } });
}

export async function get(req: Request, res: Response) {
  const template = await service.getTemplate(req.params.id as string, req.user!);
  if (!template) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.json({ status: 'success', data: { template } });
}

export async function create(req: Request, res: Response) {
  const template = await service.createTemplate(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { template } });
}

export async function update(req: Request, res: Response) {
  const template = await service.updateTemplate(req.params.id as string, req.body, req.user!);
  if (!template) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.json({ status: 'success', data: { template } });
}

export async function archive(req: Request, res: Response) {
  const ok = await service.archiveTemplate(req.params.id as string, req.user!);
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.status(204).end();
}

export async function duplicate(req: Request, res: Response) {
  const template = await service.duplicateTemplate(req.params.id as string, req.user!);
  if (!template) {
    res.status(404).json({ status: 'error', message: 'Template not found' });
    return;
  }
  res.status(201).json({ status: 'success', data: { template } });
}

export async function preview(_req: Request, res: Response) {
  // Wired in Day 2 — return 501 for Day 1
  res.status(501).json({ status: 'error', message: 'Preview endpoint not yet implemented' });
}
