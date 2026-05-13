import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientDocuments } from '../db/schema/client-documents.js';
import { clients } from '../db/schema/clients.js';
import { logClientActivity } from './client-activity.service.js';
import { deleteFile, isR2Configured } from '../integrations/r2/r2-client.js';
import type { R2Folder } from '../integrations/r2/r2-types.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export interface ClientDocument {
  id: string;
  clientId: string;
  r2Key: string;
  folder: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

export interface AddDocumentInput {
  r2Key: string;
  folder?: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
}

type Row = typeof clientDocuments.$inferSelect;

function toDocument(r: Row): ClientDocument {
  return {
    id: r.id,
    clientId: r.clientId,
    r2Key: r.r2Key,
    folder: r.folder ?? 'misc',
    name: r.name,
    contentType: r.contentType ?? 'application/octet-stream',
    sizeBytes: r.sizeBytes ?? 0,
    uploadedBy: r.uploadedBy,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
  };
}

/**
 * Confirm a client belongs to the requester's business before exposing its
 * documents. Returns true if scoping passes, false otherwise — caller decides
 * 404 vs 403 (we 404 to avoid leaking existence).
 */
async function clientInScope(clientId: string, requester: AuthPayload): Promise<boolean> {
  if (!requester.businessId) return false;
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, requester.businessId)));
  return !!row;
}

export async function listDocuments(clientId: string, requester: AuthPayload): Promise<ClientDocument[] | null> {
  if (!(await clientInScope(clientId, requester))) return null;
  const rows = await db
    .select()
    .from(clientDocuments)
    .where(eq(clientDocuments.clientId, clientId))
    .orderBy(desc(clientDocuments.createdAt));
  return rows.map(toDocument);
}

export async function addDocument(
  clientId: string,
  input: AddDocumentInput,
  requester: AuthPayload,
): Promise<ClientDocument | null> {
  if (!(await clientInScope(clientId, requester))) return null;
  const [row] = await db
    .insert(clientDocuments)
    .values({
      clientId,
      r2Key: input.r2Key,
      folder: input.folder || 'misc',
      name: input.name,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      uploadedBy: requester.userId,
    })
    .returning();
  // L #38 — surface uploads in the per-client activity feed.
  await logClientActivity(clientId, requester.userId ?? null, 'document_uploaded', {
    documentId: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
  });
  return toDocument(row);
}

export async function removeDocument(
  clientId: string,
  docId: string,
  requester: AuthPayload,
): Promise<boolean> {
  if (!(await clientInScope(clientId, requester))) return false;

  // Read the row first so we have the R2 key/folder to delete the underlying
  // object too. Sam audit #11: the previous behaviour only deleted the DB
  // row, leaving the file in R2 — confusing because the UI toast then said
  // "File still exists in storage", which read as "the delete didn't work".
  const [existing] = await db
    .select({
      id: clientDocuments.id,
      name: clientDocuments.name,
      r2Key: clientDocuments.r2Key,
      folder: clientDocuments.folder,
    })
    .from(clientDocuments)
    .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, clientId)));
  if (!existing) return false;

  await db
    .delete(clientDocuments)
    .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, clientId)));

  if (isR2Configured() && existing.r2Key) {
    try {
      await deleteFile((existing.folder ?? 'misc') as R2Folder, existing.r2Key);
    } catch (err) {
      // Don't block the DB deletion on a failed R2 cleanup — log it so we
      // can sweep orphans later if needed.
      logger.warn(
        { err, clientId, docId, r2Key: existing.r2Key },
        'R2 delete failed during client-document removal — DB row already deleted',
      );
    }
  }

  await logClientActivity(clientId, requester.userId ?? null, 'document_removed', {
    documentId: existing.id,
    name: existing.name,
  });
  return true;
}
