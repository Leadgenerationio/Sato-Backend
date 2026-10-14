import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients, clientStatusEnum } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { ApiError } from '../utils/api-error.js';
import { campaignVisible, resolveCampaignRef, trafficSourceAccountsSql } from './ad-account-rules.service.js';
import { campaignInScope, clientColumnInScope } from './key-client-scope.service.js';

// MCP spec v1.0 discovery tools: list_clients, get_client, list_campaigns,
// get_campaign. Read only. Campaign IDs are the Stato UUID with the LeadByte
// number beside it. Stato campaign rows are created by the hourly LeadByte
// sync, never by a read, so a read-only key stays read-only.

export interface Page<T> { items: T[]; nextCursor: string | null }

const MAX_LIMIT = 100;
const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 25, 1), MAX_LIMIT);

// Keyset pagination by (name, id): the cursor is the name and id of the last row sent, so the next page starts right
// after it. Unlike a row offset, a client/campaign added or linked between pages can't make the next page skip or
// repeat rows — the same reason list_assets moved off offsets (issue #114). Both lists order by (name asc, id asc) and
// name is NOT NULL, so the sort key is never null and the tuple compares cleanly.
interface NameCursor { k: string; i: string }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseNameCursor(cursor: string | undefined): NameCursor | null {
  if (!cursor) return null;
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<NameCursor>;
    if (typeof c.k === 'string' && c.k.length <= 300 && typeof c.i === 'string' && UUID_RE.test(c.i)) return c as NameCursor;
  } catch { /* fall through */ }
  throw new ApiError('validation_failed', 'cursor is not valid.', { fields: [{ field: 'cursor', message: 'Use the nextCursor from the previous page, unchanged' }] });
}
const encodeNameCursor = (name: string, id: string): string => Buffer.from(JSON.stringify({ k: name, i: id } satisfies NameCursor)).toString('base64url');

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ─── clients ───

export interface ClientListItem { clientId: string; name: string; status: string | null; currency: string | null; country: string | null; adAccountCount: number }

export async function listClients(businessId: string, f: { q?: string; status?: (typeof clientStatusEnum.enumValues)[number]; limit?: number; cursor?: string }): Promise<Page<ClientListItem>> {
  const limit = clampLimit(f.limit);
  const after = parseNameCursor(f.cursor);
  const where: SQL[] = [eq(clients.businessId, businessId)];
  const inScope = clientColumnInScope(clients.id); // a key limited to some clients lists only those
  if (inScope) where.push(inScope);
  if (f.q) where.push(ilike(clients.companyName, like(f.q)));
  if (f.status) where.push(eq(clients.status, f.status));
  if (after) where.push(sql`(${clients.companyName}, ${clients.id}) > (${after.k}, ${after.i}::uuid)`);
  const rows = await db
    .select({ clientId: clients.id, name: clients.companyName, status: clients.status, currency: clients.currency, country: clients.addressCountry })
    .from(clients).where(and(...where)).orderBy(asc(clients.companyName), asc(clients.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const counts = page.length
    ? await db.select({ clientId: clientAdAccounts.clientId, n: sql<number>`count(*)::int` }).from(clientAdAccounts)
        .where(inArray(clientAdAccounts.clientId, page.map((r) => r.clientId))).groupBy(clientAdAccounts.clientId)
    : [];
  const countOf = new Map(counts.map((c) => [c.clientId, c.n]));
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r, status: r.status ?? null, currency: r.currency ?? null, country: r.country ?? null, adAccountCount: countOf.get(r.clientId) ?? 0 })),
    nextCursor: rows.length > limit && last ? encodeNameCursor(last.name, last.clientId) : null,
  };
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
    db.select({ n: sql<number>`count(*)::int` }).from(landingPages).where(and(eq(landingPages.clientId, c.id), sql`${landingPages.status} is distinct from 'archived'`)),
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

export interface CampaignListItem extends CampaignRef { currency: string | null; linkedClientIds: string[] }

