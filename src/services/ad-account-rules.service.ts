import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { canonicalPlatformSql, normaliseAccountId } from '../utils/catchr-platform.js';
import { normalisePlatform } from './ad-account-links.service.js';
import { toSpecPlatform } from '../utils/platform-names.js';
import { ApiError, moveRequiresConfirm, campaignClientMismatch } from '../utils/api-error.js';

// MCP spec v1.0 section 2.1, ad-account side: the account decides the client,
// a move needs confirmation, and a campaign must belong to the client.

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Caller {
  businessId: string;
  /** The user who owns the key, or null when it has none. */
  userId: string | null;
  /** The API key making the call, when it is a key. */
  keyId: string | null;
}

/** An API key with no owner is shaped as the nil user; treat that as "no user". */
export function realUserId(userId: string | null | undefined): string | null {
  return userId && userId !== NIL_UUID ? userId : null;
}

/** A campaign by its Stato UUID, or by the LeadByte number (Sam's decision 1). Never creates one. */
export async function resolveCampaignRef(ref: string): Promise<{ id: string; name: string }> {
  const r = ref.trim();
  const [row] = UUID_SHAPE.test(r)
    ? await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, r)).limit(1)
    : await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.leadbyteCampaignId, r)).limit(1);
  if (!row) {
    throw new ApiError('not_found', `No campaign matches "${ref}".`, {
      hint: 'Use the Stato campaignId (a UUID) from list_campaigns, or the LeadByte campaign number. Stato does not create campaigns from a lookup.',
    });
  }
  return row;
}

export interface AccountOwner {
  platform: string;
  accountId: string;
  client: { id: string; name: string; currency: string | null };
  /** The campaign saved on the ad-account link, used only as a default. */
  campaign: { id: string; name: string } | null;
  /** Every campaign whose ad-account links include this account. */
  campaigns: Array<{ campaignId: string; name: string }>;
  /** True when the account feeds more than one campaign: the caller must send campaignId. */
  campaignRequired: boolean;
}

export async function campaignsForAccount(storedPlatform: string, accountId: string): Promise<Array<{ campaignId: string; name: string }>> {
  const tsPlatform = sql.raw(`coalesce(${canonicalPlatformSql('ts.platform')}, lower(trim(ts.platform)))`);
  const rows = (await db.execute(sql`
    with accs as (
      select ts.campaign_id, ${tsPlatform} as platform, ts.account_id as acc_id
      from traffic_sources ts
      where ts.is_active = true and ts.platform is not null and ts.account_id is not null and ts.account_id <> ''
      union
      select ts.campaign_id, ${tsPlatform} as platform, jsonb_array_elements_text(ts.account_ids) as acc_id
      from traffic_sources ts
      where ts.is_active = true and ts.platform is not null
    )
    select distinct c.id as campaign_id, c.name as campaign_name
    from accs a join campaigns c on c.id = a.campaign_id
    where a.platform = ${storedPlatform} and a.acc_id = ${accountId}
    order by c.name
  `)) as unknown as Array<{ campaign_id: string; campaign_name: string }>;
  return rows.map((r) => ({ campaignId: r.campaign_id, name: r.campaign_name }));
}

/** find_client_by_ad_account. An account no client owns is account_not_linked, never a guess. */
export async function findAccountOwner(businessId: string, platformInput: string, accountIdInput: string): Promise<AccountOwner> {
  const stored = normalisePlatform(platformInput);
  const accountId = normaliseAccountId(platformInput, accountIdInput);
  const [row] = await db
    .select({ clientId: clients.id, name: clients.companyName, currency: clients.currency, campaignId: campaigns.id, campaignName: campaigns.name })
    .from(clientAdAccounts)
    .innerJoin(clients, eq(clients.id, clientAdAccounts.clientId))
    .leftJoin(campaigns, eq(campaigns.id, clientAdAccounts.campaignId))
    .where(and(eq(clientAdAccounts.businessId, businessId), eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, accountId)));
  if (!row) {
    throw new ApiError('account_not_linked', `The ${toSpecPlatform(stored)} account ${accountId} is not linked to a client.`, {
      hint: 'Stop and ask the owner which client it belongs to, then call link_ad_account. Do not guess from names.',
    });
  }
  const list = await campaignsForAccount(stored, accountId);
  return {
    platform: toSpecPlatform(stored),
    accountId,
    client: { id: row.clientId, name: row.name, currency: row.currency ?? null },
    campaign: row.campaignId ? { id: row.campaignId, name: row.campaignName ?? '' } : null,
    campaigns: list,
    campaignRequired: list.length > 1,
  };
}

export interface LinkInput {
  clientId: string;
  platform: string;
  accountId: string;
  campaignId?: string | null;
  accountName?: string | null;
  currency?: string | null;
  confirmMove?: boolean;
}

export type LinkResultKind = 'created' | 'updated' | 'unchanged' | 'moved';

