import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { sops, type SopScreenshot } from '../db/schema/sops.js';
import type { AuthPayload } from '../types/index.js';
import { callAnthropic, isAnthropicConfigured } from '../integrations/anthropic/anthropic-client.js';

export interface Sop {
  id: string;
  title: string;
  content: string;
  category: 'Operations' | 'Finance' | 'Onboarding' | 'Compliance' | 'Campaigns';
  version: string;
  author: string;
  lastUpdated: string;
  status: 'published' | 'draft';
  loomUrl: string | null;
  screenshots: SopScreenshot[];
  tags: string[];
}

export interface SopFilters {
  category?: string;
  search?: string;
  status?: string;
  tag?: string;
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
    loomUrl: row.loomUrl ?? null,
    screenshots: (row.screenshots as SopScreenshot[] | null) ?? [],
    tags: row.tags ?? [],
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
  if (filters?.tag) {
    // Postgres array containment: tags @> ARRAY[tag]. Index-friendly via the
    // sops_tags_idx GIN index in migration 0023.
    conditions.push(sql`${sops.tags} @> ARRAY[${filters.tag}]::text[]`);
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
      loomUrl: data.loomUrl ?? null,
      screenshots: data.screenshots ?? [],
      tags: data.tags ?? [],
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
  if (data.loomUrl !== undefined) patch.loomUrl = data.loomUrl;
  if (data.screenshots !== undefined) patch.screenshots = data.screenshots;
  if (data.tags !== undefined) patch.tags = data.tags;

  const [row] = await db.update(sops).set(patch).where(eq(sops.id, id)).returning();
  return row ? toSop(row) : null;
}

// ─── AI generation ───

/**
 * Generate a structured SOP draft from a Loom URL + a transcript pasted by
 * the user. Loom's transcript endpoint requires Loom's own auth, so we don't
 * fetch it ourselves — the UI asks the user to paste the transcript (Loom
 * exposes it under the share link as "Show transcript").
 *
 * Output is constrained to JSON so the UI can pre-fill title/content/tags
 * fields directly without follow-up parsing logic.
 *
 * Requires ANTHROPIC_API_KEY. Returns a clear "not configured" error if
 * unset so the frontend can show a useful message instead of a 500.
 */
const SOP_GENERATION_SYSTEM = `You are a technical writer turning a recorded walkthrough into a Standard Operating Procedure (SOP) for an internal ops team.

You will receive a Loom video URL and a transcript of the recording. Produce a single JSON object — and NOTHING else, no preamble — with this exact shape:

{
  "title": "short, action-oriented SOP title (max 60 chars)",
  "category": "Operations" | "Finance" | "Onboarding" | "Compliance" | "Campaigns",
  "tags": ["lowercase-kebab-case", "max-6-tags"],
  "content": "the SOP body as plain text with section headers and numbered steps"
}

Style guide for content:
- Open with a one-sentence summary of what the SOP teaches.
- Use "## Section name" for section headers and 1. 2. 3. for numbered steps.
- Reference specific tools, buttons, URLs, and keystrokes mentioned in the recording.
- Skip filler ("um", "uh", small talk), but keep every concrete instruction.
- If the recording mentions a known compliance / finance / onboarding process, choose the matching category; otherwise default to "Operations".
- Tags should be functional ("xero-invoice-push", "lead-byte-sync") not generic ("guide", "process").

Return only the JSON object.`;

export interface SopGenerationInput {
  loomUrl: string;
  transcript: string;
}

export interface SopGenerationDraft {
  title: string;
  category: Sop['category'];
  tags: string[];
  content: string;
  loomUrl: string;
}

export async function generateSopFromLoom(input: SopGenerationInput): Promise<SopGenerationDraft> {
  if (!isAnthropicConfigured()) {
    throw new Error('Anthropic API not configured. Set ANTHROPIC_API_KEY to enable AI SOP generation.');
  }
  const userMessage = `Loom URL: ${input.loomUrl}\n\nTranscript:\n${input.transcript}`;
  const { text } = await callAnthropic({
    system: SOP_GENERATION_SYSTEM,
    userMessage,
    cacheSystem: true,
    maxTokens: 2048,
    temperature: 0.3,
  });

  // The model is instructed to return raw JSON. Be tolerant if it wraps the
  // payload in ```json fences (small models occasionally do this even when
  // told not to).
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed: Partial<SopGenerationDraft>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Model returned non-JSON output. Try regenerating.');
  }
  return {
    title: String(parsed.title ?? '').slice(0, 200),
    category: ((['Operations', 'Finance', 'Onboarding', 'Compliance', 'Campaigns'] as const).includes(parsed.category as Sop['category'])
      ? parsed.category
      : 'Operations') as Sop['category'],
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
    content: String(parsed.content ?? ''),
    loomUrl: input.loomUrl,
  };
}

// ─── Tags ───
// Return all distinct tags used across this business's SOPs, ordered by use
// count desc. Powers the "suggested tags" dropdown on the SOP editor.
export async function listTags(requester: AuthPayload): Promise<Array<{ tag: string; count: number }>> {
  if (!requester.businessId) return [];
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    SELECT t AS tag, count(*)::int AS count
    FROM sops, unnest(sops.tags) AS t
    WHERE sops.business_id = ${requester.businessId}
    GROUP BY t
    ORDER BY count DESC, t ASC
  `);
  // drizzle's execute returns a Result whose rows shape is driver-dependent;
  // the postgres-js driver returns rows directly on the Result.
  const arr = (rows as unknown as { rows?: Array<{ tag: string; count: number }> }).rows
    ?? (rows as unknown as Array<{ tag: string; count: number }>);
  return arr.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
