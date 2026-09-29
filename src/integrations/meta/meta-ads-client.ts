// Meta Marketing API (Graph API) — read-only client for the phase-3
// creative sync (docs/creative-library-and-api-plan.md). Pulls every ad of
// an ad account with its creative, so a live ad lands under the client that
// owns the ad account without a manual upload.
//
// Auth: a Business Manager **system user token** with `ads_read` on every ad
// account (META_SYSTEM_USER_TOKEN). Unset → metaConfigured() is false and the
// sync job never calls Meta.
//
// Config is read at call time (not import time) so tests can set/unset it.

import { logger } from '../../utils/logger.js';

export interface MetaConfig {
  token: string;
  version: string;
  baseUrl: string;
}

export function metaConfig(): MetaConfig {
  return {
    token: process.env.META_SYSTEM_USER_TOKEN ?? '',
    version: process.env.META_GRAPH_VERSION || 'v21.0',
    baseUrl: (process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
  };
}

export function metaConfigured(): boolean {
  return metaConfig().token.length > 0;
}

// ─── Response shapes (only the fields we request) ───────────────────────

export interface MetaAdImage { hash?: string; url?: string; image_crops?: unknown }
export interface MetaAdVideo { video_id?: string; thumbnail_url?: string }

export interface MetaCreative {
  id: string;
  name?: string;
  title?: string;
  body?: string;
  image_url?: string;
  image_hash?: string;
  video_id?: string;
  thumbnail_url?: string;
  effective_object_story_id?: string;
  object_story_spec?: {
    page_id?: string;
    link_data?: {
      link?: string;
      message?: string;
      name?: string;
      description?: string;
      picture?: string;
      image_hash?: string;
      call_to_action?: { type?: string; value?: { link?: string } };
      child_attachments?: Array<{
        link?: string;
        name?: string;
        description?: string;
        picture?: string;
        image_hash?: string;
        video_id?: string;
      }>;
    };
    video_data?: {
      video_id?: string;
      image_url?: string;
      image_hash?: string;
      title?: string;
      message?: string;
      link_description?: string;
      call_to_action?: { type?: string; value?: { link?: string } };
    };
  };
  asset_feed_spec?: {
    images?: MetaAdImage[];
    videos?: MetaAdVideo[];
    titles?: Array<{ text?: string }>;
    bodies?: Array<{ text?: string }>;
    link_urls?: Array<{ website_url?: string; display_url?: string }>;
  };
}

export interface MetaAd {
  id: string;
  name?: string;
  effective_status?: string;
  updated_time?: string;
  adset?: { id: string; name?: string };
  campaign?: { id: string; name?: string };
  creative?: MetaCreative;
}

export interface MetaVideo { id: string; source?: string; length?: number; picture?: string }
export interface MetaImageInfo { hash: string; url?: string; permalink_url?: string; width?: number; height?: number }

interface GraphPage<T> { data: T[]; paging?: { next?: string; cursors?: { after?: string } } }
interface GraphErrorBody { error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string } }

export class MetaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
    this.name = 'MetaApiError';
  }
}

// ─── Transport ──────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MetaDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Graph error codes that mean "throttled — wait and retry". */
export const META_THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80004]);

/**
 * Parse `X-Business-Use-Case-Usage` and return how long to wait before the
 * next call. Meta sends `{ "<accountId>": [{ call_count, total_cputime,
 * total_time, estimated_time_to_regain_access }] }` (percentages + minutes).
 * Waits when any usage is ≥ 90% or Meta names a regain time.
 */
export function usageDelayMs(header: string | null | undefined): number {
  if (!header) return 0;
  let parsed: Record<string, Array<Record<string, number>>>;
  try { parsed = JSON.parse(header); } catch { return 0; }
  let wait = 0;
  for (const entries of Object.values(parsed ?? {})) {
    for (const e of Array.isArray(entries) ? entries : []) {
      const regainMin = Number(e.estimated_time_to_regain_access ?? 0);
      if (regainMin > 0) wait = Math.max(wait, regainMin * 60_000);
      const peak = Math.max(Number(e.call_count ?? 0), Number(e.total_cputime ?? 0), Number(e.total_time ?? 0));
      if (peak >= 90) wait = Math.max(wait, 60_000);
    }
  }
  return Math.min(wait, 15 * 60_000);
}

