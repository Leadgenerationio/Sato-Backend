/**
 * Service-level tests for two 2026-06-15 invoice fixes:
 *
 *  - Fix #7: syncInvoicesFromXero was insert-only. An invoice paid in Xero
 *    never flipped to 'paid' in Stato, so it showed "overdue" forever. The
 *    sync now re-syncs mutable fields (status/amounts/due/paid) for invoices
 *    already in the DB. We assert an existing 'authorised' row flips to 'paid'.
 *
 *  - Fix #8: listInvoices leaked DRAFT invoices into the admin Finance list +
 *    Client Detail invoices tab. Default now excludes draft/voided/deleted;
 *    an explicit status:'draft' filter still returns them.
 *
 * Uses a mocked global.fetch (token + connections + /Invoices) so no real
 * Xero call happens — mirrors invoice-xero-push.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import * as xero from '../integrations/xero/xero-client.js';
import {
  syncInvoicesFromXero,
  listInvoices,
} from '../services/invoice.service.js';
import type { AuthPayload } from '../types/index.js';

const ORIGINAL_FETCH = global.fetch;
const LEADGEN_BUSINESS_ID = '26d6b2b4-c867-460e-8473-eca2b1ffd232';
const XERO_CONTACT_ID = 'xero-contact-sync-test';
const XERO_INVOICE_ID = 'xero-inv-sync-update-1';

let clientId: string;
const owner: AuthPayload = { userId: 'system', businessId: LEADGEN_BUSINESS_ID, role: 'owner' } as AuthPayload;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// Mock the Xero auth + /Invoices fetch. `invoiceStatus` is the Status the
// remote invoice reports (e.g. 'PAID', 'AUTHORISED').
function mockXeroFetch(invoiceStatus: string) {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/connect/token')) {
      return jsonResponse({ access_token: 'tok', expires_in: 1800 });
    }
    if (u.endsWith('/connections')) {
      return jsonResponse([{ id: 'c', tenantId: 'tenant-abc', tenantName: 'Test Org' }]);
    }
    // /api.xro/2.0/Invoices
    return jsonResponse({
      Invoices: [
        {
          InvoiceID: XERO_INVOICE_ID,
          InvoiceNumber: 'INV-SYNC-1',
          Status: invoiceStatus,
          Type: 'ACCREC',
          Contact: { ContactID: XERO_CONTACT_ID, Name: 'Sync Test Co' },
          DueDate: '/Date(1714521600000+0000)/', // a past date
          CurrencyCode: 'GBP',
          SubTotal: 100,
          TotalTax: 20,
          Total: 120,
          AmountPaid: invoiceStatus.toUpperCase() === 'PAID' ? 120 : 0,
          AmountDue: invoiceStatus.toUpperCase() === 'PAID' ? 0 : 120,
        },
      ],
    });
  }) as unknown as typeof fetch;
}

describe('syncInvoicesFromXero — Fix #7 re-syncs existing invoices', () => {
  const savedEnv = { id: process.env.XERO_CLIENT_ID, secret: process.env.XERO_CLIENT_SECRET };
  beforeEach(async () => {
    // syncInvoicesFromXero short-circuits unless Xero is "configured". The
    // token exchange + /Invoices fetch are mocked below, so dummy creds suffice.
    process.env.XERO_CLIENT_ID = 'test-id';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    const [c] = await db
      .insert(clients)
      .values({
        businessId: LEADGEN_BUSINESS_ID,
        companyName: `Sync Test Co ${Date.now()}`,
        status: 'active',
        xeroContactId: XERO_CONTACT_ID,
      })
      .returning({ id: clients.id });
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

  it('flips an existing AUTHORISED invoice to paid when Xero now reports PAID', async () => {
    // Seed an existing invoice that Stato thinks is still authorised + overdue.
    await db.insert(invoices).values({
      clientId,
      xeroInvoiceId: XERO_INVOICE_ID,
      invoiceNumber: 'INV-SYNC-1',
      status: 'authorised',
      currency: 'GBP',
      subtotal: '100.00',
      vatAmount: '20.00',
      total: '120.00',
      dueDate: new Date('2024-05-01T00:00:00Z'), // long past → would show overdue
      paidDate: null,
    });

    mockXeroFetch('PAID');

    const result = await syncInvoicesFromXero(clientId, owner);
    expect(result).not.toBeNull();
    expect(result!.synced).toBe(0); // nothing new — it already existed
    expect(result!.updated).toBe(1); // the existing row was re-synced

    const [row] = await db.select().from(invoices).where(eq(invoices.xeroInvoiceId, XERO_INVOICE_ID));
    expect(row.status).toBe('paid');
    expect(row.paidDate).not.toBeNull();
    // daysOverdue must drop to 0 once paid (no longer chaseable).
    expect(row.daysOverdue).toBe(0);
    // Money preserved as decimal strings.
    expect(row.total).toBe('120.00');
  });
});

describe('listInvoices — Fix #8 excludes drafts by default', () => {
  const draftId = '00000000-0000-0000-0000-00000000d001';
  const paidId = '00000000-0000-0000-0000-00000000d002';

  beforeEach(async () => {
    const [c] = await db
      .insert(clients)
      .values({
        businessId: LEADGEN_BUSINESS_ID,
        companyName: `List Test Co ${Date.now()}`,
        status: 'active',
      })
      .returning({ id: clients.id });
    clientId = c.id;

    await db.insert(invoices).values([
      {
        id: draftId,
        clientId,
        // Unpushed local draft (no xeroInvoiceId) — Fix #9 workflow noise.
        status: 'draft',
        currency: 'GBP',
        subtotal: '10.00',
        vatAmount: '2.00',
        total: '12.00',
        dueDate: new Date(),
      },
      {
        id: paidId,
        clientId,
        xeroInvoiceId: 'xero-list-paid-1',
        invoiceNumber: 'INV-LIST-PAID',
        status: 'paid',
        currency: 'GBP',
        subtotal: '100.00',
        vatAmount: '20.00',
        total: '120.00',
        dueDate: new Date(),
        paidDate: new Date(),
      },
    ]).onConflictDoNothing();
  });

  afterEach(async () => {
    await db.delete(invoices).where(inArray(invoices.id, [draftId, paidId]));
    await db.delete(clients).where(eq(clients.id, clientId));
  });

  it('default list (no status) excludes draft invoices', async () => {
    const res = await listInvoices(owner, { clientId, limit: 100 });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(paidId);
    expect(ids).not.toContain(draftId);
    expect(res.items.every((i) => i.status !== 'draft')).toBe(true);
  });

  it("status:'all' still excludes draft invoices", async () => {
    const res = await listInvoices(owner, { clientId, status: 'all', limit: 100 });
    expect(res.items.map((i) => i.id)).not.toContain(draftId);
  });

  it("explicit status:'draft' filter still returns drafts", async () => {
    const res = await listInvoices(owner, { clientId, status: 'draft', limit: 100 });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(draftId);
    expect(ids).not.toContain(paidId);
  });
});
