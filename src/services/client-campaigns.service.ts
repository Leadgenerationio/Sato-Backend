import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clients } from '../db/schema/clients.js';
import { resolveSatoCampaignId } from '../utils/resolve-campaign-id.js';
import type { AuthPayload } from '../types/index.js';

// Slice 2 Day 1: Sam Loom #40 — campaigns are now verticals (Solar Panels)
// with many client buyers underneath. This service handles the join table
// CRUD: list buyers for a campaign, add/remove a buyer, list campaigns a
// client buys from. The heavier LeadByte-backed campaign analytics stay in
// campaign.service.ts; this is just the relational glue.

export interface ClientCampaignLink {
  id: string;
  clientId: string;
  clientName: string;
  campaignId: string;
  campaignName: string;
  leadPrice: number | null;
  currency: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Resolve LeadByte numeric id or Sato uuid to a confirmed Sato uuid in scope
 * of the requester's business. Phase 1 is single-tenant so we only check the
 * campaign exists; multi-tenant scoping comes later.
 */
async function campaignSatoId(campaignId: string, requester: AuthPayload): Promise<string | null> {
  if (!requester.businessId) return null;
  const satoId = await resolveSatoCampaignId(campaignId);
  if (!satoId) return null;
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, satoId));
  return c ? satoId : null;
}

export async function listClientsForCampaign(
  campaignId: string,
  requester: AuthPayload,
): Promise<ClientCampaignLink[] | null> {
  const satoId = await campaignSatoId(campaignId, requester);
  if (!satoId) return null;
  const rows = await db
    .select({
      id: clientCampaigns.id,
      clientId: clientCampaigns.clientId,
      clientName: clients.companyName,
      campaignId: clientCampaigns.campaignId,
      campaignName: campaigns.name,
      leadPrice: clientCampaigns.leadPrice,
      currency: clientCampaigns.currency,
      status: clientCampaigns.status,
      startedAt: clientCampaigns.startedAt,
      endedAt: clientCampaigns.endedAt,
    })
    .from(clientCampaigns)
    .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
    .innerJoin(campaigns, eq(campaigns.id, clientCampaigns.campaignId))
    .where(eq(clientCampaigns.campaignId, satoId))
    .orderBy(desc(clientCampaigns.startedAt));

  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    leadPrice: r.leadPrice ? Number(r.leadPrice) : null,
    currency: r.currency ?? 'GBP',
    status: r.status ?? 'active',
    startedAt: (r.startedAt ?? new Date()).toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  }));
}

export async function listCampaignsForClient(
  clientId: string,
  requester: AuthPayload,
): Promise<ClientCampaignLink[] | null> {
  if (!requester.businessId) return null;
  const [c] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, requester.businessId)));
  if (!c) return null;

  const rows = await db
    .select({
      linkId: clientCampaigns.id,
      clientId: clientCampaigns.clientId,
      clientName: clients.companyName,
      campaignId: clientCampaigns.campaignId,
      campaignName: campaigns.name,
      // Yash (31-May-2026): FE Campaigns tab on Client Detail rendered
      // `${c.name}` (undefined) and "Remove undefined" because the BE
      // response was missing `name`/`vertical`/`costPerLead` and used
      // `id` as the link-row id rather than the campaign id (so the
      // unlink mutation also called with the wrong id). Include the
      // campaign-level fields the FE actually reads.
      vertical: campaigns.vertical,
      campaignStatus: campaigns.status,
      costPerLead: campaigns.costPerLead,
      leadPrice: clientCampaigns.leadPrice,
      currency: clientCampaigns.currency,
      status: clientCampaigns.status,
      startedAt: clientCampaigns.startedAt,
      endedAt: clientCampaigns.endedAt,
    })
    .from(clientCampaigns)
    .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
    .innerJoin(campaigns, eq(campaigns.id, clientCampaigns.campaignId))
    .where(eq(clientCampaigns.clientId, clientId))
    .orderBy(desc(clientCampaigns.startedAt));

  return rows.map((r) => ({
    // Use the campaign id so `unlink({ campaignId: c.id })` actually
    // hits the right row. Old behaviour returned the join-table id and
    // the unlink call silently used the wrong id → "Remove undefined"
    // button never actually removed anything.
    id: r.campaignId,
    linkId: r.linkId,
    clientId: r.clientId,
    clientName: r.clientName,
    campaignId: r.campaignId,
    name: r.campaignName,
    campaignName: r.campaignName,
    vertical: r.vertical ?? '',
    status: r.campaignStatus ?? r.status ?? 'active',
    linkStatus: r.status ?? 'active',
    costPerLead: r.costPerLead != null ? Number(r.costPerLead) : null,
    leadPrice: r.leadPrice ? Number(r.leadPrice) : null,
    currency: r.currency ?? 'GBP',
    startedAt: (r.startedAt ?? new Date()).toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  }));
}

export interface LinkClientToCampaignInput {
  clientId: string;
  leadPrice?: number;
  currency?: string;
}

export async function linkClientToCampaign(
  campaignId: string,
  input: LinkClientToCampaignInput,
  requester: AuthPayload,
): Promise<ClientCampaignLink | null> {
  const satoId = await campaignSatoId(campaignId, requester);
  if (!satoId) return null;
  // Verify the target client is also in scope.
  const [target] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.businessId, requester.businessId!)));
  if (!target) return null;

  // Upsert pattern: insert, on conflict (unique idx) update the price/status
  // and bump updated_at. Simpler than a SELECT-then-update round-trip.
  await db
    .insert(clientCampaigns)
    .values({
      campaignId: satoId,
      clientId: input.clientId,
      leadPrice: input.leadPrice != null ? String(input.leadPrice) : null,
      currency: input.currency || 'GBP',
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [clientCampaigns.clientId, clientCampaigns.campaignId],
      set: {
        leadPrice: input.leadPrice != null ? String(input.leadPrice) : null,
        currency: input.currency || 'GBP',
        status: 'active',
        endedAt: null,
        updatedAt: new Date(),
      },
    });

  const links = await listClientsForCampaign(satoId, requester);
  return links?.find((l) => l.clientId === input.clientId) ?? null;
}

export async function unlinkClientFromCampaign(
  campaignId: string,
  clientId: string,
  requester: AuthPayload,
): Promise<boolean> {
  const satoId = await campaignSatoId(campaignId, requester);
  if (!satoId) return false;
  // Idempotent — already-unlinked rows return true so the FE doesn't show
  // a "not found" toast on a double-click.
  await db
    .delete(clientCampaigns)
    .where(and(eq(clientCampaigns.campaignId, satoId), eq(clientCampaigns.clientId, clientId)));
  return true;
}
