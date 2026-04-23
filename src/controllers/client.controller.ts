import { Request, Response } from 'express';
import * as clientService from '../services/client.service.js';

export async function listClients(req: Request, res: Response) {
  let clients = await clientService.listClients(req.user!);

  const { status, search } = req.query;
  if (status && status !== 'all') {
    clients = clients.filter((c) => c.status === status);
  }
  if (search) {
    const q = (search as string).toLowerCase();
    clients = clients.filter((c) =>
      c.companyName.toLowerCase().includes(q) || c.contactName.toLowerCase().includes(q) || c.contactEmail.toLowerCase().includes(q),
    );
  }

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const total = clients.length;
  const start = (page - 1) * limit;
  const items = clients.slice(start, start + limit);

  res.json({ status: 'success', data: { clients: items, total, page, pageSize: limit } });
}

export async function getClient(req: Request, res: Response) {
  const client = await clientService.getClient(req.params.id as string, req.user!);
  if (!client) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { client } });
}

export async function createClient(req: Request, res: Response) {
  const client = await clientService.createClient(req.body, req.user!);
  res.status(201).json({ status: 'success', data: { client } });
}

export async function updateClient(req: Request, res: Response) {
  const client = await clientService.updateClient(req.params.id as string, req.body, req.user!);
  if (!client) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { client } });
}

export async function getCreditHistory(req: Request, res: Response) {
  const history = await clientService.getCreditHistory(req.params.id as string, req.user!);
  res.json({ status: 'success', data: { history } });
}

export async function runCreditCheck(req: Request, res: Response) {
  const result = await clientService.runCreditCheck(req.params.id as string, req.user!);
  if (!result) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { creditCheck: result } });
}

export async function getCreditAlerts(req: Request, res: Response) {
  const alerts = await clientService.getCreditAlerts(req.user!);
  res.json({ status: 'success', data: { alerts } });
}
