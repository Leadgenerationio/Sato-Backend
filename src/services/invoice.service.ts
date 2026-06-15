import { and, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invoices } from '../db/schema/invoices.js';
import { clients } from '../db/schema/clients.js';
import {
  getValidToken,
  getInvoicesForContact,
  findContactByName,
  isXeroConfigured,
  type XeroInvoice,
} from '../integrations/xero/xero-client.js';
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

/**
 * Sam Loom #6: an invoice that's past its due date but still stored with
 * Xero's `authorised` (or `sent`) status should display as "overdue". Stored
 * `status` only flips to 'overdue' when an external sync runs, but the
 * dashboard / list views need the live derived value so the badge matches
 * reality. Re-compute `daysOverdue` from `dueDate` for the same reason —
 * the stored column can go stale between cron runs.
 */
export function computeDaysOverdue(dueDate: Date | null, paidDate: Date | null, status: string | null): number {
  if (paidDate || status === 'paid') return 0;
  if (!dueDate) return 0;
  const diffMs = Date.now() - dueDate.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  return days > 0 ? days : 0;
}

export function deriveDisplayStatus(storedStatus: string | null, daysOverdue: number): string {
  const s = storedStatus ?? 'draft';
  if (s === 'paid' || s === 'overdue' || s === 'draft') return s;
  // 'sent' or 'authorised' but past due → present as 'overdue' to the UI.
  if ((s === 'sent' || s === 'authorised') && daysOverdue > 0) return 'overdue';
  return s;
}

// T5 (Sam, 2026-05-20): structural defense against the 2026-05-20 £44k
// portal-Outstanding inflation. The root cause: an unpushed draft auto-
// invoice run had its row written with status='sent' even though it was
// never actually pushed to Xero (xero_invoice_id was null). The previous
// outstanding filter checked only `status IN ('sent','authorised',
// 'overdue')`, so the orphan leaked.
//
// Rule: an invoice is "outstanding" only when (a) its status is in the
// outstanding bucket AND (b) it has actually been pushed to Xero (i.e.
// xero_invoice_id IS NOT NULL). Rows that exist in Stato but were never
// pushed to Xero are workflow noise — they show up nowhere in the
// customer-visible aggregations.
//
// `isOutstandingInvoiceWhere()` returns the Drizzle SQL fragment used by
// every aggregation site. `isOutstandingInvoice(row)` is the JS-side
// equivalent for portal.service.getDashboard which filters in-memory.
// Keep them in lock-step — both must change together.
const OUTSTANDING_STATUSES = ['sent', 'authorised', 'overdue', 'submitted'] as const;

// Fix #8/#9 (2026-06-15): the admin Finance list and Client Detail invoices
// tab were leaking DRAFT invoices, which Sam repeatedly asked us not to show
// (drafts are pre-authorisation work-in-progress, and unpushed local drafts
// with no xero_invoice_id are pure workflow noise). Mirror the portal's hidden
// set so the admin default list is consistent with the dashboard "outstanding"
// surfaces (which already exclude drafts + require xeroInvoiceId IS NOT NULL).
// The default list still differs from the dashboard in that it shows paid
// invoices — that's intentional; the consistency we enforce is "no drafts".
// Someone who explicitly filters to status:'draft' still sees them.
export const INVOICE_LIST_HIDDEN_STATUSES = ['draft', 'voided', 'deleted'] as const;

export function isOutstandingInvoiceWhere() {
  return and(
    inArray(invoices.status, [...OUTSTANDING_STATUSES]),
    isNotNull(invoices.xeroInvoiceId),
  );
}

/**
 * JS-side equivalent of `isOutstandingInvoiceWhere()`. Used by callers that
 * have already loaded rows and need to filter in-memory (portal.service.
 * getDashboard does this so the same `invoiceRows` lookup feeds several
 * tiles without an extra round-trip).
 */
export function isOutstandingInvoice(row: {
  status: string | null;
  xeroInvoiceId: string | null;
}): boolean {
  if (!row.xeroInvoiceId) return false;
  const s = (row.status ?? '').toLowerCase();
  return (OUTSTANDING_STATUSES as readonly string[]).includes(s);
}

