// Phase 3 of docs/creative-library-and-api-plan.md — scheduled pull of ads
// and creatives from Meta and Taboola, filed under the client that owns the
// ad account (client_ad_accounts, matched on platform + account id only).
//
// Nothing here runs until credentials are set: with no Meta token and no
// Taboola client the scheduled job logs once and returns.
//
// Media is handed to the creative library's upsertPlatformCreative() as a
// `sourceUrl`; the library copies it into R2. Expiring platform CDN links are
// never stored as a creative's file URL.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { clientAdAccounts, type ClientAdAccountRow } from '../db/schema/client-ad-accounts.js';
import { adAccountSyncState } from '../db/schema/ad-account-sync-state.js';
import { clients } from '../db/schema/clients.js';
import { logger } from '../utils/logger.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import type { AuthPayload } from '../types/index.js';
import {
  metaConfigured, listAds, getVideo, getImagesByHash, redactToken,
  type MetaDeps, type MetaVideo, type MetaImageInfo,
} from '../integrations/meta/meta-ads-client.js';
import { taboolaConfigured, listAccountItems, type TaboolaDeps } from '../integrations/taboola/taboola-client.js';
import {
  normaliseMetaAd, normaliseTaboolaItem, metaAdRefs,
  type PlatformCreativeInput, type FilingContext,
} from './platform-creative-normalise.js';

export type SyncPlatform = 'meta' | 'taboola';

export type UpsertFn = (input: PlatformCreativeInput) => Promise<{ creative: unknown; created: boolean }>;

export interface SyncDeps {
  /** Defaults to creative-library.service's upsertPlatformCreative (loaded lazily). */
  upsert?: UpsertFn;
  meta?: MetaDeps;
  taboola?: TaboolaDeps;
  now?: () => Date;
}

/** client_ad_accounts.platform (canonical) → the platform this job syncs. */
export function syncPlatformFor(platform: string): SyncPlatform | null {
  if (platform === 'facebook-ads') return 'meta';
  if (platform === 'taboola') return 'taboola';
  return null;
}

const LINK_PLATFORM: Record<SyncPlatform, string> = { meta: 'facebook-ads', taboola: 'taboola' };

export function platformConfigured(p: SyncPlatform): boolean {
  return p === 'meta' ? metaConfigured() : taboolaConfigured();
}

export function syncEveryHours(): number {
  const n = Number(process.env.PLATFORM_SYNC_EVERY_HOURS ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 24) : 3;
}

function lookbackDays(): number {
  const n = Number(process.env.PLATFORM_SYNC_LOOKBACK_DAYS ?? 90);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 3650) : 90;
}

// ─── Creative-library hook ──────────────────────────────────────────────
// The library (upsertPlatformCreative) ships in its own PR. Resolve it at
// run time so this job can be deployed first: until the library exists the
// job reports "library not installed" instead of crashing the worker.

let loadedUpsert: UpsertFn | null | undefined;

/** Tests only. */
export function _setUpsertForTests(fn: UpsertFn | null | undefined): void { loadedUpsert = fn; }

export async function resolveUpsert(): Promise<UpsertFn | null> {
  if (loadedUpsert !== undefined) return loadedUpsert;
  const specifier = './creative-library.service.js';
  try {
    const mod = (await import(specifier)) as { upsertPlatformCreative?: UpsertFn };
    loadedUpsert = typeof mod.upsertPlatformCreative === 'function' ? mod.upsertPlatformCreative : null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && !/Cannot find module/.test(String(err))) throw err;
    loadedUpsert = null;
  }
  return loadedUpsert;
}

// ─── One account ────────────────────────────────────────────────────────

export interface AccountSyncResult {
  linkId: string;
  platform: string;
  accountId: string;
  status: 'ok' | 'error' | 'skipped';
  reason?: 'platform_not_supported' | 'not_configured' | 'library_missing' | 'already_running';
  adsSeen: number;
  created: number;
  updated: number;
  failed: number;
  error?: string;
}

const running = new Set<string>();

/** Overlap between runs so an ad edited during a run is picked up next time. */
const CURSOR_OVERLAP_MS = 10 * 60_000;

