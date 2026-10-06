import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clients } from '../db/schema/clients.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clientCampaigns } from '../db/schema/client-campaigns.js';
import { clientAdAccounts } from '../db/schema/client-ad-accounts.js';
import { creativeAdLinks } from '../db/schema/creative-ad-links.js';
import { normaliseAccountId } from '../utils/catchr-platform.js';
import { resolveSatoCampaignId } from '../utils/resolve-campaign-id.js';
import { toAccountPlatform, toCreativePlatform, apiPlatformOut } from '../utils/api-platform.js';
import { ApiError } from '../utils/api-error.js';

// The ownership rules of MCP spec v1.0 §2.1, shared by every write that files
// something under a client (upload_asset, link_ad_platform_ids, …):
//   - Client from account: platform + accountId decides the client.
//   - account_client_mismatch: a clientId that disagrees with the account.
//   - account_not_linked: never guess a client from names.
//   - campaign_client_mismatch: the campaign must be one of the client's
//     campaigns, or a shared campaign with no client.
//   - One account can feed several campaigns: with no campaignId and more
//     than one candidate, the caller must choose (Sam, 6 Oct: no guessing).
// Nothing here writes.

export interface AdAccountRef {
  /** API spelling (meta, google, …). */
  platform: string;
  /** Normalised account ID (no act_, no dashes). */
  accountId: string;
  linkId: string;
  clientId: string;
  clientName: string;
  /** The campaign set on the account link, if any. */
  defaultCampaignId: string | null;
}

export interface CampaignChoice {
  campaignId: string;
  name: string;
  leadbyteId: string | null;
  /** account = the campaign set on the account link; ad_link = used by an ad on this account. */
  from: 'account' | 'ad_link';
}

/** The client that owns an ad account in this business, or account_not_linked. */
export async function requireLinkedAccount(businessId: string, platform: string, accountId: string): Promise<AdAccountRef> {
  const stored = toAccountPlatform(platform);
  if (!stored) {
    throw new ApiError('validation_failed', `Unknown platform "${platform}"`, {
      fields: ['platform'], hint: 'Use one of meta, google, tiktok, taboola, bing.',
    });
  }
  const id = normaliseAccountId(stored, accountId);
  const [row] = await db
    .select({ linkId: clientAdAccounts.id, clientId: clients.id, clientName: clients.companyName, campaignId: clientAdAccounts.campaignId })
    .from(clientAdAccounts)
    .innerJoin(clients, eq(clients.id, clientAdAccounts.clientId))
    .where(and(eq(clientAdAccounts.businessId, businessId), eq(clientAdAccounts.platform, stored), eq(clientAdAccounts.accountId, id)));
  if (!row) {
    throw new ApiError('account_not_linked', `Ad account ${id} on ${apiPlatformOut(stored)} is not linked to a client in Stato`, {
      fields: ['accountId'],
      hint: 'Ask which client and campaign it belongs to, then call link_ad_account. Stato never guesses a client from names.',
    });
  }
  return {
    platform: apiPlatformOut(stored)!, accountId: id, linkId: row.linkId,
    clientId: row.clientId, clientName: row.clientName, defaultCampaignId: row.campaignId ?? null,
  };
}

/** Campaigns an ad account is known to feed: the one on the account link plus any used by its ads. */
export async function campaignsForAccount(businessId: string, account: AdAccountRef): Promise<CampaignChoice[]> {
  const creativePlatform = toCreativePlatform(account.platform);
  const fromLinks = creativePlatform
    ? await db.selectDistinct({ campaignId: creativeAdLinks.campaignId }).from(creativeAdLinks)
        .where(and(
          eq(creativeAdLinks.businessId, businessId),
          eq(creativeAdLinks.platform, creativePlatform),
          eq(creativeAdLinks.platformAccountId, account.accountId),
          ne(creativeAdLinks.status, 'removed'),
        ))
    : [];
  const ids = new Map<string, CampaignChoice['from']>();
  if (account.defaultCampaignId) ids.set(account.defaultCampaignId, 'account');
  for (const r of fromLinks) if (r.campaignId && !ids.has(r.campaignId)) ids.set(r.campaignId, 'ad_link');
  if (ids.size === 0) return [];
  const rows = await db.select({ id: campaigns.id, name: campaigns.name, leadbyteId: campaigns.leadbyteCampaignId })
    .from(campaigns).where(inArray(campaigns.id, [...ids.keys()]));
  return rows
    .map((r) => ({ campaignId: r.id, name: r.name, leadbyteId: r.leadbyteId ?? null, from: ids.get(r.id)! }))
    .sort((a, b) => (a.from === b.from ? a.name.localeCompare(b.name) : a.from === 'account' ? -1 : 1));
}