/** Never let a token reach logs or stored error text. */
export function redactToken(s: string): string {
  return s.replace(/access_token=[^&\s"]+/g, 'access_token=REDACTED');
}

async function graphGet<T>(url: string, deps: MetaDeps): Promise<{ body: T; usageWait: number }> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = deps.sleep ?? realSleep;
  const maxRetries = deps.maxRetries ?? 5;
  const { token } = metaConfig();
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const usageWait = usageDelayMs(res.headers.get('x-business-use-case-usage'));
    if (res.ok) return { body: (await res.json()) as T, usageWait };

    let err: GraphErrorBody = {};
    try { err = (await res.json()) as GraphErrorBody; } catch { /* non-JSON */ }
    const code = err.error?.code;
    const throttled = res.status === 429 || (code != null && META_THROTTLE_CODES.has(code));
    const retryable = throttled || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      throw new MetaApiError(
        redactToken(`Meta API ${res.status}${code != null ? ` (code ${code})` : ''}: ${err.error?.message ?? res.statusText}`),
        res.status,
        code,
      );
    }
    const backoff = Math.max(usageWait, 1000 * 2 ** attempt);
    logger.warn({ status: res.status, code, attempt, waitMs: backoff }, 'Meta API throttled/failed — backing off');
    await sleep(backoff);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/** "act_123" or "123" → "123". Links store the bare id. */
export function bareAccountId(accountId: string): string {
  return accountId.trim().replace(/^act_/i, '');
}

const AD_FIELDS = [
  'id', 'name', 'effective_status', 'updated_time',
  'adset{id,name}', 'campaign{id,name}',
  'creative{id,name,title,body,image_url,image_hash,video_id,thumbnail_url,object_story_spec,asset_feed_spec,effective_object_story_id}',
].join(',');

/** Ads that are (or may again be) live. Deleted/archived ads are skipped. */
export const META_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW'];

export function buildAdsUrl(accountId: string, since?: Date): string {
  const { baseUrl, version } = metaConfig();
  const params = new URLSearchParams({
    fields: AD_FIELDS,
    limit: '100',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: META_STATUSES }]),
  });
  if (since) params.set('updated_since', String(Math.floor(since.getTime() / 1000)));
  return `${baseUrl}/${version}/act_${bareAccountId(accountId)}/ads?${params.toString()}`;
}

/**
 * Every ad in the account updated since `since` (all pages). Honours Meta's
 * usage header between pages and backs off on throttling codes.
 */
export async function listAds(accountId: string, since?: Date, deps: MetaDeps = {}): Promise<MetaAd[]> {
  const sleep = deps.sleep ?? realSleep;
  const out: MetaAd[] = [];
  let url: string | undefined = buildAdsUrl(accountId, since);
  let pages = 0;
  while (url) {
    const page: { body: GraphPage<MetaAd>; usageWait: number } = await graphGet<GraphPage<MetaAd>>(url, deps);
    const { body, usageWait } = page;
    out.push(...(body.data ?? []));
    url = body.paging?.next;
    if (++pages > 500) throw new MetaApiError('Meta paging did not end after 500 pages', 0);
    if (url && usageWait > 0) await sleep(usageWait);
  }
  return out;
}

/** Playable source + length for a video creative. */
export async function getVideo(videoId: string, deps: MetaDeps = {}): Promise<MetaVideo> {
  const { baseUrl, version } = metaConfig();
  const url = `${baseUrl}/${version}/${encodeURIComponent(videoId)}?fields=id,source,length,picture`;
  return (await graphGet<MetaVideo>(url, deps)).body;
}

/** Resolve image hashes (asset feeds / carousels give hashes, not URLs). */
export async function getImagesByHash(accountId: string, hashes: string[], deps: MetaDeps = {}): Promise<Map<string, MetaImageInfo>> {
  const map = new Map<string, MetaImageInfo>();
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return map;
  const { baseUrl, version } = metaConfig();
  for (let i = 0; i < unique.length; i += 50) {
    const params = new URLSearchParams({
      hashes: JSON.stringify(unique.slice(i, i + 50)),
      fields: 'hash,url,permalink_url,width,height',
    });
    const url = `${baseUrl}/${version}/act_${bareAccountId(accountId)}/adimages?${params.toString()}`;
    const { body } = await graphGet<GraphPage<MetaImageInfo>>(url, deps);
    for (const img of body.data ?? []) if (img.hash) map.set(img.hash, img);
  }
  return map;
}
