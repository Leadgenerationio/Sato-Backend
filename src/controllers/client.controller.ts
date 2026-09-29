import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import * as clientService from '../services/client.service.js';
import * as userService from '../services/user.service.js';
import { logger } from '../utils/logger.js';
import { NotFoundError } from '../utils/errors.js';

interface CreateContactBody { contactType?: string; name?: string; email?: string }

function listFilters(req: Request) {
  return {
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
    currency: req.query.currency as string | undefined,
    country: req.query.country as string | undefined,
    addedBy: req.query.addedBy as string | undefined,
    sort: req.query.sort as clientService.ClientSortKey | undefined,
    dir: req.query.dir as 'asc' | 'desc' | undefined,
  };
}

export async function listClients(req: Request, res: Response) {
  const result = await clientService.listClients(req.user!, {
    ...listFilters(req),
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

// S14: options for the "Added by" filter.
export async function listAddedByOptions(req: Request, res: Response) {
  const options = await clientService.listAddedByOptions(req.user!);
  res.json({ status: 'success', data: { options } });
}

// Feedback S14: CSV of the filtered + sorted list (same filters as GET /).
export async function exportClientsCsv(req: Request, res: Response) {
  const { csv, count, truncated } = await clientService.exportClientsCsv(req.user!, listFilters(req));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clients-${stamp}.csv"`);
  res.setHeader('X-Row-Count', String(count));
  if (truncated) res.setHeader('X-Truncated', 'true');
  // BOM so Excel opens £/€ and accented company names correctly.
  res.send('\uFEFF' + csv);
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

  // Sam (2026-06-19): onboard the primary contact automatically — create a
  // portal login for their email and send the branded welcome. Best-effort:
  // never fail client creation if there's no contact email, the email already
  // has a login, or the send fails.
  try {
    const contacts: CreateContactBody[] = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    const primary = contacts.find((c) => c?.contactType === 'primary') ?? contacts[0];
    const contactEmail = String(req.body.contactEmail ?? primary?.email ?? '').trim();
    const contactName = String(primary?.name ?? req.body.contactName ?? 'Client').trim() || 'Client';
    if (contactEmail) {
      const tempPassword = randomBytes(18).toString('base64url');
      const portalUser = await userService.createUser(
        contactEmail, contactName, tempPassword, 'client', req.user!, client.id,
      );
      await userService.sendWelcomeEmail(portalUser.id, req.user!);
    }
  } catch (err) {
    logger.error({ err, clientId: client.id }, 'Auto portal-user onboarding failed on client create');
  }

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
