import { eq, inArray, and } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import {
  listAttioCompanies, getAttioCompany,
  isAttioConfigured, AttioNotConfiguredError,
  type AttioCompany, type ListAttioCompaniesOpts,
} from '../integrations/attio/attio-client.js';
import { logClientActivity } from './client-activity.service.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// #39 Attio bulk import.
//
// Two operations:
//   1. Browse: list companies from Attio + flag which ones are already
//      imported (by attio_company_id) so the UI can disable them.
//   2. Import: given a list of Attio record ids, create a Stato client
//      per record. Dedupes server-side against attio_company_id — a
//      retry of the same set is idempotent.

export interface BrowseAttioCompany extends AttioCompany {
  // The Stato client id if this Attio company has already been imported
  // into the requester's business. Null when importable.
  existingClientId: string | null;
}

export interface BrowseResult {
  companies: BrowseAttioCompany[];
  nextCursor: string | null;
}

export async function browseAttioCompanies(
  opts: ListAttioCompaniesOpts,
  requester: AuthPayload,
): Promise<BrowseResult> {
  if (!isAttioConfigured()) throw new AttioNotConfiguredError();
  if (!requester.businessId) {
    // Scoping a Stato user with no business to "this business's already-
    // imported set" is meaningless. Surface as an error rather than
    // silently returning everything as importable.
    throw new Error('Requester has no business — cannot browse Attio for import');
  }

  const { companies, nextCursor } = await listAttioCompanies(opts);
  const recordIds = companies.map((c) => c.recordId);
  // Map Attio id → existing Stato client id (if any) so the UI can
  // disable the checkbox and show "Already imported" instead of
  // silently no-oping at create time.
  const existingMap = new Map<string, string>();
  if (recordIds.length > 0) {
    const rows = await db
      .select({ id: clients.id, attioCompanyId: clients.attioCompanyId })
      .from(clients)
      .where(
        and(
          eq(clients.businessId, requester.businessId),
          inArray(clients.attioCompanyId, recordIds),
        ),
      );
    for (const r of rows) if (r.attioCompanyId) existingMap.set(r.attioCompanyId, r.id);
  }

  return {
    companies: companies.map((c) => ({
      ...c,
      existingClientId: existingMap.get(c.recordId) ?? null,
    })),
    nextCursor,
  };
}

export interface ImportResultRow {
  attioCompanyId: string;
  attioName: string | null;
  status: 'created' | 'skipped' | 'error';
  clientId?: string;        // populated when status=created OR skipped (existing)
  reason?: string;          // populated when status=error
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: number;
  rows: ImportResultRow[];
}

export async function importAttioCompanies(
  attioIds: string[],
  requester: AuthPayload,
): Promise<ImportResult> {
  if (!isAttioConfigured()) throw new AttioNotConfiguredError();
  if (!requester.businessId) {
    throw new Error('Requester has no business — cannot import clients');
  }
  if (attioIds.length === 0) {
    return { created: 0, skipped: 0, errors: 0, rows: [] };
  }
  if (attioIds.length > 200) {
    // Soft cap. 200 keeps a single request's serialized fetch+insert work
    // bounded; the FE pages through if more are needed.
    throw new Error('Cannot import more than 200 companies in one call');
  }

  // Pre-fetch existing rows in one query — much cheaper than N round
  // trips inside the loop.
  const existing = await db
    .select({ id: clients.id, attioCompanyId: clients.attioCompanyId })
    .from(clients)
    .where(
      and(
        eq(clients.businessId, requester.businessId),
        inArray(clients.attioCompanyId, attioIds),
      ),
    );
  const existingMap = new Map<string, string>();
  for (const r of existing) if (r.attioCompanyId) existingMap.set(r.attioCompanyId, r.id);

  const result: ImportResult = { created: 0, skipped: 0, errors: 0, rows: [] };

  for (const attioId of attioIds) {
    const dupClientId = existingMap.get(attioId);
    if (dupClientId) {
      result.skipped += 1;
      result.rows.push({
        attioCompanyId: attioId,
        attioName: null,
        status: 'skipped',
        clientId: dupClientId,
        reason: 'Already imported',
      });
      continue;
    }

    try {
      const company = await getAttioCompany(attioId);
      if (!company) {
        result.errors += 1;
        result.rows.push({
          attioCompanyId: attioId,
          attioName: null,
          status: 'error',
          reason: 'Attio record not found',
        });
        continue;
      }

      const [inserted] = await db
        .insert(clients)
        .values({
          businessId: requester.businessId,
          companyName: company.name ?? '(unnamed)',
          attioCompanyId: company.recordId,
          status: 'prospect',
          onboardingStatus: 'pending',
          // Free-text address field — Attio domain doesn't map cleanly
          // to our 5-field address, so we leave that empty and let the
          // user fill it after import. Stash the description in notes
          // so the import isn't lossy.
          notes: [company.description, company.industry, company.employeeRange]
            .filter(Boolean)
            .join('\n') || null,
        })
        .returning({ id: clients.id });

      // Surface the import on the per-client activity feed so it's
      // distinguishable from a hand-created row.
      await logClientActivity(inserted.id, requester.userId ?? null, 'client_imported_from_attio', {
        attioCompanyId: company.recordId,
        attioName: company.name,
      });

      result.created += 1;
      result.rows.push({
        attioCompanyId: attioId,
        attioName: company.name,
        status: 'created',
        clientId: inserted.id,
      });
    } catch (err) {
      logger.warn({ err, attioId }, 'Attio import row failed');
      result.errors += 1;
      result.rows.push({
        attioCompanyId: attioId,
        attioName: null,
        status: 'error',
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}
