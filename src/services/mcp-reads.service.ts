import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients, clientStatusEnum } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { canonicalPlatformSql } from '../utils/catchr-platform.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { ApiError } from '../utils/api-error.js';
import { normAccountSql, resolveCampaignRef } from './ad-account-rules.service.js';

// MCP spec v1.0 discovery tools: list_clients, get_client, list_campaigns,
// get_campaign. Read only. Campaign IDs are the Stato UUID with the LeadByte
// number beside it. Stato campaign rows are created by the hourly LeadByte
// sync, never by a read, so a read-only key stays read-only.

export interface Page<T> { items: T[]; nextCursor: string | null }

const MAX_LIMIT = 100;
function pageArgs(limit: number | undefined, cursor: string | undefined): { limit: number; offset: number } {
  const lim = Math.min(Math.max(limit ?? 25, 1), MAX_LIMIT);
  let offset = 0;
  if (cursor) {
    try {
      const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
      if (typeof o.o !== 'number' || o.o < 0 || !Number.isInteger(o.o)) throw new Error('bad');
      offset = o.o;
    } catch {
      throw new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] });
    }
  }
  return { limit: lim, offset };
}
const nextCursorOf = (offset: number, limit: number, got: number): string | null =>
  got > limit ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : null;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ─── clients ───

export interface ClientListItem { clientId: string; name: string; status: string | null; currency: string | null; country: string | null; adAccountCount: number }

export async function listClients(businessId: string, f: { q?: string; status?: string; limit?: number; cursor?: string }): Promise<Page<ClientListItem>> {
  const { limit, offset } = pageArgs(f.limit, f.cursor);
  const where: SQL[] = [eq(clients.businessId, businessId)];
  if (f.q) where.push(ilike(clients.companyName, like(f.q)));
  if (f.status) {
    if (!(clientStatusEnum.enumValues as readonly string[]).includes(f.status)) {
      throw new ApiError('validation_failed', `status must be one of ${clientStatusEnum.enumValues.join(', ')}.`, { fields: [{ field: 'status', message: `One of ${clientStatusEnum.enumValues.join(', ')}` }] });
    }
    where.push(eq(clients.status, f.status as (typeof clientStatusEnum.enumValues)[number]));
  }
  const rows = await db
    .select({
      clientId: clients.id, name: clients.companyName, status: clients.status, currency: clients.currency, country: clients.addressCountry,
      // Written out by hand: inside a select list Drizzle drops the table name, and a bare "id" would bind to the subquery's own table.
      adAccountCount: sql<number>`(select count(*)::int from ${clientAdAccounts} a where a.client_id = ${sql.raw('"clients"."id"')})`,
    })
    .from(clients).where(and(...where)).orderBy(asc(clients.companyName), asc(clients.id)).limit(limit + 1).offset(offset);
  return { items: rows.slice(0, limit).map((r) => ({ ...r, status: r.status ?? null, currency: r.currency ?? null, country: r.country ?? null })), nextCursor: nextCursorOf(offset, limit, rows.length) };
}

export interface CampaignRef { campaignId: string; leadbyteId: string | null; name: string; vertical: string | null; status: string | null }
export interface ClientDetail {
  client: { clientId: string; name: string; status: string | null; currency: string | null; country: string | null };
  adAccounts: Array<{ platform: string; accountId: string; accountName: string | null; campaignId: string | null; campaignName: string | null }>;
  campaigns: CampaignRef[];
  creativeCount: number;
  landingPageCount: number;
}

