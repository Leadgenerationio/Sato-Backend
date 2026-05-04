import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';
import { getValidToken } from '../integrations/xero/xero-client.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  status: string;
  currency: string;
  // Money fields are returned as strings (matching the DB decimal type) to
  // avoid float precision loss on the wire. Frontend can parseFloat() if it
  // needs a number for display math.
  subtotal: string;
  vatAmount: string;
  total: string;
  dueDate: string;
  paidDate: string | null;
  daysOverdue: number;
  createdAt: string;
  xeroInvoiceId: string | null;
}

export interface InvoiceAttachment {
  key: string;
  name: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  uploadedBy?: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  lineItems: LineItem[];
  chaseCount: number;
  lastChasedAt: string | null;
  clientEmail: string;
  vatRegistered: boolean;
  attachments: InvoiceAttachment[];
}

type InvoiceRow = typeof invoices.$inferSelect;
type ClientRow = typeof clients.$inferSelect;

function invoiceToSummary(row: InvoiceRow, client: ClientRow): InvoiceSummary {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber ?? '',
    clientId: row.clientId,
    clientName: client.companyName,
    status: row.status ?? 'draft',
    currency: row.currency ?? 'GBP',
    subtotal: String(row.subtotal ?? '0'),
    vatAmount: String(row.vatAmount ?? '0'),
    total: String(row.total ?? '0'),
    dueDate: (row.dueDate ?? new Date()).toISOString(),
    paidDate: row.paidDate ? row.paidDate.toISOString() : null,
    daysOverdue: row.daysOverdue ?? 0,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    xeroInvoiceId: row.xeroInvoiceId,
  };
}

function invoiceToDetail(row: InvoiceRow, client: ClientRow): InvoiceDetail {
  return {
    ...invoiceToSummary(row, client),
    lineItems: (row.lineItems as LineItem[] | null) ?? [],
    chaseCount: row.chaseCount ?? 0,
    lastChasedAt: row.lastChasedAt ? row.lastChasedAt.toISOString() : null,
    clientEmail: client.contactEmail ?? '',
    vatRegistered: client.vatRegistered ?? false,
    attachments: (row.attachments as InvoiceAttachment[] | null) ?? [],
  };
}

async function loadClientMap(businessId: string): Promise<Map<string, ClientRow>> {
  const rows = await db.select().from(clients).where(eq(clients.businessId, businessId));
  const map = new Map<string, ClientRow>();
  for (const c of rows) map.set(c.id, c);
  return map;
}

export interface ListInvoicesParams {
  status?: string;
  clientId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ListInvoicesResult {
  items: InvoiceSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Paginated, filter-aware invoice list scoped to the requester's business
 * via JOIN through clients. Filters and pagination are pushed into Postgres
 * so the response cost stays bounded regardless of invoice volume — was
 * previously fetching the whole business's invoices and slicing in JS.
 */
export async function listInvoices(
  requester: AuthPayload,
  params: ListInvoicesParams = {},
): Promise<ListInvoicesResult> {
  const businessId = requester.businessId;
  if (!businessId) return { items: [], total: 0, page: 1, pageSize: 10 };

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.limit ?? 10));
  const offset = (page - 1) * pageSize;

  const filters = [eq(clients.businessId, businessId)];
  if (params.status && params.status !== 'all') {
    filters.push(eq(invoices.status, params.status));
  }
  if (params.clientId) {
    filters.push(eq(invoices.clientId, params.clientId));
  }
  if (params.search) {
    const q = `%${params.search.toLowerCase()}%`;
    filters.push(sql`(
      lower(coalesce(${invoices.invoiceNumber}, '')) like ${q}
      or lower(${clients.companyName}) like ${q}
    )`);
  }
  const whereClause = and(...filters);

