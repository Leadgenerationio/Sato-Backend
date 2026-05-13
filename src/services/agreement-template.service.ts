import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '../config/database.js';
import { agreementTemplates, type FieldLayout } from '../db/schema/agreement-templates.js';
import type { AuthPayload } from '../types/index.js';
import { ForbiddenError } from '../utils/errors.js';

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