async function collectInputs(
  p: SyncPlatform,
  link: ClientAdAccountRow,
  since: Date,
  deps: SyncDeps,
): Promise<{ inputs: PlatformCreativeInput[]; adsSeen: number }> {
  const ctx: FilingContext = {
    businessId: link.businessId,
    clientId: link.clientId,
    campaignId: link.campaignId,
    accountId: link.accountId,
  };
  if (p === 'meta') {
    const ads = await listAds(link.accountId, since, deps.meta);
    const { videoIds, imageHashes } = metaAdRefs(ads);
    const videos = new Map<string, MetaVideo>();
    for (const id of videoIds) {
      // A missing video permission must not sink the whole account — the
      // normaliser falls back to the poster frame.
      try { videos.set(id, await getVideo(id, deps.meta)); } catch (err) {
        logger.warn({ videoId: id, err: redactToken(String(err)) }, 'Meta video lookup failed — using poster frame');
      }
    }
    let images = new Map<string, MetaImageInfo>();
    try { images = await getImagesByHash(link.accountId, imageHashes, deps.meta); } catch (err) {
      logger.warn({ accountId: link.accountId, err: redactToken(String(err)) }, 'Meta image-hash lookup failed');
    }
    return { inputs: ads.flatMap((ad) => normaliseMetaAd(ad, ctx, { videos, images })), adsSeen: ads.length };
  }
  const groups = await listAccountItems(link.accountId, deps.taboola);
  const inputs: PlatformCreativeInput[] = [];
  let adsSeen = 0;
  for (const { campaign, items } of groups) {
    adsSeen += items.length;
    for (const item of items) {
      const input = normaliseTaboolaItem(item, campaign, ctx);
      if (input) inputs.push(input);
    }
  }
  return { inputs, adsSeen };
}

export async function syncLinkedAccount(link: ClientAdAccountRow, deps: SyncDeps = {}): Promise<AccountSyncResult> {
  const result: AccountSyncResult = {
    linkId: link.id, platform: link.platform, accountId: link.accountId,
    status: 'skipped', adsSeen: 0, created: 0, updated: 0, failed: 0,
  };
  const p = syncPlatformFor(link.platform);
  if (!p) return { ...result, reason: 'platform_not_supported' };
  if (!platformConfigured(p)) return { ...result, reason: 'not_configured' };
  const upsert = deps.upsert ?? (await resolveUpsert());
  if (!upsert) return { ...result, reason: 'library_missing' };
  if (running.has(link.id)) return { ...result, reason: 'already_running' };

  running.add(link.id);
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  try {
    const [state] = await db.select().from(adAccountSyncState).where(eq(adAccountSyncState.clientAdAccountId, link.id));
    const since = state?.cursorSince ?? new Date(startedAt.getTime() - lookbackDays() * 86_400_000);

    let inputs: PlatformCreativeInput[];
    try {
      ({ inputs, adsSeen: result.adsSeen } = await collectInputs(p, link, since, deps));
    } catch (err) {
      const message = redactToken(err instanceof Error ? err.message : String(err));
      await saveState(link.id, { lastRunAt: startedAt, lastError: message, lastErrorAt: startedAt, adsSeen: 0, creativesCreated: 0, creativesUpdated: 0, creativesFailed: 0 });
      logger.error({ linkId: link.id, platform: link.platform, accountId: link.accountId, err: message }, 'Platform creative sync failed for account');
      return { ...result, status: 'error', error: message };
    }

    let firstError: string | undefined;
    for (const input of inputs) {
      try {
        const { created } = await upsert(input);
        if (created) result.created++; else result.updated++;
      } catch (err) {
        result.failed++;
        firstError ??= redactToken(err instanceof Error ? err.message : String(err));
      }
    }

    // A creative that failed to save must be retried: keep the old cursor so
    // the next run asks the platform for the same window again.
    const cursorSince = result.failed > 0 ? (state?.cursorSince ?? null) : new Date(startedAt.getTime() - CURSOR_OVERLAP_MS);
    const lastError = result.failed > 0 ? `${result.failed} of ${inputs.length} creatives could not be saved: ${firstError}` : null;
    await saveState(link.id, {
      lastRunAt: startedAt,
      lastSuccessAt: startedAt,
      cursorSince,
      lastError,
      lastErrorAt: lastError ? startedAt : null,
      adsSeen: result.adsSeen,
      creativesCreated: result.created,
      creativesUpdated: result.updated,
      creativesFailed: result.failed,
    });
    logger.info({ ...result }, 'Platform creative sync finished for account');
    return { ...result, status: result.failed > 0 ? 'error' : 'ok', error: lastError ?? undefined };
  } finally {
    running.delete(link.id);
  }
}

type StatePatch = Partial<Omit<typeof adAccountSyncState.$inferInsert, 'clientAdAccountId'>>;

async function saveState(linkId: string, patch: StatePatch): Promise<void> {
  const values = { ...patch, updatedAt: new Date() };
  await db.insert(adAccountSyncState)
    .values({ clientAdAccountId: linkId, ...values })
    .onConflictDoUpdate({ target: adAccountSyncState.clientAdAccountId, set: values });
}

// ─── All accounts (the scheduled job) ───────────────────────────────────

let loggedNotConfigured = false;

/** Tests only. */
export function _resetSyncLogOnce(): void { loggedNotConfigured = false; }