/**
 * Campaign UUID (or LeadByte number) → the Stato campaign, checked against
 * the client: it must be one of the client's campaigns, or have no client at
 * all (shared). Never creates a campaign.
 */
export async function requireCampaignForClient(businessId: string, campaignIdOrLeadbyteId: string, clientId: string | null): Promise<{ id: string; name: string }> {
  const id = await resolveSatoCampaignId(campaignIdOrLeadbyteId);
  const [campaign] = id
    ? await db.select({ id: campaigns.id, name: campaigns.name, legacyClientId: campaigns.clientId }).from(campaigns).where(eq(campaigns.id, id))
    : [];
  if (!campaign) {
    throw new ApiError('not_found', `Campaign ${campaignIdOrLeadbyteId} not found`, {
      fields: ['campaignId'], hint: 'Use the Stato campaign UUID (campaignId from list_campaigns) or its LeadByte number.',
    });
  }
  const buyers = await db.select({ clientId: clientCampaigns.clientId, businessId: clients.businessId })
    .from(clientCampaigns).innerJoin(clients, eq(clients.id, clientCampaigns.clientId))
    .where(eq(clientCampaigns.campaignId, campaign.id));
  if (campaign.legacyClientId) {
    const [legacy] = await db.select({ businessId: clients.businessId }).from(clients).where(eq(clients.id, campaign.legacyClientId));
    if (legacy) buyers.push({ clientId: campaign.legacyClientId, businessId: legacy.businessId });
  }
  // A campaign whose buyers are all in another business does not exist here.
  if (buyers.length > 0 && !buyers.some((b) => b.businessId === businessId)) {
    throw new ApiError('not_found', `Campaign ${campaignIdOrLeadbyteId} not found`, { fields: ['campaignId'] });
  }
  const shared = buyers.length === 0;
  if (!shared && clientId && !buyers.some((b) => b.clientId === clientId)) {
    throw new ApiError('campaign_client_mismatch', `Campaign "${campaign.name}" is not one of this client's campaigns`, {
      fields: ['campaignId'],
      hint: "Pick a campaign the client buys on (get_client lists them), or leave campaignId out to use the ad account's campaign.",
    });
  }
  return { id: campaign.id, name: campaign.name };
}

export interface OwnershipInput {
  businessId: string;
  clientId?: string | null;
  platform?: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  /** Where clientId came from, for the error text: the caller's input, or the creative being linked. */
  clientFrom?: 'input' | 'creative';
}

export interface Ownership {
  clientId: string | null;
  campaignId: string | null;
  account: AdAccountRef | null;
}

/**
 * Who an asset or ad link belongs to. The ad account wins: with platform +
 * accountId the client comes from the account link, and a clientId that
 * disagrees is refused. Without an account, clientId (if any) is checked to
 * be in the business. The campaign is then checked against the client.
 */
export async function resolveOwnership(input: OwnershipInput): Promise<Ownership> {
  const { businessId } = input;
  if (input.accountId && !input.platform) {
    throw new ApiError('validation_failed', 'accountId needs platform', { fields: ['platform'] });
  }
  let account: AdAccountRef | null = null;
  let clientId = input.clientId ?? null;

  if (input.platform && input.accountId) {
    account = await requireLinkedAccount(businessId, input.platform, input.accountId);
    if (clientId && clientId !== account.clientId) {
      const fromCreative = input.clientFrom === 'creative';
      throw new ApiError('account_client_mismatch', `Ad account ${account.accountId} belongs to ${account.clientName}, not to ${fromCreative ? "this creative's client" : 'the client you sent'}`, {
        fields: fromCreative ? ['accountId'] : ['clientId', 'accountId'],
        hint: fromCreative
          ? 'Use an ad account that belongs to the same client as the creative. Nothing was saved.'
          : 'Leave clientId out (the ad account decides the client), or use an ad account that belongs to this client. Nothing was saved.',
        details: { accountClientId: account.clientId },
      });
    }
    clientId = account.clientId;
  } else if (clientId) {
    const [row] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));
    if (!row) throw new ApiError('not_found', `Client ${clientId} not found`, { fields: ['clientId'], hint: 'list_clients shows the client IDs.' });
  }

  let campaignId: string | null = null;
  if (input.campaignId) {
    campaignId = (await requireCampaignForClient(businessId, input.campaignId, clientId)).id;
  } else if (account) {
    const choices = await campaignsForAccount(businessId, account);
    if (choices.length === 1) {
      campaignId = choices[0]!.campaignId;
    } else if (choices.length > 1) {
      throw new ApiError('validation_failed', `Ad account ${account.accountId} feeds ${choices.length} campaigns: send campaignId`, {
        fields: ['campaignId'],
        hint: `Choose one: ${choices.map((c) => `${c.name} (${c.campaignId})`).join(', ')}.`,
        details: { campaigns: choices },
      });
    }
  }
  return { clientId, campaignId, account };
}
