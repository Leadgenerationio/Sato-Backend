import { Request, Response } from 'express';
import * as clientService from '../services/client.service.js';
import { NotFoundError } from '../utils/errors.js';

export async function listClients(req: Request, res: Response) {
  const result = await clientService.listClients(req.user!, {
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
    page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  });

  res.json({
    status: 'success',
    data: {
      clients: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    },
  });
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

export async function deleteClient(req: Request, res: Response) {
  const deleted = await clientService.deleteClient(req.params.id as string, req.user!);
  if (!deleted) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }
  res.json({ status: 'success', data: { deleted: true } });
}

export async function getCreditHistory(req: Request, res: Response) {
  const clientId = req.params.id as string;
  // Confirm the client belongs to the caller's business before exposing
  // credit history. getClient() already scopes by businessId, so a null
  // result means the row is either missing or out-of-scope — both should
  // be hidden from the caller.
  const client = await clientService.getClient(clientId, req.user!);
  if (!client) {
    throw new NotFoundError('Client');
  }
  const history = await clientService.getCreditHistory(clientId, req.user!);
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
