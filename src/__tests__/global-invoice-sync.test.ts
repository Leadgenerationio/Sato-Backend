import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { businesses } from '../db/schema/businesses.js';
import { clients } from '../db/schema/clients.js';

// We spy on the per-client sync function — import the module first so spyOn
// can intercept it. The global sync service imports the same module, so the
// spy will be in effect when syncAllClientsAcrossBusinesses calls it.
import * as invoiceService from '../services/invoice.service.js';
import { syncAllClientsAcrossBusinesses } from '../services/global-invoice-sync.service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function insertBusiness(slug: string): Promise<string> {
  const [b] = await db
    .insert(businesses)
    .values({ name: `Test Business ${slug}`, slug })
    .returning({ id: businesses.id });
  return b.id;
}

async function insertClient(
  businessId: string,
  companyName: string,
  opts: { status?: 'active' | 'churned' | 'prospect'; vatNumber?: string } = {},
): Promise<string> {
  const [c] = await db
    .insert(clients)
    .values({
      businessId,
      companyName,
      status: opts.status ?? 'active',
      vatNumber: opts.vatNumber ?? null,
    })
    .returning({ id: clients.id });
  return c.id;
}

// ── Shared state ─────────────────────────────────────────────────────────────

// We insert test clients in 2 separate businesses to verify both get
// iterated. After all tests we delete everything we created.

let bizAId: string;
let bizBId: string;
const insertedClientIds: string[] = [];
const insertedBusinessIds: string[] = [];

const UNIQUE = `gis-${Date.now()}`;

beforeAll(async () => {
  bizAId = await insertBusiness(`biz-a-${UNIQUE}`);
  bizBId = await insertBusiness(`biz-b-${UNIQUE}`);
  insertedBusinessIds.push(bizAId, bizBId);
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (insertedClientIds.length > 0) {
    await db.delete(clients).where(inArray(clients.id, insertedClientIds));
  }
  if (insertedBusinessIds.length > 0) {
    await db.delete(businesses).where(inArray(businesses.id, insertedBusinessIds));
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('syncAllClientsAcrossBusinesses — businessId scoping', () => {
  it('calls syncInvoicesFromXero with the correct businessId for each client', async () => {
    const clientA = await insertClient(bizAId, `Acme Ltd ${UNIQUE}`);
    const clientB = await insertClient(bizBId, `Beta Corp ${UNIQUE}`);
    insertedClientIds.push(clientA, clientB);

    const syncSpy = vi
      .spyOn(invoiceService, 'syncInvoicesFromXero')
      .mockResolvedValue({ synced: 0, skipped: 1, totalRemote: 1, linkedContact: false });

    const result = await syncAllClientsAcrossBusinesses();

    // At least our 2 test clients should have been processed.
    expect(result.clientsProcessed).toBeGreaterThanOrEqual(2);
    expect(result.clientsSucceeded).toBeGreaterThanOrEqual(2);
    expect(result.clientsFailed).toBe(0);
    expect(result.businessesProcessed).toBeGreaterThanOrEqual(2);
    expect(typeof result.finishedAt).toBe('string');
    expect(new Date(result.finishedAt).toString()).not.toBe('Invalid Date');

    // Verify businessId scoping: the AuthPayload passed for clientA must have
    // bizAId, and for clientB must have bizBId.
    const callsForA = syncSpy.mock.calls.filter(([id]) => id === clientA);
    const callsForB = syncSpy.mock.calls.filter(([id]) => id === clientB);

    expect(callsForA.length).toBe(1);
    expect(callsForA[0][1].businessId).toBe(bizAId);
    expect(callsForA[0][1].userId).toBe('system');
    expect(callsForA[0][1].role).toBe('owner');

    expect(callsForB.length).toBe(1);
    expect(callsForB[0][1].businessId).toBe(bizBId);

    syncSpy.mockRestore();
  });
});

describe('syncAllClientsAcrossBusinesses — per-client failure isolation', () => {
  it('counts failure for client A but still processes client B when syncInvoicesFromXero throws for A', async () => {
    const clientC = await insertClient(bizAId, `Client C ${UNIQUE}`);
    const clientD = await insertClient(bizBId, `Client D ${UNIQUE}`);
    insertedClientIds.push(clientC, clientD);

    const syncSpy = vi
      .spyOn(invoiceService, 'syncInvoicesFromXero')
      .mockImplementation(async (clientId) => {
        if (clientId === clientC) {
          throw new Error('Xero token expired for business A');
        }
        return { synced: 1, skipped: 0, totalRemote: 1, linkedContact: false };
      });

    const result = await syncAllClientsAcrossBusinesses();

    // Client C threw — must appear as a failure.
    // Client D succeeded — must appear as a success.
    // We can't know the exact totals because other DB clients may exist,
    // so check the delta via the spy calls.
    const callsForC = syncSpy.mock.calls.filter(([id]) => id === clientC);
    const callsForD = syncSpy.mock.calls.filter(([id]) => id === clientD);

    // Both were attempted.
    expect(callsForC.length).toBe(1);
    expect(callsForD.length).toBe(1);

    // Overall counts: at least 1 failure (client C) and at least 1 success (client D).
    expect(result.clientsFailed).toBeGreaterThanOrEqual(1);
    expect(result.clientsSucceeded).toBeGreaterThanOrEqual(1);

    // Total processed >= 2
    expect(result.clientsProcessed).toBeGreaterThanOrEqual(2);

    syncSpy.mockRestore();
  });
});

describe('syncAllClientsAcrossBusinesses — churned clients skipped', () => {
  it('does not call syncInvoicesFromXero for churned clients', async () => {
    const clientActive = await insertClient(bizAId, `Active Client ${UNIQUE}-skip`);
    const clientChurned = await insertClient(bizBId, `Churned Client ${UNIQUE}-skip`, { status: 'churned' });
    insertedClientIds.push(clientActive, clientChurned);

    const syncSpy = vi
      .spyOn(invoiceService, 'syncInvoicesFromXero')
      .mockResolvedValue({ synced: 0, skipped: 0, totalRemote: 0, linkedContact: false });

    await syncAllClientsAcrossBusinesses();

    const callsForActive = syncSpy.mock.calls.filter(([id]) => id === clientActive);
    const callsForChurned = syncSpy.mock.calls.filter(([id]) => id === clientChurned);

    // Active client was synced.
    expect(callsForActive.length).toBe(1);
    // Churned client was NOT synced.
    expect(callsForChurned.length).toBe(0);

    syncSpy.mockRestore();
  });
});
