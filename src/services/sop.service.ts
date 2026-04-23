import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { sops } from '../db/schema/sops.js';
import type { AuthPayload } from '../types/index.js';

export interface Sop {
  id: string;
  title: string;
  content: string;
  category: 'Operations' | 'Finance' | 'Onboarding' | 'Compliance' | 'Campaigns';
  version: string;
  author: string;
  lastUpdated: string;
  status: 'published' | 'draft';
}

export interface SopFilters {
  category?: string;
  search?: string;
  status?: string;
}

type SopRow = typeof sops.$inferSelect;

function toSop(row: SopRow): Sop {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category as Sop['category'],
    version: row.version,
    author: row.author,
    lastUpdated: (row.updatedAt ?? row.createdAt ?? new Date()).toISOString(),
    status: row.status as Sop['status'],
  };
}

export async function listSops(requester: AuthPayload, filters?: SopFilters): Promise<Sop[]> {
  const conditions = [];
  if (requester.businessId) conditions.push(eq(sops.businessId, requester.businessId));
  if (filters?.category && filters.category !== 'all') {
    conditions.push(sql`lower(${sops.category}) = ${filters.category.toLowerCase()}`);
  }
  if (filters?.status && filters.status !== 'all') {
    conditions.push(eq(sops.status, filters.status));
  }
  if (filters?.search) {
    const q = `%${filters.search}%`;
    conditions.push(or(ilike(sops.title, q), ilike(sops.content, q))!);
  }

  const rows = await db
    .select()
    .from(sops)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(sops.updatedAt));

  return rows.map(toSop);
}

export async function getSop(id: string): Promise<Sop | null> {
  const [row] = await db.select().from(sops).where(eq(sops.id, id));
  return row ? toSop(row) : null;
}

export async function createSop(data: Partial<Sop>, requester: AuthPayload): Promise<Sop> {
  const [row] = await db
    .insert(sops)
    .values({
      businessId: requester.businessId ?? null,
      title: data.title || '',
      content: data.content || '',
      category: data.category || 'Operations',
      version: data.version || '1.0',
      author: requester.email,
      status: data.status || 'draft',
    })
    .returning();
  return toSop(row);
}

export async function updateSop(id: string, data: Partial<Sop>): Promise<Sop | null> {
  const patch: Partial<SopRow> = { updatedAt: new Date() };
  if (data.title !== undefined) patch.title = data.title;
  if (data.content !== undefined) patch.content = data.content;
  if (data.category !== undefined) patch.category = data.category;
  if (data.version !== undefined) patch.version = data.version;
  if (data.status !== undefined) patch.status = data.status;

  const [row] = await db.update(sops).set(patch).where(eq(sops.id, id)).returning();
  return row ? toSop(row) : null;
}