  // Page rows, total count, and the client-row map (for invoiceToSummary)
  // run in parallel. The client map is scoped per-business and stays small;
  // bundling the join into the page query is possible but Drizzle's row
  // materialisation is cleaner with the existing helper that already takes
  // a ClientRow.
  const [rows, countResult, clientMap] = await Promise.all([
    db
      .select({ inv: invoices, client: clients })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(whereClause)
      .orderBy(desc(invoices.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(whereClause),
    loadClientMap(businessId),
  ]);

  const items = rows
    .map((r) => {
      const client = clientMap.get(r.inv.clientId) ?? r.client;
      if (!client) return null;
      return invoiceToSummary(r.inv, client);
    })
    .filter((x): x is InvoiceSummary => x !== null);

  return {
    items,
    total: countResult[0]?.n ?? 0,
    page,
    pageSize,
  };
}

export async function getInvoice(id: string, requester: AuthPayload): Promise<InvoiceDetail | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!row) return null;

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, row.clientId), eq(clients.businessId, businessId)));
  if (!client) return null; // client belongs to another business — deny

  return invoiceToDetail(row, client);
}

export async function getOverdueInvoices(requester: AuthPayload): Promise<InvoiceSummary[]> {
  // Push the status='overdue' filter into the SQL via the new paginated
  // listInvoices. Cap at 100 — dashboard doesn't show more than a handful
  // of overdue rows anyway, and we don't want this becoming a slow path.
  const result = await listInvoices(requester, { status: 'overdue', limit: 100 });
  return result.items;
}

export async function createInvoice(
  data: { clientId: string; currency: string; lineItems: LineItem[]; addVat: boolean },
  requester: AuthPayload,
): Promise<InvoiceDetail> {
  const businessId = requester.businessId;
  if (!businessId) throw new Error('No business associated with requester');

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, data.clientId), eq(clients.businessId, businessId)));
  if (!client) throw new Error('Client not found');

  const subtotal = Math.round(data.lineItems.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  const vatAmount = data.addVat ? Math.round(subtotal * 0.2 * 100) / 100 : 0;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;

  // Generate the invoice number from a Postgres SEQUENCE (created in
  // migration 0010_invoice_number_seq.sql). nextval() is atomic and
  // O(1) — no race between concurrent inserts and no full table scan.
  // For prod, Xero will assign its own number when pushed; this is just
  // our local reference.
  const seqResult = await db.execute(sql`SELECT nextval('invoice_number_seq')::int AS n`);
  const seqRows = seqResult as unknown as Array<{ n: number }> & { rows?: Array<{ n: number }> };
  const next = (seqRows.rows ? seqRows.rows[0]?.n : seqRows[0]?.n) ?? 1001;
  const invoiceNumber = `INV-${next}`;

  const [row] = await db
    .insert(invoices)
    .values({
      clientId: data.clientId,
      invoiceNumber,
      status: 'draft',
      currency: data.currency,
      subtotal: String(subtotal),
      vatAmount: String(vatAmount),
      total: String(total),
      dueDate: new Date(Date.now() + 30 * 86_400_000),
      lineItems: data.lineItems,
    })
    .returning();

  return invoiceToDetail(row, client);
}

/**
 * Push a Stato invoice to Xero as a draft. Requires:
 *   - invoice to exist in DB + belong to requester's business
 *   - invoice to have line items
 *   - Xero Custom Connection to be configured (XERO_CLIENT_ID + SECRET)
 *
 * Creates an ACCREC (receivable) invoice in Xero with status DRAFT so Sam
 * can review and approve before it's sent. Stores the Xero-assigned
 * InvoiceID back on our row so a second push is a no-op.
 */
