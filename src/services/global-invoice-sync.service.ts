import { and, ne, isNotNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { syncInvoicesFromXero } from './invoice.service.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface GlobalInvoiceSyncResult {
  businessesProcessed: number;
  clientsProcessed: number;
  clientsSucceeded: number;
  clientsFailed: number;
  finishedAt: string;
}

/**
 * Periodic global Xero invoice sync.
 *
 * Iterates over every non-churned client across all businesses that has
 * either a companyName or vatNumber (the fields Xero contact resolution
 * needs) and runs the standard per-client syncInvoicesFromXero().
 *
 * Design decisions:
 * - Sequential, no concurrency — Xero throttles aggressively (60 req/min
 *   per tenant) so we stay sequential rather than Promise.all().
 * - One failure (Xero token expired, no matching contact, etc.) does NOT
 *   abort the run. We catch, log, count, and continue.
 * - System AuthPayload with businessId per-client so the per-client
 *   service's tenant-scope checks pass (the service asserts
 *   `client.businessId === requester.businessId`).
 */
export async function syncAllClientsAcrossBusinesses(): Promise<GlobalInvoiceSyncResult> {
  // Fetch all non-churned clients that have at least a companyName (the
  // vatNumber field is optional; the sync service handles the case where
  // xeroContactId is absent by searching by name).
  // We also skip rows with no companyName — nothing to match against Xero.
  const eligibleClients = await db
    .select({
      id: clients.id,
      businessId: clients.businessId,
      companyName: clients.companyName,
      vatNumber: clients.vatNumber,
    })
    .from(clients)
    .where(
      and(
        ne(clients.status, 'churned'),
        // companyName is NOT NULL in the schema, but filter for safety
        isNotNull(clients.companyName),
        sql`trim(${clients.companyName}) <> ''`,
      ),
    );

  const businessIds = new Set(eligibleClients.map((c) => c.businessId));
  let clientsProcessed = 0;
  let clientsSucceeded = 0;
  let clientsFailed = 0;

  for (const client of eligibleClients) {
    clientsProcessed++;

    // Build a system-level requester scoped to this client's business so
    // the per-client service's tenant check (client.businessId === requester.businessId)
    // passes correctly.
    const requester: AuthPayload = {
      userId: 'system',
      role: 'owner',
      email: 'system@stato.local',
      businessId: client.businessId,
    };

    try {
      const result = await syncInvoicesFromXero(client.id, requester);
      if (result === null) {
        // syncInvoicesFromXero returns null when client not found — shouldn't
        // happen since we fetched directly from the DB, but count conservatively.
        logger.warn({ clientId: client.id, businessId: client.businessId }, 'global-invoice-sync: syncInvoicesFromXero returned null for client');
        clientsFailed++;
      } else {
        logger.info(
          { clientId: client.id, businessId: client.businessId, synced: result.synced, message: result.message },
          'global-invoice-sync: client synced',
        );
        clientsSucceeded++;
      }
    } catch (err) {
      // Per-client errors (expired Xero token, network failure, etc.) must
      // NOT abort the whole run.
      logger.error(
        { err, clientId: client.id, businessId: client.businessId },
        'global-invoice-sync: syncInvoicesFromXero threw — skipping client',
      );
      clientsFailed++;
    }
  }

  const finishedAt = new Date().toISOString();

  logger.info(
    {
      businessesProcessed: businessIds.size,
      clientsProcessed,
      clientsSucceeded,
      clientsFailed,
      finishedAt,
    },
    'global-invoice-sync: run complete',
  );

  return {
    businessesProcessed: businessIds.size,
    clientsProcessed,
    clientsSucceeded,
    clientsFailed,
    finishedAt,
  };
}