export interface LinkResult {
  result: LinkResultKind;
  link: {
    platform: string;
    accountId: string;
    clientId: string;
    clientName: string;
    campaignId: string | null;
    campaignName: string | null;
    movedFromClientId: string | null;
    movedAt: string | null;
  };
  before: Record<string, unknown> | null;
}

/** A campaign is valid for a client when the client buys it, or it is shared (no buyer links at all). */
async function assertCampaignBelongsToClient(clientId: string, campaignId: string): Promise<void> {
  const [buyer] = await db.select({ id: clientCampaigns.id }).from(clientCampaigns)
    .where(and(eq(clientCampaigns.clientId, clientId), eq(clientCampaigns.campaignId, campaignId))).limit(1);
  if (buyer) return;
  const [anyBuyer] = await db.select({ id: clientCampaigns.id }).from(clientCampaigns).where(eq(clientCampaigns.campaignId, campaignId)).limit(1);
  const [legacy] = await db.select({ clientId: campaigns.clientId }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!anyBuyer && (!legacy?.clientId || legacy.clientId === clientId)) return; // shared campaign, no client
  throw campaignClientMismatch();
}

/** link_ad_account and POST /clients/:id/ad-accounts. Never moves an account silently. */
export async function linkAdAccount(caller: Caller, input: LinkInput): Promise<LinkResult> {
  const stored = normalisePlatform(input.platform);
  const accountId = normaliseAccountId(input.platform, input.accountId);
  if (!accountId) {
    throw new ApiError('validation_failed', 'accountId is required.', { fields: [{ field: 'accountId', message: 'Required' }] });
  }

  const [client] = await db.select({ id: clients.id, name: clients.companyName }).from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.businessId, caller.businessId))).limit(1);
  if (!client) throw new ApiError('not_found', 'That client does not exist in this business.', { hint: 'Use list_clients to find the right clientId.' });

  let campaign: { id: string; name: string } | null = null;
  if (input.campaignId) {
    campaign = await resolveCampaignRef(input.campaignId);
    await assertCampaignBelongsToClient(client.id, campaign.id);
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(clientAdAccounts)
      .where(and(eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, accountId)));
    if (existing && existing.businessId !== caller.businessId) {
      throw new ApiError('account_client_mismatch', 'That ad account is linked by another business.', { hint: 'Nothing was saved.' });
    }
    const out = (row: { clientId: string; campaignId: string | null; movedFromClientId: string | null; movedAt: Date | null }, kind: LinkResultKind, before: LinkResult['before']): LinkResult => ({
      result: kind,
      before,
      link: {
        platform: toSpecPlatform(stored),
        accountId,
        clientId: row.clientId,
        clientName: client.name,
        campaignId: row.campaignId,
        campaignName: campaign && row.campaignId === campaign.id ? campaign.name : null,
        movedFromClientId: row.movedFromClientId,
        movedAt: row.movedAt ? row.movedAt.toISOString() : null,
      },
    });
    const who = { linkedBy: caller.userId, linkedByKeyId: caller.keyId };

    if (!existing) {
      const [row] = await tx.insert(clientAdAccounts).values({
        businessId: caller.businessId, platform: stored, accountId, accountName: input.accountName ?? null,
        clientId: client.id, campaignId: campaign?.id ?? null, currency: input.currency ?? null, ...who,
      }).returning();
      return out(row!, 'created', null);
    }

    const before = { clientId: existing.clientId, campaignId: existing.campaignId, accountName: existing.accountName, currency: existing.currency };
    if (existing.clientId !== client.id) {
      if (!input.confirmMove) {
        const [prev] = await tx.select({ name: clients.companyName }).from(clients).where(eq(clients.id, existing.clientId)).limit(1);
        throw moveRequiresConfirm(prev?.name ?? 'another client');
      }
      const [row] = await tx.update(clientAdAccounts).set({
        clientId: client.id, campaignId: campaign?.id ?? null, movedFromClientId: existing.clientId, movedAt: new Date(),
        accountName: input.accountName ?? existing.accountName, currency: input.currency ?? existing.currency, updatedAt: new Date(), ...who,
      }).where(eq(clientAdAccounts.id, existing.id)).returning();
      return out(row!, 'moved', before);
    }

    const sameCampaign = (existing.campaignId ?? null) === (campaign?.id ?? existing.campaignId ?? null);
    const nameChange = input.accountName != null && input.accountName !== existing.accountName;
    const currencyChange = input.currency != null && input.currency !== existing.currency;
    if (sameCampaign && !nameChange && !currencyChange) return out(existing, 'unchanged', before);
    const [row] = await tx.update(clientAdAccounts).set({
      campaignId: campaign ? campaign.id : existing.campaignId,
      accountName: input.accountName ?? existing.accountName, currency: input.currency ?? existing.currency, updatedAt: new Date(), ...who,
    }).where(eq(clientAdAccounts.id, existing.id)).returning();
    return out(row!, 'updated', before);
  });
}
