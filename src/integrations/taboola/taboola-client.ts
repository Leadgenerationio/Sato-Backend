// Taboola Backstage API — read-only client for the phase-3 creative sync
// (docs/creative-library-and-api-plan.md). Taboola "campaign items" are the
// native ads (title + thumbnail + landing URL).
//
// Auth: OAuth client_credentials with a Backstage API client that has access
// to each advertiser account (TABOOLA_CLIENT_ID / TABOOLA_CLIENT_SECRET).
// Unset → taboolaConfigured() is false and the sync job never calls Taboola.
//
// Account ids are Taboola's string ids (e.g. "willwriting-sc"). Matching is
// always on the id — some account NAMES don't match their ids.

import { logger } from '../../utils/logger.js';
import type { FetchLike } from '../meta/meta-ads-client.js';

export interface TaboolaConfig { clientId: string; clientSecret: string; baseUrl: string }

export function taboolaConfig(): TaboolaConfig {
  return {
    clientId: process.env.TABOOLA_CLIENT_ID ?? '',
    clientSecret: process.env.TABOOLA_CLIENT_SECRET ?? '',
    baseUrl: (process.env.TABOOLA_BASE_URL || 'https://backstage.taboola.com').replace(/\/+$/, ''),
  };
}

export function taboolaConfigured(): boolean {
  const c = taboolaConfig();
  return c.clientId.length > 0 && c.clientSecret.length > 0;
}

export interface TaboolaAccount { account_id: string; name?: string; partner_types?: string[]; type?: string }
export interface TaboolaCampaign { id: string | number; name?: string; status?: string; is_active?: boolean }
export interface TaboolaItem {
  id: string | number;
  campaign_id?: string | number;
  type?: string;
  url?: string;
  thumbnail_url?: string;
  title?: string;
  description?: string;
  status?: string;
  approval_state?: string;
  is_active?: boolean;
  creative_type?: string;
  video_url?: string;
  performance_video_data?: { video_url?: string; fallback_url?: string } | null;
}

export class TaboolaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TaboolaApiError';
  }
}

export interface TaboolaDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Token cache ────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Tests only. */
export function _resetTaboolaTokenCache(): void { cachedToken = null; }

export async function getAccessToken(deps: TaboolaDeps = {}): Promise<string> {
  const now = (deps.now ?? Date.now)();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;
  const { clientId, clientSecret, baseUrl } = taboolaConfig();
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const res = await fetchImpl(`${baseUrl}/backstage/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) throw new TaboolaApiError(`Taboola sign-in failed (${res.status})`, res.status);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new TaboolaApiError('Taboola sign-in returned no token', res.status);
  // Refresh a minute early so a long sync never uses an expiring token.
  const ttlMs = Math.max(60, Number(body.expires_in ?? 43_200) - 60) * 1000;
  cachedToken = { value: body.access_token, expiresAt: now + ttlMs };
  return cachedToken.value;
}

async function backstageGet<T>(path: string, deps: TaboolaDeps): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = deps.sleep ?? realSleep;
  const maxRetries = deps.maxRetries ?? 5;
  const { baseUrl } = taboolaConfig();
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(deps);
    const res = await fetchImpl(`${baseUrl}/backstage/api/1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401 && !refreshed) {
      // Token revoked/expired early — fetch a fresh one once.
      cachedToken = null;
      refreshed = true;
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      let msg = res.statusText;
      try { const b = (await res.json()) as { message?: string }; if (b.message) msg = b.message; } catch { /* non-JSON */ }
      throw new TaboolaApiError(`Taboola API ${res.status}: ${msg}`, res.status);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    logger.warn({ status: res.status, attempt, waitMs: wait, path }, 'Taboola API throttled/failed — backing off');
    await sleep(wait);
  }
}

const enc = (s: string | number) => encodeURIComponent(String(s));

/** Accounts this API client may read (the network + its advertisers). */
export async function listAllowedAccounts(deps: TaboolaDeps = {}): Promise<TaboolaAccount[]> {
  const body = await backstageGet<{ results?: TaboolaAccount[] }>('/users/current/allowed-accounts', deps);
  return body.results ?? [];
}

export async function listCampaigns(accountId: string, deps: TaboolaDeps = {}): Promise<TaboolaCampaign[]> {
  const body = await backstageGet<{ results?: TaboolaCampaign[] }>(`/${enc(accountId)}/campaigns`, deps);
  return body.results ?? [];
}

export async function listCampaignItems(accountId: string, campaignId: string | number, deps: TaboolaDeps = {}): Promise<TaboolaItem[]> {
  const body = await backstageGet<{ results?: TaboolaItem[] }>(`/${enc(accountId)}/campaigns/${enc(campaignId)}/items/`, deps);
  return body.results ?? [];
}

/** Campaign statuses worth pulling items from. Terminated campaigns are skipped. */
export const TABOOLA_LIVE_CAMPAIGN_STATUSES = new Set(['RUNNING', 'PAUSED', 'PENDING_APPROVAL', 'PENDING_START_DATE', 'DEPLETED', 'DEPLETED_MONTHLY']);

/** Every campaign (non-terminated) with its items, for one account. */
export async function listAccountItems(
  accountId: string,
  deps: TaboolaDeps = {},
): Promise<Array<{ campaign: TaboolaCampaign; items: TaboolaItem[] }>> {
  const campaigns = await listCampaigns(accountId, deps);
  const out: Array<{ campaign: TaboolaCampaign; items: TaboolaItem[] }> = [];
  for (const campaign of campaigns) {
    if (campaign.status && !TABOOLA_LIVE_CAMPAIGN_STATUSES.has(campaign.status)) continue;
    out.push({ campaign, items: await listCampaignItems(accountId, campaign.id, deps) });
  }
  return out;
}