export async function pushInvoiceToXero(invoiceId: string, requester: AuthPayload): Promise<InvoiceDetail> {
  const invoice = await getInvoice(invoiceId, requester);
  if (!invoice) throw new Error('Invoice not found');
  if (invoice.xeroInvoiceId) {
    logger.info({ invoiceId, xeroInvoiceId: invoice.xeroInvoiceId }, 'Invoice already pushed to Xero — no-op');
    return invoice;
  }

  const { accessToken, tenantId } = await getValidToken();

  const due = new Date(invoice.dueDate);
  const body = {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: invoice.clientName ? { Name: invoice.clientName } : undefined,
        Date: new Date().toISOString().slice(0, 10),
        DueDate: due.toISOString().slice(0, 10),
        LineAmountTypes: 'Exclusive' as const,
        LineItems: invoice.lineItems.map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitPrice,
          TaxType: invoice.vatRegistered ? 'OUTPUT2' : 'NONE',
        })),
        Reference: invoice.invoiceNumber,
        Status: 'DRAFT',
        CurrencyCode: invoice.currency,
      },
    ],
  };

  const res = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, body: errText, invoiceId }, 'Xero invoice push failed');
    throw new Error(`Xero push failed: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as { Invoices?: Array<{ InvoiceID: string; InvoiceNumber?: string }> };
  const xeroInv = data.Invoices?.[0];
  if (!xeroInv?.InvoiceID) {
    logger.error({ response: data }, 'Xero returned no InvoiceID');
    throw new Error('Xero returned no InvoiceID');
  }

  const [updated] = await db
    .update(invoices)
    .set({
      xeroInvoiceId: xeroInv.InvoiceID,
      // If Xero assigned its own invoice number, prefer that.
      invoiceNumber: xeroInv.InvoiceNumber ?? invoice.invoiceNumber,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  logger.info(
    { invoiceId, xeroInvoiceId: xeroInv.InvoiceID, invoiceNumber: updated.invoiceNumber },
    'Invoice pushed to Xero',
  );

  const [client] = await db.select().from(clients).where(eq(clients.id, updated.clientId));
  return invoiceToDetail(updated, client);
}

/**
 * Append a file attachment to an invoice. Frontend uploads via signed R2
 * URL first, then calls this with the resulting key + metadata.
 */
export async function addInvoiceAttachment(
  invoiceId: string,
  attachment: Omit<InvoiceAttachment, 'uploadedAt' | 'uploadedBy'>,
  requester: AuthPayload,
): Promise<InvoiceDetail | null> {
  const existing = await getInvoice(invoiceId, requester);
  if (!existing) return null;

  const newItem: InvoiceAttachment = {
    ...attachment,
    uploadedAt: new Date().toISOString(),
    uploadedBy: requester.userId,
  };
  const updated = [...existing.attachments, newItem];

  await db
    .update(invoices)
    .set({ attachments: updated, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));

  logger.info({ invoiceId, key: attachment.key }, 'Invoice attachment added');
  return getInvoice(invoiceId, requester);
}

/** Remove an attachment by key. R2 file is left in place (orphaned). */
export async function removeInvoiceAttachment(
  invoiceId: string,
  key: string,
  requester: AuthPayload,
): Promise<InvoiceDetail | null> {
  const existing = await getInvoice(invoiceId, requester);
  if (!existing) return null;

  const updated = existing.attachments.filter((a) => a.key !== key);
  await db
    .update(invoices)
    .set({ attachments: updated, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));

  logger.info({ invoiceId, key }, 'Invoice attachment removed');
  return getInvoice(invoiceId, requester);
}

/**
 * Simple list of clients for the invoice-creation dropdown. Scoped to the
 * requester's business. Same data the main clients API returns, but shaped
 * minimally for the dropdown.
 */
export async function getInvoiceableClients(requester: AuthPayload): Promise<
  Array<{ id: string; name: string; email: string; vatRegistered: boolean; currency: string }>
> {
  const businessId = requester.businessId;
  if (!businessId) return [];

  const rows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.businessId, businessId), eq(clients.status, 'active')))
    .orderBy(clients.companyName);

  return rows.map((c) => ({
    id: c.id,
    name: c.companyName,
    email: c.contactEmail ?? '',
    vatRegistered: c.vatRegistered ?? false,
    currency: c.currency ?? 'GBP',
  }));
}
