import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agreementTemplates, type FieldLayout } from '../db/schema/agreement-templates.js';
import { clients } from '../db/schema/clients.js';
import type { AuthPayload } from '../types/index.js';
import { ForbiddenError } from '../utils/errors.js';
import { downloadFile } from '../integrations/r2/r2-client.js';
import type { R2Folder } from '../integrations/r2/r2-types.js';
import { resolveVariables } from './variable-resolver.js';
import { populatePdf } from './pdf-populator.js';

export interface AgreementTemplateRow {
  id: string;
  name: string;
  description: string | null;
  pdfR2Key: string;
  fieldLayout: FieldLayout;
  signerRole: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTemplateInput {
  name: string;
  description?: string;
  pdfR2Key: string;
  fieldLayout?: FieldLayout;
  signerRole?: string;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  fieldLayout?: FieldLayout;
  signerRole?: string;
}

function requireBusinessId(requester: AuthPayload): string {
  if (!requester.businessId) {
    throw new ForbiddenError('User has no business context');
  }
  return requester.businessId;
}

export async function listTemplates(requester: AuthPayload): Promise<AgreementTemplateRow[]> {
  const businessId = requireBusinessId(requester);
  const rows = await db
    .select()
    .from(agreementTemplates)
    .where(and(eq(agreementTemplates.businessId, businessId), isNull(agreementTemplates.archivedAt)))
    .orderBy(desc(agreementTemplates.createdAt));
  return rows.map(toRow);
}

export async function getTemplate(id: string, requester: AuthPayload): Promise<AgreementTemplateRow | null> {
  const businessId = requireBusinessId(requester);
  const [row] = await db
    .select()
    .from(agreementTemplates)
    .where(and(eq(agreementTemplates.id, id), eq(agreementTemplates.businessId, businessId)));
  return row ? toRow(row) : null;
}

export async function createTemplate(input: CreateTemplateInput, requester: AuthPayload): Promise<AgreementTemplateRow> {
  const businessId = requireBusinessId(requester);
  const [row] = await db
    .insert(agreementTemplates)
    .values({
      businessId,
      name: input.name,
      description: input.description ?? null,
      pdfR2Key: input.pdfR2Key,
      fieldLayout: input.fieldLayout ?? [],
      signerRole: input.signerRole ?? null,
    })
    .returning();
  return toRow(row);
}

export async function updateTemplate(
  id: string,
  patch: UpdateTemplateInput,
  requester: AuthPayload,
): Promise<AgreementTemplateRow | null> {
  const existing = await getTemplate(id, requester);
  if (!existing) return null;
  const [row] = await db
    .update(agreementTemplates)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.fieldLayout !== undefined ? { fieldLayout: patch.fieldLayout } : {}),
      ...(patch.signerRole !== undefined ? { signerRole: patch.signerRole } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agreementTemplates.id, id))
    .returning();
  return toRow(row);
}

export async function archiveTemplate(id: string, requester: AuthPayload): Promise<boolean> {
  const existing = await getTemplate(id, requester);
  if (!existing) return false;
  await db
    .update(agreementTemplates)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(agreementTemplates.id, id));
  return true;
}

export async function duplicateTemplate(id: string, requester: AuthPayload): Promise<AgreementTemplateRow | null> {
  const existing = await getTemplate(id, requester);
  if (!existing) return null;
  return createTemplate(
    {
      name: `${existing.name} (copy)`,
      description: existing.description ?? undefined,
      pdfR2Key: existing.pdfR2Key,
      fieldLayout: existing.fieldLayout,
      signerRole: existing.signerRole ?? undefined,
    },
    requester,
  );
}

function toRow(r: typeof agreementTemplates.$inferSelect): AgreementTemplateRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    pdfR2Key: r.pdfR2Key,
    fieldLayout: (r.fieldLayout as FieldLayout) ?? [],
    signerRole: r.signerRole,
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Render a preview PDF by baking variable values into the template PDF.
 * Returns null if the template or client cannot be found for this business.
 *
 * The pdfR2Key stored on a template includes the folder prefix (e.g.
 * "agreements/foo.pdf"). We split on the first "/" to derive the R2Folder
 * and the relative key for `downloadFile`.
 */
export async function previewTemplate(
  templateId: string,
  input: { clientId: string; overrides?: Record<string, string>; effectiveDate?: string | null },
  requester: AuthPayload,
): Promise<Uint8Array | null> {
  const businessId = requireBusinessId(requester);
  const template = await getTemplate(templateId, requester);
  if (!template) return null;

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.businessId, businessId)));
  if (!client) return null;

  // pdfR2Key is stored as "<folder>/<key>" (e.g. "agreements/my-template.pdf").
  // Split on the first "/" to get the R2Folder and the relative key.
  const slashIdx = template.pdfR2Key.indexOf('/');
  let templatePdfBytes: Buffer;
  if (slashIdx === -1) {
    // Fallback: treat entire key as relative to 'agreements' folder
    templatePdfBytes = await downloadFile('agreements' as R2Folder, template.pdfR2Key);
  } else {
    const folder = template.pdfR2Key.slice(0, slashIdx) as R2Folder;
    const key = template.pdfR2Key.slice(slashIdx + 1);
    templatePdfBytes = await downloadFile(folder, key);
  }

  const resolved = resolveVariables(
    client as unknown as Parameters<typeof resolveVariables>[0],
    { effectiveDate: input.effectiveDate ?? null },
    input.overrides ?? {},
  );

  return populatePdf(new Uint8Array(templatePdfBytes), template.fieldLayout, resolved);
}
