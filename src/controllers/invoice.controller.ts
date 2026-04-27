import { Request, Response } from 'express';
import { z } from 'zod';
import * as invoiceService from '../services/invoice.service.js';

export async function listInvoices(req: Request, res: Response) {
  let invoices = await invoiceService.listInvoices(req.user!);

  const { status, client, search } = req.query;
  if (status && status !== 'all') {
    invoices = invoices.filter((inv) => inv.status === status);
  }
  if (client) {
    invoices = invoices.filter((inv) => inv.clientId === client);
  }
  if (search) {
    const q = (search as string).toLowerCase();
    invoices = invoices.filter((inv) =>
      inv.invoiceNumber.toLowerCase().includes(q) || inv.clientName.toLowerCase().includes(q),
    );
  }

  // Pagination
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const total = invoices.length;
  const start = (page - 1) * limit;
  const items = invoices.slice(start, start + limit);

  res.json({ status: 'success', data: { invoices: items, total, page, pageSize: limit } });
}

export async function getInvoice(req: Request, res: Response) {
  const invoice = await invoiceService.getInvoice(req.params.id as string, req.user!);
  if (!invoice) {
    res.status(404).json({ status: 'error', message: 'Invoice not found' });
    return;
  }
  res.json({ status: 'success', data: { invoice } });
}

export async function getOverdue(req: Request, res: Response) {
  const invoices = await invoiceService.getOverdueInvoices(req.user!);
  res.json({ status: 'success', data: { invoices } });
}

export async function createInvoice(req: Request, res: Response) {
  const { clientId, currency, lineItems, addVat } = req.body;
  const invoice = await invoiceService.createInvoice({ clientId, currency, lineItems, addVat }, req.user!);
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
      res.status(404).json({ status: 'error', message: msg });
      return;
    }
    res.status(502).json({ status: 'error', message: msg });
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