export async function getClient(businessId: string, clientId: string): Promise<ClientDetail> {
  const [c] = await db.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.businessId, businessId))).limit(1);
  if (!c) throw new ApiError('not_found', 'That client does not exist in this business.', { hint: 'Use list_clients to find the right clientId.' });
  const [accounts, camps, [cc], [lp]] = await Promise.all([
    db.select({ platform: clientAdAccounts.platform, accountId: clientAdAccounts.accountId, accountName: clientAdAccounts.accountName, campaignId: clientAdAccounts.campaignId, campaignName: campaigns.name })
      .from(clientAdAccounts).leftJoin(campaigns, eq(campaigns.id, clientAdAccounts.campaignId))
      .where(eq(clientAdAccounts.clientId, c.id)).orderBy(asc(clientAdAccounts.platform), asc(clientAdAccounts.accountId)),
    db.select({ campaignId: campaigns.id, leadbyteId: campaigns.leadbyteCampaignId, name: campaigns.name, vertical: campaigns.vertical, status: campaigns.status })
      .from(clientCampaigns).innerJoin(campaigns, eq(campaigns.id, clientCampaigns.campaignId))
      .where(eq(clientCampaigns.clientId, c.id)).orderBy(asc(campaigns.name)),
    db.select({ n: sql<number>`count(*)::int` }).from(creatives).where(and(eq(creatives.clientId, c.id), eq(creatives.isDeleted, false), isNull(creatives.archivedAt))),
    db.select({ n: sql<number>`count(*)::int` }).from(landingPages).where(and(eq(landingPages.clientId, c.id), sql`${landingPages.status} <> 'archived'`)),
  ]);
  return {
    client: { clientId: c.id, name: c.companyName, status: c.status ?? null, currency: c.currency ?? null, country: c.addressCountry ?? null },
    adAccounts: accounts.map((a) => ({ ...a, platform: toSpecPlatform(a.platform), accountName: a.accountName ?? null, campaignId: a.campaignId ?? null, campaignName: a.campaignName ?? null })),
    campaigns: camps.map((k) => ({ ...k, leadbyteId: k.leadbyteId ?? null, vertical: k.vertical ?? null, status: k.status ?? null })),
    creativeCount: cc?.n ?? 0,
    landingPageCount: lp?.n ?? 0,
  };
}

// ─── campaigns ───

/**
 * Campaigns this business can see: bought by one of its clients, or shared (no
 * buyer at all). `campaigns` has no business column, so a shared campaign is
 * visible to every business; fine with one business, revisit before a second
 * one is onboarded.
 */
function campaignVisible(businessId: string): SQL {
  return sql`(
    exists (select 1 from ${clientCampaigns} cc join ${clients} c on c.id = cc.client_id where cc.campaign_id = ${campaigns.id} and c.business_id = ${businessId})
    or (not exists (select 1 from ${clientCampaigns} cc where cc.campaign_id = ${campaigns.id})
        and (${campaigns.clientId} is null or exists (select 1 from ${clients} c where c.id = ${campaigns.clientId} and c.business_id = ${businessId})))
  )`;
}

export interface CampaignListItem extends CampaignRef { currency: string | null; linkedClientIds: string[] }

export async function listCampaignsForMcp(businessId: string, f: { clientId?: string; status?: string; vertical?: string; q?: string; limit?: number; cursor?: string }): Promise<Page<CampaignListItem>> {
  const { limit, offset } = pageArgs(f.limit, f.cursor);
  const where: SQL[] = [campaignVisible(businessId)];
  if (f.clientId) where.push(sql`exists (select 1 from ${clientCampaigns} cc where cc.campaign_id = ${campaigns.id} and cc.client_id = ${f.clientId})`);
  if (f.status) where.push(eq(campaigns.status, f.status));
  if (f.vertical) where.push(ilike(campaigns.vertical, like(f.vertical)));
  if (f.q) where.push(or(ilike(campaigns.name, like(f.q)), eq(campaigns.leadbyteCampaignId, f.q))!);
  const rows = await db
    .select({ campaignId: campaigns.id, leadbyteId: campaigns.leadbyteCampaignId, name: campaigns.name, vertical: campaigns.vertical, status: campaigns.status, currency: campaigns.currency })
    .from(campaigns).where(and(...where)).orderBy(asc(campaigns.name), asc(campaigns.id)).limit(limit + 1).offset(offset);
  const page = rows.slice(0, limit);
  const links = page.length
    ? await db.select({ campaignId: clientCampaigns.campaignId, clientId: clientCampaigns.clientId }).from(clientCampaigns)
        .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
        .where(and(inArray(clientCampaigns.campaignId, page.map((r) => r.campaignId)), eq(clients.businessId, businessId)))
    : [];
  return {
    items: page.map((r) => ({
      campaignId: r.campaignId, leadbyteId: r.leadbyteId ?? null, name: r.name, vertical: r.vertical ?? null, status: r.status ?? null, currency: r.currency ?? null,
      linkedClientIds: links.filter((l) => l.campaignId === r.campaignId).map((l) => l.clientId),
    })),
    nextCursor: nextCursorOf(offset, limit, rows.length),
  };
}