export interface SyncAllResult {
  skipped?: 'not_configured' | 'library_missing';
  platforms: SyncPlatform[];
  accounts: AccountSyncResult[];
  created: number;
  updated: number;
  failed: number;
  errors: number;
}

export async function syncAllLinkedAccounts(deps: SyncDeps = {}): Promise<SyncAllResult> {
  const platforms = (['meta', 'taboola'] as const).filter(platformConfigured);
  const empty: SyncAllResult = { platforms: [...platforms], accounts: [], created: 0, updated: 0, failed: 0, errors: 0 };
  if (platforms.length === 0) {
    if (!loggedNotConfigured) {
      logger.info('Platform creative sync is off: no Meta or Taboola credentials are set');
      loggedNotConfigured = true;
    }
    return { ...empty, skipped: 'not_configured' };
  }
  const upsert = deps.upsert ?? (await resolveUpsert());
  if (!upsert) {
    logger.warn('Platform creative sync skipped: the creative library is not installed yet');
    return { ...empty, skipped: 'library_missing' };
  }
  const links = await db.select().from(clientAdAccounts)
    .where(inArray(clientAdAccounts.platform, platforms.map((p) => LINK_PLATFORM[p])));
  const out = { ...empty };
  for (const link of links) {
    const r = await syncLinkedAccount(link, { ...deps, upsert });
    out.accounts.push(r);
    out.created += r.created;
    out.updated += r.updated;
    out.failed += r.failed;
    if (r.status === 'error') out.errors++;
  }
  return out;
}

// ─── Admin endpoints ────────────────────────────────────────────────────

export interface SyncStatus {
  everyHours: number;
  platforms: Record<SyncPlatform, { connected: boolean }>;
  libraryInstalled: boolean;
  accounts: Array<{
    linkId: string;
    platform: string;
    accountId: string;
    accountName: string | null;
    clientId: string;
    clientName: string | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    adsSeen: number;
    created: number;
    updated: number;
    failed: number;
  }>;
}

export async function getSyncStatus(requester: AuthPayload): Promise<SyncStatus> {
  const status: SyncStatus = {
    everyHours: syncEveryHours(),
    platforms: { meta: { connected: metaConfigured() }, taboola: { connected: taboolaConfigured() } },
    libraryInstalled: (await resolveUpsert()) !== null,
    accounts: [],
  };
  if (!requester.businessId) return status;
  const rows = await db
    .select({ link: clientAdAccounts, state: adAccountSyncState, clientName: clients.companyName })
    .from(clientAdAccounts)
    .leftJoin(adAccountSyncState, eq(adAccountSyncState.clientAdAccountId, clientAdAccounts.id))
    .leftJoin(clients, eq(clients.id, clientAdAccounts.clientId))
    .where(and(
      eq(clientAdAccounts.businessId, requester.businessId),
      inArray(clientAdAccounts.platform, Object.values(LINK_PLATFORM)),
    ));
  status.accounts = rows.map(({ link, state, clientName }) => ({
    linkId: link.id,
    platform: link.platform,
    accountId: link.accountId,
    accountName: link.accountName ?? null,
    clientId: link.clientId,
    clientName: clientName ?? null,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    adsSeen: state?.adsSeen ?? 0,
    created: state?.creativesCreated ?? 0,
    updated: state?.creativesUpdated ?? 0,
    failed: state?.creativesFailed ?? 0,
  }));
  return status;
}

const PLATFORM_NAME: Record<SyncPlatform, string> = { meta: 'Meta', taboola: 'Taboola' };

export type EnqueueFn = (linkId: string) => Promise<boolean>;

/**
 * "Sync now" for one linked account. Queued on the sync queue when Redis is
 * available (deduped per account); otherwise run inline.
 */
export async function requestSyncNow(
  requester: AuthPayload,
  linkId: string,
  enqueue?: EnqueueFn,
  deps: SyncDeps = {},
): Promise<{ queued: boolean; result?: AccountSyncResult }> {
  if (!requester.businessId) throw new NotFoundError('Ad account link');
  const [link] = await db.select().from(clientAdAccounts)
    .where(and(eq(clientAdAccounts.id, linkId), eq(clientAdAccounts.businessId, requester.businessId)));
  if (!link) throw new NotFoundError('Ad account link');
  const p = syncPlatformFor(link.platform);
  if (!p) throw new AppError(422, 'Only Meta and Taboola ad accounts can be synced.');
  if (!platformConfigured(p)) {
    throw new AppError(409, `${PLATFORM_NAME[p]} isn't connected yet, so ads can't be pulled from it. Ask an admin to connect ${PLATFORM_NAME[p]} first.`);
  }
  if (enqueue && (await enqueue(link.id))) return { queued: true };
  return { queued: false, result: await syncLinkedAccount(link, deps) };
}
