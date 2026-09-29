/**
 * Sam feedback 2026-09-29 (S12): invoices imported from Xero showed the import
 * date as "Created". The Xero `Date` never reached the table. `issue_date` now
 * holds it (Xero's Date for imports, creation time for invoices raised in Stato).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import * as xero from '../integrations/xero/xero-client.js';
import { syncInvoicesFromXero, listInvoices, createInvoice } from '../services/invoice.service.js';
import type { AuthPayload } from '../types/index.js';

const ORIGINAL_FETCH = global.fetch;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const XERO_CONTACT_ID = 'xero-contact-issue-date';
const owner: AuthPayload = { userId: 'system', businessId: LEADGEN_BUSINESS_ID, role: 'owner' } as AuthPayload;

// 1714003200000 = 2024-04-25T00:00:00Z ; 1719792000000 = 2024-07-01T00:00:00Z
const XERO_ISSUE_WIRE = '/Date(1714003200000+0000)/';
const XERO_DUE_WIRE = '/Date(1719792000000+0000)/';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function mockXero(invoiceId: string) {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/connect/token')) return jsonResponse({ access_token: 'tok', expires_in: 1800 });
    if (u.endsWith('/connections')) return jsonResponse([{ id: 'c', tenantId: 'tenant-abc', tenantName: 'Test Org' }]);
    return jsonResponse({
      Invoices: [{
        InvoiceID: invoiceId, InvoiceNumber: 'INV-ISSUE-1', Status: 'AUTHORISED', Type: 'ACCREC',
        Contact: { ContactID: XERO_CONTACT_ID, Name: 'Issue Date Co' },
        Date: XERO_ISSUE_WIRE, DueDate: XERO_DUE_WIRE, CurrencyCode: 'EUR',
        SubTotal: 100, TotalTax: 0, Total: 100, AmountPaid: 0, AmountDue: 100,
      }],
    });
  }) as unknown as typeof fetch;
}

let clientId: string;
const savedEnv = { id: process.env.XERO_CLIENT_ID, secret: process.env.XERO_CLIENT_SECRET };

beforeEach(async () => {
  process.env.XERO_CLIENT_ID = 'test-id';
  process.env.XERO_CLIENT_SECRET = 'test-secret';
  const [c] = await db.insert(clients).values({
    businessId: LEADGEN_BUSINESS_ID, companyName: `Issue Date Co ${Date.now()}`, status: 'active', xeroContactId: XERO_CONTACT_ID,
  }).returning({ id: clients.id });
  clientId = c.id;
  xero.__testing.resetCache();
});

afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  xero.__testing.resetCache();
  if (savedEnv.id === undefined) delete process.env.XERO_CLIENT_ID; else process.env.XERO_CLIENT_ID = savedEnv.id;
  if (savedEnv.secret === undefined) delete process.env.XERO_CLIENT_SECRET; else process.env.XERO_CLIENT_SECRET = savedEnv.secret;
  await db.delete(invoices).where(eq(invoices.clientId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
});

describe('issue date on Xero sync', () => {
  it("stores Xero's Date on import, separate from the import time", async () => {
    mockXero('xero-issue-insert-1');
    const result = await syncInvoicesFromXero(clientId, owner);
    expect(result!.synced).toBe(1);

    const [row] = await db.select().from(invoices).where(eq(invoices.xeroInvoiceId, 'xero-issue-insert-1'));
    expect(row.issueDate?.toISOString()).toBe('2024-04-25T00:00:00.000Z');
    // created_at is when Stato first saw the row: today, not April 2024.
    expect(Date.now() - row.createdAt!.getTime()).toBeLessThan(60_000);
    expect(row.issueDate!.getTime()).toBeLessThan(row.createdAt!.getTime() - 86_400_000);
  });

  it('fills the issue date on rows imported before the column existed (next sync)', async () => {
    await db.insert(invoices).values({
      clientId, xeroInvoiceId: 'xero-issue-update-1', invoiceNumber: 'INV-ISSUE-1', status: 'authorised', currency: 'EUR',
      subtotal: '100.00', vatAmount: '0.00', total: '100.00', dueDate: new Date('2024-07-01T00:00:00Z'), issueDate: null,
    });
    mockXero('xero-issue-update-1');
    const result = await syncInvoicesFromXero(clientId, owner);
    expect(result!.updated).toBe(1);
    const [row] = await db.select().from(invoices).where(eq(invoices.xeroInvoiceId, 'xero-issue-update-1'));
    expect(row.issueDate?.toISOString()).toBe('2024-04-25T00:00:00.000Z');
  });
});

describe('issue date in the API', () => {
  it('lists issueDate, null for an import that has not been re-synced, and sorts nulls last both ways', async () => {
    const mk = (n: string, issue: Date | null) => ({
      clientId, xeroInvoiceId: `xero-list-${n}`, invoiceNumber: `INV-L-${n}`, status: 'authorised', currency: 'GBP',
      subtotal: '10.00', vatAmount: '0.00', total: '10.00', dueDate: new Date('2030-01-01'), issueDate: issue,
    });
    await db.insert(invoices).values([mk('a', new Date('2024-01-10T00:00:00Z')), mk('b', null), mk('c', new Date('2024-03-10T00:00:00Z'))]);

    const desc = await listInvoices(owner, { clientId, sortBy: 'issueDate', sortDir: 'desc' });
    expect(desc.items.map((i) => i.invoiceNumber)).toEqual(['INV-L-c', 'INV-L-a', 'INV-L-b']);
    expect(desc.items[0].issueDate).toBe('2024-03-10T00:00:00.000Z');
    expect(desc.items[2].issueDate).toBeNull();

    const asc = await listInvoices(owner, { clientId, sortBy: 'issueDate', sortDir: 'asc' });
    expect(asc.items.map((i) => i.invoiceNumber)).toEqual(['INV-L-a', 'INV-L-c', 'INV-L-b']);
  });

  it('an invoice raised in Stato is issued when it is created', async () => {
    const before = Date.now();
    const inv = await createInvoice({ clientId, currency: 'GBP', lineItems: [{ description: 'Leads', quantity: 1, unitPrice: 100, amount: 100 }], addVat: false }, owner);
    expect(inv.issueDate).not.toBeNull();
    const t = new Date(inv.issueDate!).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('migration 0043', () => {
  const file = readFileSync(new URL('../db/migrations/0043_invoice_issue_date.sql', import.meta.url), 'utf8');

  it('backfills Stato-raised invoices from created_at, leaves Xero imports NULL, and is idempotent', async () => {
    const [local, imported] = await db.insert(invoices).values([
      { clientId, invoiceNumber: 'INV-M-LOCAL', status: 'draft', currency: 'GBP', total: '1.00', createdAt: new Date('2025-02-03T10:00:00Z') },
      { clientId, xeroInvoiceId: 'xero-mig-1', invoiceNumber: 'INV-M-XERO', status: 'authorised', currency: 'GBP', total: '1.00', createdAt: new Date('2026-09-29T10:00:00Z') },
    ]).returning({ id: invoices.id });

    await db.execute(sql.raw(file));
    const read = async () => (await db.select().from(invoices).where(inArray(invoices.id, [local.id, imported.id])));
    let rows = await read();
    expect(rows.find((r) => r.id === local.id)!.issueDate?.toISOString()).toBe('2025-02-03T10:00:00.000Z');
    expect(rows.find((r) => r.id === imported.id)!.issueDate).toBeNull();

    // A value set since (e.g. by the sync) must survive a re-run of the migration on the next boot.
    const kept = new Date('2024-04-25T00:00:00Z');
    await db.update(invoices).set({ issueDate: kept }).where(eq(invoices.id, imported.id));
    await db.execute(sql.raw(file));
    rows = await read();
    expect(rows.find((r) => r.id === imported.id)!.issueDate?.toISOString()).toBe(kept.toISOString());
    expect(rows.find((r) => r.id === local.id)!.issueDate?.toISOString()).toBe('2025-02-03T10:00:00.000Z');
  });
});