function invoiceToSummary(row: InvoiceRow, client: ClientRow): InvoiceSummary {
  const liveDaysOverdue = computeDaysOverdue(row.dueDate ?? null, row.paidDate ?? null, row.status);
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber ?? '',
    clientId: row.clientId,
    clientName: client.companyName,
    status: deriveDisplayStatus(row.status, liveDaysOverdue),
    currency: row.currency ?? 'GBP',
    subtotal: String(row.subtotal ?? '0'),
    vatAmount: String(row.vatAmount ?? '0'),
    total: String(row.total ?? '0'),
    dueDate: (row.dueDate ?? new Date()).toISOString(),
    paidDate: row.paidDate ? row.paidDate.toISOString() : null,
    daysOverdue: liveDaysOverdue,
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

export type InvoiceSortBy = 'createdAt' | 'dueDate' | 'total' | 'status' | 'invoiceNumber';
export type SortDir = 'asc' | 'desc';

export interface ListInvoicesParams {
  status?: string;
  clientId?: string;
  search?: string;
  page?: number;
  limit?: number;
  /** Sam Loom #7 — column-header sorting on /finance/invoices. */
  sortBy?: InvoiceSortBy;
  sortDir?: SortDir;
}

const SORT_COLUMNS = {
  createdAt: invoices.createdAt,
  dueDate: invoices.dueDate,
  total: invoices.total,
  status: invoices.status,
  invoiceNumber: invoices.invoiceNumber,
} as const;

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
  // Fix #8/#9: by default exclude draft/voided/deleted from the admin Finance
  // list + Client Detail invoices tab. Only when the caller explicitly asks
  // for one of those hidden statuses do we surface it (the "Drafts" tab).
  const wantsHiddenStatus =
    !!params.status &&
    params.status !== 'all' &&
    (INVOICE_LIST_HIDDEN_STATUSES as readonly string[]).includes(params.status);
  if (!wantsHiddenStatus) {
    filters.push(notInArray(invoices.status, [...INVOICE_LIST_HIDDEN_STATUSES]));
  }
  if (params.status && params.status !== 'all') {
    // #6: the stored `status` doesn't auto-flip when an invoice crosses
    // its due date, so the SQL filter expands to match what the UI labels
    // the row as. Late sent/authorised count as overdue; non-late
    // sent/authorised count as their stored bucket.
    if (params.status === 'overdue') {
      filters.push(sql`(
        ${invoices.status} = 'overdue'
        OR (
          ${invoices.status} IN ('sent', 'authorised')
          AND ${invoices.paidDate} IS NULL
          AND ${invoices.dueDate} IS NOT NULL
          AND ${invoices.dueDate} < now()
        )
      )`);
      // T5: an unpushed draft must never count toward "overdue" — that's
      // how chase-overdue emails get sent for invoices that don't actually
      // exist in Xero. Guard the bucket structurally.
      filters.push(isNotNull(invoices.xeroInvoiceId));
    } else if (params.status === 'sent' || params.status === 'authorised') {
      filters.push(sql`(
        ${invoices.status} = ${params.status}
        AND (${invoices.dueDate} IS NULL OR ${invoices.dueDate} >= now() OR ${invoices.paidDate} IS NOT NULL)
      )`);
      // T5: same guard for the due bucket — unpushed sent/authorised rows
      // are workflow noise, never customer-visible.
      filters.push(isNotNull(invoices.xeroInvoiceId));
    } else {
      filters.push(eq(invoices.status, params.status));
    }
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

  // Whitelist sortBy to a known column so a hostile query param can't be
  // used to ORDER BY arbitrary expressions. Default: createdAt DESC (matches
  // historical behaviour).
  const sortColumn = params.sortBy && SORT_COLUMNS[params.sortBy] ? SORT_COLUMNS[params.sortBy] : invoices.createdAt;
  const sortOrder = params.sortDir === 'asc' ? sortColumn : desc(sortColumn);

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
      .orderBy(sortOrder)
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

// ─── Sync from Xero (Sam Loom #32) ─────────────────────────────────────────
//
// "Where's his invoice? How do I connect his invoices?" — invoices created
// directly in Xero (before Stato existed for this client) weren't appearing
// on the client's Invoices tab. This sync flow:
//   1. Confirms the Stato client has a linked xero_contact_id; if missing,
//      attempts to auto-link by exact company-name match in Xero.
//   2. Pulls all ACCREC (customer) invoices for that contact.
//   3. Inserts each into the local invoices table, skipping any whose
//      xero_invoice_id already exists (idempotent — safe to re-sync).

export interface SyncInvoicesResult {
  synced: number;       // new invoices imported on this call
  skipped: number;      // already-imported invoices (dedup by xeroInvoiceId)
  updated?: number;     // existing invoices whose mutable fields were re-synced (Fix #7)
  totalRemote: number;  // total found in Xero for this contact
  linkedContact: boolean; // did we just auto-link the xeroContactId?
  message?: string;     // optional human-readable summary, e.g. "no Xero contact"
}

/**
 * Map a Xero invoice status to our local enum. Xero values are uppercase;
 * Stato stores lowercase. VOIDED maps to 'draft' so we keep the row visible
 * but don't treat it as chaseable.
 */
function mapXeroStatus(s: string): string {
  const up = s.toUpperCase();
  switch (up) {
    case 'AUTHORISED': return 'authorised';
    case 'PAID': return 'paid';
    case 'SUBMITTED': return 'sent';
    case 'DRAFT': return 'draft';
    case 'VOIDED':
    case 'DELETED': return 'draft';
    default: return 'draft';
  }
}

function daysOverdue(dueDateIso: string | null, status: string): number {
  if (!dueDateIso || status === 'paid') return 0;
  const due = new Date(dueDateIso).getTime();
  const now = Date.now();
  const days = Math.floor((now - due) / (24 * 60 * 60 * 1000));
  return days > 0 ? days : 0;
}

export async function syncInvoicesFromXero(
  clientId: string,
  requester: AuthPayload,
): Promise<SyncInvoicesResult | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));
  if (!client) return null;

  if (!isXeroConfigured()) {
    return { synced: 0, skipped: 0, totalRemote: 0, linkedContact: false, message: 'Xero not configured' };
  }

  // Resolve Xero contact ID. If the client doesn't have one yet, try to find
  // it by exact name — covers the common case where Sam already had this
  // company in Xero before creating the Stato client.
  let xeroContactId = client.xeroContactId;
  let linkedContact = false;
  if (!xeroContactId) {
    try {
      const found = await findContactByName(client.companyName);
      if (found) {
        xeroContactId = found.contactId;
        await db
          .update(clients)
          .set({ xeroContactId, updatedAt: new Date() })
          .where(eq(clients.id, clientId));
        linkedContact = true;
        logger.info({ clientId, xeroContactId, name: client.companyName }, 'Auto-linked Xero contact by name');
      }
    } catch (err) {
      logger.warn({ err, clientId }, 'Xero contact name search failed — continuing without link');
    }
  }

  if (!xeroContactId) {
    return {
      synced: 0,
      skipped: 0,
      totalRemote: 0,
      linkedContact: false,
      message: `Couldn't find "${client.companyName}" in Xero. Create the contact in Xero first, then retry.`,
    };
  }

  let xeroInvoices: XeroInvoice[];
  try {
    xeroInvoices = await getInvoicesForContact(xeroContactId);
  } catch (err) {
    logger.error({ err, clientId, xeroContactId }, 'Xero invoice fetch failed');
    throw new Error('Failed to fetch invoices from Xero');
  }

  if (xeroInvoices.length === 0) {
    return { synced: 0, skipped: 0, totalRemote: 0, linkedContact, message: 'No invoices found in Xero for this contact' };
  }

  // Dedupe: find which Xero invoice IDs are already in our DB.
  const remoteIds = xeroInvoices.map((i) => i.xeroInvoiceId);
  const existingRows = await db
    .select({ xeroInvoiceId: invoices.xeroInvoiceId })
    .from(invoices)
    .where(inArray(invoices.xeroInvoiceId, remoteIds));
  const existing = new Set(existingRows.map((r) => r.xeroInvoiceId).filter((v): v is string => !!v));

  const toInsert = xeroInvoices.filter((i) => !existing.has(i.xeroInvoiceId));
  if (toInsert.length > 0) {
    await db.insert(invoices).values(
      toInsert.map((i) => ({
        clientId,
        xeroInvoiceId: i.xeroInvoiceId,
        invoiceNumber: i.invoiceNumber,
        status: mapXeroStatus(i.status),
        currency: i.currency,
        subtotal: i.subtotal,
        vatAmount: i.totalTax,
        total: i.total,
        dueDate: i.dueDate ? new Date(i.dueDate) : null,
        // Mark as paid right away if Xero says so — we don't have a
        // separate "paid date" from Xero on the wire, use today as best-effort.
        paidDate: mapXeroStatus(i.status) === 'paid' ? new Date() : null,
        daysOverdue: daysOverdue(i.dueDate, mapXeroStatus(i.status)),
      })),
    );
  }

  // Fix #7 (2026-06-15): the sync was insert-only — it never re-synced
  // invoices already in the DB. So when an invoice was PAID in Xero it stayed
  // 'overdue'/'authorised' in Stato forever (deriveDisplayStatus kept showing
  // it overdue). Re-sync the mutable fields (status, due date, amounts, paid
  // date) for every existing invoice so paid/voided state flips through.
  const toUpdate = xeroInvoices.filter((i) => existing.has(i.xeroInvoiceId));
  let updated = 0;
  for (const i of toUpdate) {
    const status = mapXeroStatus(i.status);
    const [row] = await db
      .update(invoices)
      .set({
        invoiceNumber: i.invoiceNumber,
        status,
        currency: i.currency,
        // Money stays decimal-on-the-wire (string), never floated.
        subtotal: i.subtotal,
        vatAmount: i.totalTax,
        total: i.total,
        dueDate: i.dueDate ? new Date(i.dueDate) : null,
        // Stamp a paidDate when Xero now reports paid and we don't have one;
        // clear it if Xero moved the invoice back out of paid.
        paidDate: status === 'paid' ? new Date() : null,
        daysOverdue: daysOverdue(i.dueDate, status),
        updatedAt: new Date(),
      })
      .where(eq(invoices.xeroInvoiceId, i.xeroInvoiceId))
      .returning({ id: invoices.id });
    if (row) updated += 1;
  }

  return {
    synced: toInsert.length,
    skipped: xeroInvoices.length - toInsert.length,
    updated,
    totalRemote: xeroInvoices.length,
    linkedContact,
  };
}