export interface CampaignDetail {
  campaign: CampaignRef & { currency: string | null };
  linkedClients: Array<{ clientId: string; name: string }>;
  adAccounts: Array<{ platform: string; accountId: string; accountName: string | null; clientId: string | null }>;
  creativeCount: number;
}

export async function getCampaignForMcp(businessId: string, ref: string): Promise<CampaignDetail> {
  const found = await resolveCampaignRef(ref);
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, found.id), campaignVisible(businessId))).limit(1);
  if (!c) throw new ApiError('not_found', `No campaign matches "${ref}" in this business.`, { hint: 'Use list_campaigns to see the campaigns you can use.' });
  const tsPlatform = sql.raw(`coalesce(${canonicalPlatformSql('ts.platform')}, lower(trim(ts.platform)))`);
  const [linked, accountRows, [cr]] = await Promise.all([
    db.select({ clientId: clients.id, name: clients.companyName }).from(clientCampaigns).innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
      .where(and(eq(clientCampaigns.campaignId, c.id), eq(clients.businessId, businessId))).orderBy(asc(clients.companyName)),
    db.execute(sql`
      with accs as (
        select ${tsPlatform} as platform, ${normAccountSql('ts.account_id')} as acc_id from traffic_sources ts
        where ts.campaign_id = ${c.id} and ts.is_active = true and ts.platform is not null and ts.account_id is not null and ts.account_id <> ''
        union
        select ${tsPlatform} as platform, ${normAccountSql('a.acc')} as acc_id from traffic_sources ts, jsonb_array_elements_text(ts.account_ids) as a(acc)
        where ts.campaign_id = ${c.id} and ts.is_active = true and ts.platform is not null
        union
        select a.platform, a.account_id from client_ad_accounts a where a.campaign_id = ${c.id} and a.business_id = ${businessId}
      )
      select distinct x.platform, x.acc_id as account_id, l.account_name, l.client_id
      from accs x left join client_ad_accounts l on l.platform = x.platform and l.account_id = x.acc_id and l.business_id = ${businessId}
      where x.acc_id is not null and x.acc_id <> ''
      order by x.platform, x.acc_id
    `) as unknown as Promise<Array<{ platform: string; account_id: string; account_name: string | null; client_id: string | null }>>,
    db.select({ n: sql<number>`count(*)::int` }).from(creatives).where(and(eq(creatives.campaignId, c.id), eq(creatives.isDeleted, false), isNull(creatives.archivedAt))),
  ]);
  return {
    campaign: { campaignId: c.id, leadbyteId: c.leadbyteCampaignId ?? null, name: c.name, vertical: c.vertical ?? null, status: c.status ?? null, currency: c.currency ?? null },
    linkedClients: linked,
    adAccounts: accountRows.map((r) => ({ platform: toSpecPlatform(r.platform), accountId: r.account_id, accountName: r.account_name ?? null, clientId: r.client_id ?? null })),
    creativeCount: cr?.n ?? 0,
  };
}
