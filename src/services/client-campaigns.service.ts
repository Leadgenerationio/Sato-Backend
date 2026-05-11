import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clients } from '../db/schema/clients.js';
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

async function campaignInScope(campaignId: string, requester: AuthPayload): Promise<boolean> {
  if (!requester.businessId) return false;
  // Phase 1 is single-tenant — every campaign in the DB belongs to the one
  // business. We only need to confirm the campaign row exists; multi-tenant
  // scoping comes back later via either an explicit campaigns.business_id
  // or a "must have at least one linked client in this business" rule. The
  // tighter rule was breaking the bootstrap case (link the FIRST buyer to a
  // brand-new vertical-only campaign with zero existing links).
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  return !!c;
}

export async function listClientsForCampaign(
  campaignId: string,
  requester: AuthPayload,
): Promise<ClientCampaignLink[] | null> {
  if (!(await campaignInScope(campaignId, requester))) return null;
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
    .where(eq(clientCampaigns.campaignId, campaignId))
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
    .where(eq(clientCampaigns.clientId, clientId))
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
  if (!(await campaignInScope(campaignId, requester))) return null;
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
      campaignId,
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

  const links = await listClientsForCampaign(campaignId, requester);
  return links?.find((l) => l.clientId === input.clientId) ?? null;
}

export async function unlinkClientFromCampaign(
  campaignId: string,
  clientId: string,
  requester: AuthPayload,
): Promise<boolean> {
  if (!(await campaignInScope(campaignId, requester))) return false;
  const deleted = await db
    .delete(clientCampaigns)
    .where(and(eq(clientCampaigns.campaignId, campaignId), eq(clientCampaigns.clientId, clientId)))
    .returning({ id: clientCampaigns.id });
  return deleted.length > 0;
}
