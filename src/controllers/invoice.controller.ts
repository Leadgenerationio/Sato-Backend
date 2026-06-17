import { Request, Response } from 'express';
import { z } from 'zod';
import * as invoiceService from '../services/invoice.service.js';
import { uuidShape } from '../utils/zod-helpers.js';
import { classifyXeroError } from '../utils/xero-errors.js';

const VALID_SORT_BY = new Set(['createdAt', 'dueDate', 'total', 'status', 'invoiceNumber']);

export async function listInvoices(req: Request, res: Response) {
  const rawSortBy = req.query.sortBy as string | undefined;
  const sortBy = rawSortBy && VALID_SORT_BY.has(rawSortBy) ? (rawSortBy as invoiceService.InvoiceSortBy) : undefined;
  const sortDir = req.query.sortDir === 'asc' ? 'asc' : req.query.sortDir === 'desc' ? 'desc' : undefined;

  const result = await invoiceService.listInvoices(req.user!, {
    status: req.query.status as string | undefined,
    clientId: req.query.client as string | undefined,
    search: req.query.search as string | undefined,
    page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    sortBy,
    sortDir,
  });

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

export async function getInvoice(req: Request, res: Response) {
  const invoice = await invoiceService.getInvoice(req.params.id as string, req.user!);
  if (!invoice) {
    res.status(404).json({ status: 'error', message: 'Invoice not found' });
    return;
  }
  res.json({ status: 'success', data: { invoice } });
}

/**
 * Stream the ORIGINAL Xero invoice PDF (Sam, 2026-06-17). Not a Stato-rendered
 * lookalike — the exact document Xero issued, fetched live from Xero. 404 when
 * the invoice doesn't exist; 409 when it's a local draft never pushed to Xero;
 * Xero/transport failures are classified the same way as push-to-Xero.
 */
export async function downloadInvoicePdf(req: Request, res: Response) {
  try {
    const result = await invoiceService.getInvoicePdf(req.params.id as string, req.user!);
    if (!result) {
      res.status(404).json({ status: 'error', message: 'Invoice not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', String(result.pdf.length));
    res.send(result.pdf);
  } catch (err) {
    if (err instanceof invoiceService.InvoiceNotInXeroError) {
      res.status(409).json({ status: 'error', code: 'not_in_xero', message: err.message });
      return;
    }
    const classified = classifyXeroError(err);
    res.status(classified.httpStatus).json({
      status: 'error',
      code: classified.code,
      message: classified.message,
    });
  }
}

export async function getOverdue(req: Request, res: Response) {
  const invoices = await invoiceService.getOverdueInvoices(req.user!);
  res.json({ status: 'success', data: { invoices } });
}

export async function getOutstanding(req: Request, res: Response) {
  const raw = String(req.query.bucket ?? 'all').toLowerCase();
  const bucket: invoiceService.OutstandingBucket =
    raw === 'due' || raw === 'overdue' ? raw : 'all';
  const result = await invoiceService.getOutstandingInvoices(req.user!, bucket);
  res.json({
    status: 'success',
    data: {
      bucket,
      invoices: result.invoices,
      count: result.count,
      totalOutstanding: result.totalOutstanding,
    },
  });
}

export const createInvoiceSchema = z.object({
  body: z.object({
    clientId: uuidShape(),
    currency: z.string().length(3),
    lineItems: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      )
      .min(1),
    addVat: z.boolean(),
  }),
});

export async function createInvoice(req: Request, res: Response) {
  const { clientId, currency, lineItems, addVat } = req.body;
  // Compute amount per line on the server to avoid trusting client-side math.
  const itemsWithAmount = (lineItems as Array<{ description: string; quantity: number; unitPrice: number }>).map(
    (li) => ({
      ...li,
      amount: Math.round(li.quantity * li.unitPrice * 100) / 100,
    }),
  );
  const invoice = await invoiceService.createInvoice(
    { clientId, currency, lineItems: itemsWithAmount, addVat },
    req.user!,
  );
  res.status(201).json({ status: 'success', data: { invoice } });
}

export async function getClients(req: Request, res: Response) {
  const clients = await invoiceService.getInvoiceableClients(req.user!);
  res.json({ status: 'success', data: { clients } });
}

export async function pushToXero(req: Request, res: Response) {
  try {
    const invoice = await invoiceService.pushInvoiceToXero(req.params.id as string, req.user!);
    res.json({ status: 'success', data: { invoice } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Push to Xero failed';
    if (msg.includes('not found')) {
      res.status(404).json({ status: 'error', code: 'not_found', message: msg });
      return;
    }
    const classified = classifyXeroError(err);
    res.status(classified.httpStatus).json({
      status: 'error',
      code: classified.code,
      message: classified.message,
    });
  }
}

const attachmentSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export async function addAttachment(req: Request, res: Response) {
  const parsed = attachmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const invoice = await invoiceService.addInvoiceAttachment(req.params.id as string, parsed.data, req.user!);
  if (!invoice) {
    res.status(404).json({ status: 'error', message: 'Invoice not found' });
    return;
  }
  res.json({ status: 'success', data: { invoice } });
}

export async function removeAttachment(req: Request, res: Response) {
  const id = req.params.id as string;
  const key = decodeURIComponent(req.params.key as string);
  const invoice = await invoiceService.removeInvoiceAttachment(id, key, req.user!);
  if (!invoice) {
    res.status(404).json({ status: 'error', message: 'Invoice not found' });
    return;
  }
  res.json({ status: 'success', data: { invoice } });
}
