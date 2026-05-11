import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import * as invoiceService from '../services/invoice.service.js';
import { logger } from '../utils/logger.js';

/**
 * GET /api/v1/clients/:id/invoices
 *
 * Sam's Loom #30: the client detail page should list this client's invoices
 * instead of just linking off to the main invoices page. We reuse the existing
 * invoice.service listInvoices() with a clientId filter — same pagination,
 * scoping, and shape as `/invoices?client=<id>` but a cleaner URL and a
 * pre-flight client-existence check so out-of-scope clients return 404 rather
 * than an empty list (matches the documents endpoint behaviour).
 */
export async function listForClient(req: Request, res: Response) {
  const clientId = req.params.id as string;
  const businessId = req.user!.businessId;
  if (!businessId) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }

  // Existence + scope check. Without this an out-of-scope client would
  // silently return [] which is ambiguous with "client has no invoices yet".
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));
  if (!client) {
    res.status(404).json({ status: 'error', message: 'Client not found' });
    return;
  }

  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const result = await invoiceService.listInvoices(req.user!, { clientId, page, limit });
  res.json({
    status: 'success',
    data: {
      invoices: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    },
  });
}

/**
 * POST /api/v1/clients/:id/sync-invoices
 *
 * Sam's Loom #32: pull invoices from Xero for this client. Auto-links the
 * Xero contact by name if it hasn't been linked yet, then imports any
 * invoices that aren't already in our DB.
 */
export async function syncForClient(req: Request, res: Response) {
  const clientId = req.params.id as string;
  try {
    const result = await invoiceService.syncInvoicesFromXero(clientId, req.user!);
    if (!result) {
      res.status(404).json({ status: 'error', message: 'Client not found' });
      return;
    }
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error({ err, clientId }, 'Sync invoices from Xero failed');
    res.status(502).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'Failed to sync from Xero',
    });
  }
}
