import { and, eq, or } from 'drizzle-orm';
import { db } from '../config/database.js';
import { creatives } from '../db/schema/creatives.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clients } from '../db/schema/clients.js';
import { agreements } from '../db/schema/agreements.js';
import { agreementTemplates } from '../db/schema/agreement-templates.js';
import type { R2Folder } from '../integrations/r2/r2-types.js';
import type { AuthPayload, UserRole } from '../types/index.js';

/**
 * Per-resource access control for /uploads/signed-url.
 *
 * The route used to be gated only by `authMiddleware`, so any authenticated
 * user — including a portal client — could ask for a fresh 1-hour signed URL
 * for any (folder, key) combo: other clients' creatives, agreements, etc.
 * Reconnaissance was non-trivial (keys carry a timestamp + sanitised
 * filename) but not strong defense.
 *
 * Every denial returns the same shape (404) as a non-existent key so we don't
 * leak which keys exist.
 */
export class UploadAccessError extends Error {
  constructor() {
    super('Not found');
    this.name = 'UploadAccessError';
  }
}

const STAFF_ROLES: ReadonlySet<UserRole> = new Set(['owner', 'finance_admin', 'ops_manager']);
const PORTAL_ROLES: ReadonlySet<UserRole> = new Set(['client', 'client_admin']);

function isStaff(role: UserRole): boolean { return STAFF_ROLES.has(role); }
function isPortal(role: UserRole): boolean { return PORTAL_ROLES.has(role); }

/**
 * Throws `UploadAccessError` (→ 404) if the requester is not allowed to read
 * this (folder, key). Caller should convert to 404. Never returns 403 — we
 * intentionally collapse "doesn't exist" and "exists but forbidden" so a
 * portal client can't enumerate other tenants' keys.
 */
export async function assertCanReadObject(
  requester: AuthPayload,
  folder: R2Folder,
  key: string,
): Promise<void> {
  // sops / misc are staff-only file stores — no portal use case today.
  if (folder === 'sops' || folder === 'misc') {
    if (!isStaff(requester.role)) throw new UploadAccessError();
    return;
  }

  // invoices / landing-pages: the schema currently has no r2_key column, so
  // there's no per-row ownership lookup available. Default-deny to portal
  // users and allow any staff role until concrete portal use exists. When a
  // proper ownership column lands, add the lookup here.
  if (folder === 'invoices' || folder === 'landing-pages') {
    if (!isStaff(requester.role)) throw new UploadAccessError();
    return;
  }

  if (folder === 'creatives') {
    await assertCanReadCreative(requester, key);
    return;
  }

  if (folder === 'agreements') {
    await assertCanReadAgreement(requester, key);
    return;
  }

  // Unknown folder — fail closed.
  throw new UploadAccessError();
}

async function assertCanReadCreative(requester: AuthPayload, key: string): Promise<void> {
  // The creative's r2_key is the bare key (no folder prefix); look it up
  // directly and walk to the owning client(s) via the campaign.
  const [row] = await db
    .select({ id: creatives.id, campaignId: creatives.campaignId })
    .from(creatives)
    .where(eq(creatives.r2Key, key))
    .limit(1);
  if (!row) throw new UploadAccessError();

  if (isPortal(requester.role)) {
    if (!requester.clientId) throw new UploadAccessError();
    // Must be one of THIS client's campaigns (via client_campaigns).
    const [link] = await db
      .select({ id: clientCampaigns.campaignId })
      .from(clientCampaigns)
      .where(and(
        eq(clientCampaigns.campaignId, row.campaignId),
        eq(clientCampaigns.clientId, requester.clientId),
      ))
      .limit(1);
    if (!link) throw new UploadAccessError();
    return;
  }

  if (isStaff(requester.role)) {
    if (!requester.businessId) throw new UploadAccessError();
    // Staff must belong to the same business as ANY client linked to this
    // campaign. We accept either the legacy direct `campaigns.client_id`
    // path or the newer `client_campaigns` join. Both queries filter by
    // requester.businessId in the WHERE clause — a multi-tenant campaign
    // (same vertical served by buyers in different businesses) must not
    // false-deny because LIMIT 1 happened to return another tenant's row.
    const [direct] = await db
      .select({ businessId: clients.businessId })
      .from(campaigns)
      .innerJoin(clients, eq(clients.id, campaigns.clientId))
      .where(and(eq(campaigns.id, row.campaignId), eq(clients.businessId, requester.businessId)))
      .limit(1);
    if (direct) return;
    const [viaJoin] = await db
      .select({ businessId: clients.businessId })
      .from(clientCampaigns)
      .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
      .where(and(
        eq(clientCampaigns.campaignId, row.campaignId),
        eq(clients.businessId, requester.businessId),
      ))
      .limit(1);
    if (viaJoin) return;
    throw new UploadAccessError();
  }

  throw new UploadAccessError();
}

async function assertCanReadAgreement(requester: AuthPayload, key: string): Promise<void> {
  // The key can live in either `pdf_r2_key` (uploaded original) or
  // `populated_pdf_r2_key` (post-template populate). Check both.
  const [row] = await db
    .select({ clientId: agreements.clientId })
    .from(agreements)
    .where(or(eq(agreements.pdfR2Key, key), eq(agreements.populatedPdfR2Key, key)))
    .limit(1);

  if (row) {
    if (isPortal(requester.role)) {
      if (requester.clientId !== row.clientId) throw new UploadAccessError();
      return;
    }
    if (isStaff(requester.role)) {
      if (!requester.businessId) throw new UploadAccessError();
      const [client] = await db
        .select({ businessId: clients.businessId })
        .from(clients)
        .where(eq(clients.id, row.clientId))
        .limit(1);
      if (client?.businessId !== requester.businessId) throw new UploadAccessError();
      return;
    }
    throw new UploadAccessError();
  }

  // Fall through: it might be an agreement TEMPLATE (business-scoped, staff-only).
  if (!isStaff(requester.role)) throw new UploadAccessError();
  const [tpl] = await db
    .select({ businessId: agreementTemplates.businessId })
    .from(agreementTemplates)
    .where(eq(agreementTemplates.pdfR2Key, key))
    .limit(1);
  if (!tpl) throw new UploadAccessError();
  if (tpl.businessId !== requester.businessId) throw new UploadAccessError();
}
