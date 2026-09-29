// Turn Meta ads / Taboola items into creative-library upsert inputs.
// Pure functions (no I/O) so every ad shape is covered by fixture tests.
//
// One Meta ad can hold several creatives (a carousel, or a dynamic-creative
// asset feed with several images/videos) → one input per asset, each with a
// stable platformCreativeId so a re-run updates instead of duplicating.

import type { MetaAd, MetaImageInfo, MetaVideo } from '../integrations/meta/meta-ads-client.js';
import { bareAccountId } from '../integrations/meta/meta-ads-client.js';
import type { TaboolaCampaign, TaboolaItem } from '../integrations/taboola/taboola-client.js';

/** Mirrors `upsertPlatformCreative(input)` in creative-library.service.ts. */
export interface PlatformCreativeInput {
  businessId: string;
  clientId?: string;
  campaignId?: string;
  platform: 'meta' | 'taboola' | 'google' | 'tiktok' | 'manual';
  platformAccountId?: string;
  platformAdId?: string;
  platformCreativeId?: string;
  platformCampaignId?: string;
  platformCampaignName?: string;
  landingPageUrl?: string;
  headline?: string;
  bodyText?: string;
  mediaType: 'image' | 'video';
  sourceUrl?: string;
  width?: number;
  height?: number;
  durationS?: number;
  name?: string;
}

/** Where the synced creative is filed — always from client_ad_accounts, never names. */
export interface FilingContext {
  businessId: string;
  clientId: string;
  campaignId?: string | null;
  accountId: string;
}

export interface MetaLookups {
  videos?: Map<string, MetaVideo>;
  images?: Map<string, MetaImageInfo>;
}

const clean = (s: string | null | undefined): string | undefined => {
  const t = (s ?? '').trim();
  return t ? t : undefined;
};

/** Every video id and image hash an ad refers to — fetched in bulk before normalising. */
export function metaAdRefs(ads: MetaAd[]): { videoIds: string[]; imageHashes: string[] } {
  const videoIds = new Set<string>();
  const imageHashes = new Set<string>();
  for (const ad of ads) {
    const c = ad.creative;
    if (!c) continue;
    const add = (v?: string, h?: string) => { if (v) videoIds.add(v); if (h) imageHashes.add(h); };
    add(c.video_id, c.image_hash);
    const s = c.object_story_spec;
    add(s?.video_data?.video_id, s?.video_data?.image_hash);
    add(undefined, s?.link_data?.image_hash);
    for (const ch of s?.link_data?.child_attachments ?? []) add(ch.video_id, ch.image_hash);
    for (const v of c.asset_feed_spec?.videos ?? []) add(v.video_id);
    for (const i of c.asset_feed_spec?.images ?? []) add(undefined, i.hash);
  }
  return { videoIds: [...videoIds], imageHashes: [...imageHashes] };
}

