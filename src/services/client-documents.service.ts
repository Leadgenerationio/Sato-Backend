import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientDocuments } from '../db/schema/client-documents.js';
import { clients } from '../db/schema/clients.js';
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
  return toDocument(row);
}

export async function removeDocument(
  clientId: string,
  docId: string,
  requester: AuthPayload,
): Promise<boolean> {
  if (!(await clientInScope(clientId, requester))) return false;
  const deleted = await db
    .delete(clientDocuments)
    .where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, clientId)))
    .returning({ id: clientDocuments.id });
  return deleted.length > 0;
}