export async function listCampaignsForMcp(businessId: string, f: { clientId?: string; status?: string; vertical?: string; q?: string; limit?: number; cursor?: string }): Promise<Page<CampaignListItem>> {
  const limit = clampLimit(f.limit);
  const after = parseNameCursor(f.cursor);
  if (f.clientId) {
    // A wrong ID is not_found, not an empty page that looks like "no campaigns".
    const [c] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, f.clientId), eq(clients.businessId, businessId))).limit(1);
    if (!c) throw new ApiError('not_found', 'That client does not exist in this business.', { hint: 'Use list_clients to find the right clientId.' });
  }
  const where: SQL[] = [campaignVisible(businessId)];
  const inScope = campaignInScope(campaigns.id); // a key limited to some clients lists only their campaigns
  if (inScope) where.push(inScope);
  if (f.clientId) where.push(sql`exists (select 1 from ${clientCampaigns} cc where cc.campaign_id = ${campaigns.id} and cc.client_id = ${f.clientId})`);
  // status is free-form text from LeadByte: compare without case.
  if (f.status) where.push(sql`lower(${campaigns.status}) = lower(${f.status})`);
  if (f.vertical) where.push(ilike(campaigns.vertical, like(f.vertical)));
  if (f.q) where.push(or(ilike(campaigns.name, like(f.q)), eq(campaigns.leadbyteCampaignId, f.q))!);
  if (after) where.push(sql`(${campaigns.name}, ${campaigns.id}) > (${after.k}, ${after.i}::uuid)`);
  const rows = await db
    .select({ campaignId: campaigns.id, leadbyteId: campaigns.leadbyteCampaignId, name: campaigns.name, vertical: campaigns.vertical, status: campaigns.status, currency: campaigns.currency })
    .from(campaigns).where(and(...where)).orderBy(asc(campaigns.name), asc(campaigns.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const links = page.length
    ? await db.select({ campaignId: clientCampaigns.campaignId, clientId: clientCampaigns.clientId }).from(clientCampaigns)
        .innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
        .where(and(inArray(clientCampaigns.campaignId, page.map((r) => r.campaignId)), eq(clients.businessId, businessId)))
    : [];
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      campaignId: r.campaignId, leadbyteId: r.leadbyteId ?? null, name: r.name, vertical: r.vertical ?? null, status: r.status ?? null, currency: r.currency ?? null,
      linkedClientIds: links.filter((l) => l.campaignId === r.campaignId).map((l) => l.clientId),
    })),
    nextCursor: rows.length > limit && last ? encodeNameCursor(last.name, last.campaignId) : null,
  };
}

export interface CampaignDetail {
  campaign: CampaignRef & { currency: string | null };
  linkedClients: Array<{ clientId: string; name: string }>;
  adAccounts: Array<{ platform: string; accountId: string; accountName: string | null; clientId: string | null }>;
  creativeCount: number;
}

export async function getCampaignForMcp(businessId: string, ref: string): Promise<CampaignDetail> {
  // Visibility is applied inside the lookup, so a campaign in another business
  // gets the same not_found as one that does not exist.
  const found = await resolveCampaignRef(ref, businessId);
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, found.id)).limit(1);
  // Accounts from the traffic sources are listed when this business owns the
  // campaign, or when the account is linked to one of its own clients. A shared
  // campaign (no buyer) is visible to every business, but the accounts another
  // business runs on it are not.
  const owned = sql`(
    exists (select 1 from client_campaigns cc join clients cl on cl.id = cc.client_id where cc.campaign_id = ${c.id} and cl.business_id = ${businessId})
    or exists (select 1 from campaigns k join clients cl on cl.id = k.client_id where k.id = ${c.id} and cl.business_id = ${businessId})
  )`;
  const [linked, accountRows, [cr]] = await Promise.all([
    db.select({ clientId: clients.id, name: clients.companyName }).from(clientCampaigns).innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
      .where(and(eq(clientCampaigns.campaignId, c.id), eq(clients.businessId, businessId))).orderBy(asc(clients.companyName)),
    db.execute(sql`
      with accs as (
        select s.platform, s.acc_id from (${trafficSourceAccountsSql(sql`ts.campaign_id = ${c.id}`)}) s
        union
        select a.platform, a.account_id from client_ad_accounts a where a.campaign_id = ${c.id} and a.business_id = ${businessId}
      )
      select distinct x.platform, x.acc_id as account_id, l.account_name, l.client_id
      from accs x left join client_ad_accounts l on l.platform = x.platform and l.account_id = x.acc_id and l.business_id = ${businessId}
      where x.acc_id is not null and x.acc_id <> '' and (l.client_id is not null or ${owned})
      order by x.platform, x.acc_id
    `) as unknown as Promise<Array<{ platform: string; account_id: string; account_name: string | null; client_id: string | null }>>,
    // A key limited to some clients counts only their assets (issue #94): on a shared campaign the total would leak other clients' activity.
    db.select({ n: sql<number>`count(*)::int` }).from(creatives).where(and(eq(creatives.campaignId, c.id), eq(creatives.isDeleted, false), isNull(creatives.archivedAt), clientColumnInScope(creatives.clientId))),
  ]);
  return {
    campaign: { campaignId: c.id, leadbyteId: c.leadbyteCampaignId ?? null, name: c.name, vertical: c.vertical ?? null, status: c.status ?? null, currency: c.currency ?? null },
    linkedClients: linked,
    adAccounts: accountRows.map((r) => ({ platform: toSpecPlatform(r.platform), accountId: r.account_id, accountName: r.account_name ?? null, clientId: r.client_id ?? null })),
    creativeCount: cr?.n ?? 0,
  };
}
