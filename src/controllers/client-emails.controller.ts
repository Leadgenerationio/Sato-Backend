import { Request, Response } from 'express';
import * as emailsService from '../services/client-emails.service.js';

export async function listEmails(req: Request, res: Response) {
  const limit = parseInt(req.query.limit as string) || 50;
  const direction = (req.query.direction as 'inbound' | 'outbound') || undefined;
  const emails = await emailsService.listClientEmails(req.params.id as string, { limit, direction });
  res.json({ status: 'success', data: { emails } });
}

export async function logEmail(req: Request, res: Response) {
  const { direction, subject, body, fromAddress, toAddress, occurredAt } = req.body ?? {};
  if (direction !== 'inbound' && direction !== 'outbound') {
    res.status(400).json({ status: 'error', message: 'direction must be "inbound" or "outbound"' });
    return;
  }
  const row = await emailsService.logClientEmail(
    req.params.id as string,
    { direction, subject, body, fromAddress, toAddress, occurredAt },
    req.user!,
  );
  res.status(201).json({ status: 'success', data: { email: row } });
}

export async function deleteEmail(req: Request, res: Response) {
  const ok = await emailsService.deleteClientEmail(
    req.params.id as string,
    req.params.emailId as string,
    req.user!,
  );
  if (!ok) {
    res.status(404).json({ status: 'error', message: 'Email not found' });
    return;
  }
  res.json({ status: 'success', data: {} });
}