export function normaliseMetaAd(ad: MetaAd, ctx: FilingContext, lookups: MetaLookups = {}): PlatformCreativeInput[] {
  const c = ad.creative;
  if (!c?.id) return [];
  const base = {
    businessId: ctx.businessId,
    clientId: ctx.clientId,
    campaignId: ctx.campaignId ?? undefined,
    platform: 'meta' as const,
    platformAccountId: bareAccountId(ctx.accountId),
    platformAdId: ad.id,
    platformCampaignId: ad.campaign?.id,
    platformCampaignName: clean(ad.campaign?.name),
  };
  const video = (id: string, fallbackThumb?: string) => {
    const v = lookups.videos?.get(id);
    return {
      mediaType: 'video' as const,
      // No playable source (not returned / no permission) → keep the poster
      // frame so the library still shows something; never an empty creative.
      sourceUrl: clean(v?.source) ?? clean(v?.picture) ?? clean(fallbackThumb),
      durationS: v?.length != null ? Number(v.length) : undefined,
    };
  };
  const image = (hash?: string, url?: string) => {
    const info = hash ? lookups.images?.get(hash) : undefined;
    return {
      mediaType: 'image' as const,
      sourceUrl: clean(info?.url) ?? clean(url),
      width: info?.width,
      height: info?.height,
    };
  };

  const story = c.object_story_spec;
  const feed = c.asset_feed_spec;

  // 1. Dynamic creative / asset feed: one creative per image and per video.
  if (feed && ((feed.images?.length ?? 0) + (feed.videos?.length ?? 0)) > 0) {
    const headline = clean(feed.titles?.[0]?.text) ?? clean(c.title);
    const bodyText = clean(feed.bodies?.[0]?.text) ?? clean(c.body);
    const landingPageUrl = clean(feed.link_urls?.[0]?.website_url);
    const out: PlatformCreativeInput[] = [];
    for (const img of feed.images ?? []) {
      if (!img.hash && !img.url) continue;
      out.push({ ...base, platformCreativeId: `${c.id}:img:${img.hash ?? img.url}`, headline, bodyText, landingPageUrl, name: clean(ad.name), ...image(img.hash, img.url) });
    }
    for (const v of feed.videos ?? []) {
      if (!v.video_id) continue;
      out.push({ ...base, platformCreativeId: `${c.id}:vid:${v.video_id}`, headline, bodyText, landingPageUrl, name: clean(ad.name), ...video(v.video_id, v.thumbnail_url) });
    }
    return out;
  }

  // 2. Carousel: one creative per card.
  const cards = story?.link_data?.child_attachments ?? [];
  if (cards.length > 0) {
    return cards.map((card, i) => ({
      ...base,
      platformCreativeId: `${c.id}:card:${i}`,
      headline: clean(card.name),
      bodyText: clean(card.description) ?? clean(story?.link_data?.message),
      landingPageUrl: clean(card.link) ?? clean(story?.link_data?.link),
      name: clean(ad.name) ? `${clean(ad.name)} — card ${i + 1}` : undefined,
      ...(card.video_id ? video(card.video_id, card.picture) : image(card.image_hash, card.picture)),
    }));
  }

  // 3. Single video ad.
  const vd = story?.video_data;
  const videoId = vd?.video_id ?? c.video_id;
  if (videoId) {
    return [{
      ...base,
      platformCreativeId: c.id,
      headline: clean(vd?.title) ?? clean(c.title),
      bodyText: clean(vd?.message) ?? clean(c.body),
      landingPageUrl: clean(vd?.call_to_action?.value?.link),
      name: clean(ad.name) ?? clean(c.name),
      ...video(videoId, vd?.image_url ?? c.thumbnail_url),
    }];
  }

  // 4. Single image / link ad (and anything else with a picture).
  const ld = story?.link_data;
  const pictureUrl = ld?.picture ?? c.image_url ?? c.thumbnail_url;
  const hash = ld?.image_hash ?? c.image_hash;
  const img = image(hash, pictureUrl);
  if (!img.sourceUrl) return [];
  return [{
    ...base,
    platformCreativeId: c.id,
    headline: clean(ld?.name) ?? clean(c.title),
    bodyText: clean(ld?.message) ?? clean(c.body),
    landingPageUrl: clean(ld?.link) ?? clean(ld?.call_to_action?.value?.link),
    name: clean(ad.name) ?? clean(c.name),
    ...img,
  }];
}

/** Items still being crawled (no thumbnail yet) or stopped are not filed. */
const SKIP_ITEM_STATUSES = new Set(['CRAWLING', 'CRAWLING_ERROR', 'STOPPED']);

export function normaliseTaboolaItem(item: TaboolaItem, campaign: TaboolaCampaign, ctx: FilingContext): PlatformCreativeInput | null {
  if (item.status && SKIP_ITEM_STATUSES.has(item.status)) return null;
  const videoUrl = clean(item.performance_video_data?.video_url) ?? clean(item.video_url);
  const isVideo = !!videoUrl || /MOTION|VIDEO/i.test(item.creative_type ?? item.type ?? '');
  const sourceUrl = isVideo ? (videoUrl ?? clean(item.thumbnail_url)) : clean(item.thumbnail_url);
  if (!sourceUrl) return null;
  return {
    businessId: ctx.businessId,
    clientId: ctx.clientId,
    campaignId: ctx.campaignId ?? undefined,
    platform: 'taboola',
    platformAccountId: ctx.accountId,
    platformAdId: String(item.id),
    platformCreativeId: String(item.id),
    platformCampaignId: String(item.campaign_id ?? campaign.id),
    platformCampaignName: clean(campaign.name),
    landingPageUrl: clean(item.url),
    headline: clean(item.title),
    bodyText: clean(item.description),
    mediaType: isVideo ? 'video' : 'image',
    sourceUrl,
    name: clean(item.title),
  };
}