// ─── Outstanding (Sam Loom #4/#5/#6) ───────────────────────────────────────
//
// "Invoices Owed In" — every invoice still awaiting payment. Kept separate
// from getOverdueInvoices() so the chase-overdue cron keeps its narrower
// semantics — we never want to chase a sent-but-not-yet-late invoice.

export type OutstandingBucket = 'all' | 'due' | 'overdue';

export interface OutstandingInvoicesResult {
  invoices: InvoiceSummary[];
  count: number;
  totalOutstanding: string; // decimal-on-the-wire
}

/**
 *   bucket='all'     → every outstanding invoice (sent, authorised, overdue) ← dashboard default
 *   bucket='due'     → sent/authorised AND not past due date                 ← awaiting payment
 *   bucket='overdue' → status='overdue' OR (sent/authorised AND past due)    ← treat late as overdue
 *
 * Excludes 'draft' and 'paid'. The bucket logic mirrors `invoiceToSummary`'s
 * display-status derivation (#6): the stored `status` doesn't auto-flip when
 * an invoice crosses its due date, so we expand the SQL filter to match what
 * the UI labels each row as.
 */
export async function getOutstandingInvoices(
  requester: AuthPayload,
  bucket: OutstandingBucket = 'all',
): Promise<OutstandingInvoicesResult> {
  const businessId = requester.businessId;
  if (!businessId) return { invoices: [], count: 0, totalOutstanding: '0' };

  const bucketFilter =
    bucket === 'overdue'
      ? sql`(
          ${invoices.status} = 'overdue'
          OR (
            ${invoices.status} IN ('sent', 'authorised')
            AND ${invoices.paidDate} IS NULL
            AND ${invoices.dueDate} IS NOT NULL
            AND ${invoices.dueDate} < now()
          )
        )`
      : bucket === 'due'
      ? sql`(
          ${invoices.status} IN ('sent', 'authorised')
          AND (${invoices.dueDate} IS NULL OR ${invoices.dueDate} >= now() OR ${invoices.paidDate} IS NOT NULL)
        )`
      : inArray(invoices.status, ['sent', 'authorised', 'overdue']);

  // T5 (Sam, 2026-05-20): the structural guard — every bucket excludes
  // rows that were never pushed to Xero (xero_invoice_id IS NULL). See
  // isOutstandingInvoiceWhere() docstring for the £44k incident this
  // protects against.
  const whereClause = and(
    eq(clients.businessId, businessId),
    bucketFilter,
    isNotNull(invoices.xeroInvoiceId),
  );

  const [rows, summaryResult, clientMap] = await Promise.all([
    db
      .select({ inv: invoices, client: clients })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(whereClause)
      .orderBy(desc(invoices.dueDate))
      .limit(100),
    db
      .select({
        n: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${invoices.total}), 0)::text`,
      })
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
    invoices: items,
    count: summaryResult[0]?.n ?? 0,
    totalOutstanding: summaryResult[0]?.total ?? '0',
  };
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
 *
 * Optimised from a 5-query path (getInvoice ×2 → update → getInvoice ×2)
 * to 2 queries: a single SELECT-with-authz-join, then UPDATE...RETURNING.
 */
export async function addInvoiceAttachment(
  invoiceId: string,
  attachment: Omit<InvoiceAttachment, 'uploadedAt' | 'uploadedBy'>,
  requester: AuthPayload,
): Promise<InvoiceDetail | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  // SELECT invoice + client in one query, with business scoping enforced
  // via the JOIN. Returns null if invoice doesn't exist OR belongs to
  // another business.
  const [row] = await db
    .select({ inv: invoices, client: clients })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(eq(invoices.id, invoiceId), eq(clients.businessId, businessId)));
  if (!row) return null;

  const existingAttachments = (row.inv.attachments as InvoiceAttachment[] | null) ?? [];
  const newItem: InvoiceAttachment = {
    ...attachment,
    uploadedAt: new Date().toISOString(),
    uploadedBy: requester.userId,
  };
  const updatedAttachments = [...existingAttachments, newItem];

  // UPDATE...RETURNING gives us the fresh row in one round-trip.
  const [updated] = await db
    .update(invoices)
    .set({ attachments: updatedAttachments, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId))
    .returning();

  logger.info({ invoiceId, key: attachment.key }, 'Invoice attachment added');
  return invoiceToDetail(updated, row.client);
}

/**
 * Remove an attachment by key. R2 file is left in place (orphaned).
 * Same 2-query optimisation as addInvoiceAttachment.
 */
export async function removeInvoiceAttachment(
  invoiceId: string,
  key: string,
  requester: AuthPayload,
): Promise<InvoiceDetail | null> {
  const businessId = requester.businessId;
  if (!businessId) return null;

  const [row] = await db
    .select({ inv: invoices, client: clients })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(and(eq(invoices.id, invoiceId), eq(clients.businessId, businessId)));
  if (!row) return null;

  const existingAttachments = (row.inv.attachments as InvoiceAttachment[] | null) ?? [];
  const updatedAttachments = existingAttachments.filter((a) => a.key !== key);

  const [updated] = await db
    .update(invoices)
    .set({ attachments: updatedAttachments, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId))
    .returning();

  logger.info({ invoiceId, key }, 'Invoice attachment removed');
  return invoiceToDetail(updated, row.client);
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
