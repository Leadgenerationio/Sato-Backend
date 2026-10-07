import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creatives } from '../db/schema/creatives.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { landingPages } from '../db/schema/landing-pages.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { ApiError } from '../utils/api-error.js';
import { campaigns } from '../db/schema/campaigns.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { resolveCampaignRef } from './ad-account-rules.service.js';

// MCP spec v1.0 §3, step 1h: a key can be limited to some clients
// (api_keys.allowed_client_ids; NULL = every client in its business). This file
// is the one place that decides what such a key may see:
//   - a client outside the list looks exactly like a client that does not exist
//     (not_found), the same rule as another business's data;
//   - an asset is visible only when its client is on the list (an asset with no
//     client, shared on a campaign, is not visible to a limited key);
//   - a campaign is visible when it is linked to a client on the list.
// The MCP server runs every tool inside runWithClientScope, so the list
// queries can read the limit without each tool passing it along.

/** The clients a key may use, or null for every client in its business. An empty list allows none. */
export type ClientScope = readonly string[] | null;

const store = new AsyncLocalStorage<ClientScope>();

export function runWithClientScope<T>(scope: ClientScope, fn: () => Promise<T>): Promise<T> {
  return store.run(scope, fn);
}

/** The limit of the key making this call, or null outside a limited call. */
export function currentClientScope(): ClientScope {
  return store.getStore() ?? null;
}

export function clientAllowed(clientId: string | null | undefined, scope: ClientScope = currentClientScope()): boolean {
  if (!scope) return true;
  return Boolean(clientId) && scope.includes(clientId!);
}

/** SQL condition "this client id column is on the list", or undefined when the key is not limited. */
export function clientColumnInScope(column: AnyColumn | SQL, scope: ClientScope = currentClientScope()): SQL | undefined {
  if (!scope) return undefined;
  if (scope.length === 0) return sql`false`;
  return inArray(column as AnyColumn, [...scope]);
}

const idList = (scope: readonly string[]): SQL => sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `);

/** A campaign is visible to a limited key when it is linked to one of its clients. */
export function campaignInScope(campaignIdColumn: AnyColumn | SQL, scope: ClientScope = currentClientScope()): SQL | undefined {
  if (!scope) return undefined;
  if (scope.length === 0) return sql`false`;
  const ids = idList(scope);
  return sql`(
    exists (select 1 from client_campaigns cc where cc.campaign_id = ${campaignIdColumn} and cc.client_id in (${ids}))
    or exists (select 1 from campaigns k where k.id = ${campaignIdColumn} and k.client_id in (${ids}))
  )`;
}

const hiddenClient = () => new ApiError('not_found', 'That client does not exist in this business.', {
  hint: 'Use list_clients to see the clients this key can use.',
});

/** Throws not_found when a client is outside the key's list. */
export function assertClientInScope(clientId: string | null | undefined, scope: ClientScope = currentClientScope()): void {
  if (!clientAllowed(clientId, scope)) throw hiddenClient();
}

/** An asset whose client is outside the key's list is not_found, like an asset that does not exist. */
export async function assertCreativeInScope(businessId: string, creativeId: string, scope: ClientScope): Promise<void> {
  if (!scope) return;
  const [c] = await db.select({ clientId: creatives.clientId }).from(creatives)
    .innerJoin(clients, eq(clients.id, creatives.clientId))
    .where(and(eq(creatives.id, creativeId), eq(clients.businessId, businessId)));
  if (!c || !clientAllowed(c.clientId, scope)) {
    throw new ApiError('not_found', 'That asset does not exist.', { hint: 'Use list_assets to find the creativeId.' });
  }
}

/** An ad link is reached through its asset. */
export async function assertAdLinkInScope(businessId: string, adLinkId: string, scope: ClientScope): Promise<void> {
  if (!scope) return;
  const [l] = await db.select({ creativeId: creativeAdLinks.creativeId }).from(creativeAdLinks)
    .where(and(eq(creativeAdLinks.id, adLinkId), eq(creativeAdLinks.businessId, businessId)));
  if (!l) return; // the tool answers not_found itself
  try {
    await assertCreativeInScope(businessId, l.creativeId, scope);
  } catch {
    throw new ApiError('not_found', 'That ad link does not exist.', { hint: 'Use get_asset to see the ad links of an asset.' });
  }
}

export async function assertLandingPageInScope(businessId: string, landingPageId: string, scope: ClientScope): Promise<void> {
  if (!scope) return;
  const [lp] = await db.select({ clientId: landingPages.clientId }).from(landingPages)
    .innerJoin(clients, eq(clients.id, landingPages.clientId))
    .where(and(eq(landingPages.id, landingPageId), eq(clients.businessId, businessId)));
  if (!lp) return; // the tool answers not_found itself
  if (!clientAllowed(lp.clientId, scope)) {
    throw new ApiError('not_found', 'That landing page does not exist.', { hint: 'Use list_landing_pages to find the landingPageId.' });
  }
}

/**
 * The client an ad account is linked to in this business, or null when it is not linked. A limited key may not use an
 * account linked to a client outside its list: it reads as not linked at all, so nothing about that client leaks.
 */
export async function assertAccountInScope(businessId: string, platform: string, accountId: string, scope: ClientScope): Promise<void> {
  if (!scope) return;
  const stored = normalisePlatform(platform);
  const [link] = await db.select({ clientId: clientAdAccounts.clientId }).from(clientAdAccounts)
    .where(and(eq(clientAdAccounts.businessId, businessId), eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, normaliseAccountId(platform, accountId))));
  if (link && !clientAllowed(link.clientId, scope)) {
    throw new ApiError('not_found', `The ad account ${accountId} is not available to this key.`, {
      hint: 'This key is limited to some clients, and that account belongs to another one. Use a key for that client.',
    });
  }
}

/** A campaign not linked to any client on the key's list is not_found (Stato UUID or LeadByte number). */
export async function assertCampaignInScope(businessId: string, ref: string, scope: ClientScope): Promise<void> {
  if (!scope) return;
  let id: string;
  try { id = (await resolveCampaignRef(ref, businessId)).id; } catch { return; } // the tool answers not_found itself
  const [row] = await db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.id, id), campaignInScope(campaigns.id, scope)));
  if (!row) throw new ApiError('not_found', 'That campaign does not exist.', { hint: 'Use list_campaigns to find the campaignId.' });
}
