import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listAds, getVideo, getImagesByHash, usageDelayMs, redactToken, buildAdsUrl, bareAccountId,
  MetaApiError, type MetaAd,
} from '../integrations/meta/meta-ads-client.js';
import {
  listAccountItems, listAllowedAccounts, _resetTaboolaTokenCache, TaboolaApiError,
} from '../integrations/taboola/taboola-client.js';
import {
  normaliseMetaAd, normaliseTaboolaItem, metaAdRefs, type FilingContext,
} from '../services/platform-creative-normalise.js';
import type { MetaVideo, MetaImageInfo } from '../integrations/meta/meta-ads-client.js';
import type { TaboolaCampaign, TaboolaItem } from '../integrations/taboola/taboola-client.js';
import { DEAD_BASE, fakeMetaFetch, fakeTaboolaFetch, fixture, json, noSleep } from './platform-sync-fixtures.js';

// Plan phase 3 — Meta / Taboola clients + normalisers, against recorded-shape
// fixtures. No real platform is ever called.

const ENV_KEYS = ['META_SYSTEM_USER_TOKEN', 'META_GRAPH_BASE_URL', 'META_GRAPH_VERSION', 'TABOOLA_CLIENT_ID', 'TABOOLA_CLIENT_SECRET', 'TABOOLA_BASE_URL'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.META_GRAPH_BASE_URL = DEAD_BASE;
  process.env.TABOOLA_BASE_URL = DEAD_BASE;
  process.env.META_SYSTEM_USER_TOKEN = 'EAAB-SECRET-TOKEN';
  process.env.META_GRAPH_VERSION = 'v21.0';
  process.env.TABOOLA_CLIENT_ID = 'tb-client';
  process.env.TABOOLA_CLIENT_SECRET = 'tb-secret';
  _resetTaboolaTokenCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const ctx: FilingContext = { businessId: 'biz-1', clientId: 'client-ch', campaignId: 'camp-1', accountId: 'act_428353095282383' };

describe('Meta client', () => {
  it('asks for the creative fields, live statuses and updated_since on the bare account id', () => {
    const u = new URL(buildAdsUrl('act_428353095282383', new Date('2026-09-01T00:00:00Z')));
    expect(u.pathname).toBe('/v21.0/act_428353095282383/ads');
    expect(u.searchParams.get('fields')).toContain('creative{id,name,title,body,image_url,image_hash,video_id,thumbnail_url,object_story_spec,asset_feed_spec');
    expect(JSON.parse(u.searchParams.get('filtering')!)[0]).toMatchObject({ field: 'effective_status', operator: 'IN' });
    expect(JSON.parse(u.searchParams.get('filtering')!)[0].value).toEqual(expect.arrayContaining(['ACTIVE', 'PAUSED']));
    expect(u.searchParams.get('updated_since')).toBe(String(Date.parse('2026-09-01T00:00:00Z') / 1000));
    expect(bareAccountId(' act_123 ')).toBe('123');
  });

  it('follows paging.next until the last page and sends the token as a Bearer header', async () => {
    const { fetchImpl, calls } = fakeMetaFetch();
    const ads = await listAds('428353095282383', undefined, { fetchImpl, sleep: noSleep });
    expect(ads.map((a) => a.id)).toEqual(['120210000000000001', '120210000000000002', '120210000000000003', '120210000000000004']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1].url).searchParams.get('after')).toBe('QVFIUmJi');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer EAAB-SECRET-TOKEN');
  });

  it('backs off and retries on throttling codes and 5xx, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const { fetchImpl } = fakeMetaFetch(() => {
      n++;
      if (n === 1) return json({ error: { message: 'User request limit reached', code: 17 } }, 400);
      if (n === 2) return json({ error: { message: 'Service temporarily unavailable', code: 2 } }, 503);
      return undefined;
    });
    const ads = await listAds('1', undefined, { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect(ads).toHaveLength(4);
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up after maxRetries and never puts the token in the error', async () => {
    const { fetchImpl, calls } = fakeMetaFetch(() => json({ error: { message: 'Application request limit reached', code: 4 } }, 400));
    const err = await listAds('1', undefined, { fetchImpl, sleep: noSleep, maxRetries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.code).toBe(4);
    expect(calls).toHaveLength(3);
    expect(String(err.message)).not.toContain('SECRET');
  });

  it('does not retry a permission / bad-token error', async () => {
    const { fetchImpl, calls } = fakeMetaFetch(() => json({ error: { message: 'Error validating access token', code: 190 } }, 400));
    await expect(listAds('1', undefined, { fetchImpl, sleep: noSleep })).rejects.toMatchObject({ code: 190, status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('waits between pages when X-Business-Use-Case-Usage is high', async () => {
    const waits: number[] = [];
    const usage = JSON.stringify({ '428353095282383': [{ type: 'ads_management', call_count: 95, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 0 }] });
    const page1 = fixture('meta-ads-page1.json');
    const { fetchImpl } = fakeMetaFetch((url) => (url.pathname.endsWith('/ads') && !url.searchParams.get('after') ? json(page1, 200, { 'x-business-use-case-usage': usage }) : undefined));
    await listAds('428353095282383', undefined, { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([60_000]);
  });

  it('reads the usage header: ≥90% → 1 min, regain time in minutes, junk → 0, capped at 15 min', () => {
    expect(usageDelayMs(JSON.stringify({ a: [{ call_count: 10, total_cputime: 91 }] }))).toBe(60_000);
    expect(usageDelayMs(JSON.stringify({ a: [{ call_count: 10, estimated_time_to_regain_access: 3 }] }))).toBe(180_000);
    expect(usageDelayMs(JSON.stringify({ a: [{ estimated_time_to_regain_access: 600 }] }))).toBe(15 * 60_000);
    expect(usageDelayMs(JSON.stringify({ a: [{ call_count: 12 }] }))).toBe(0);
    expect(usageDelayMs('not json')).toBe(0);
    expect(usageDelayMs(null)).toBe(0);
  });

  it('redacts access tokens from any text', () => {
    expect(redactToken('GET https://graph.facebook.com/x?access_token=EAAB123&after=Q')).toBe('GET https://graph.facebook.com/x?access_token=REDACTED&after=Q');
  });

  it('resolves videos and image hashes', async () => {
    const { fetchImpl } = fakeMetaFetch();
    const v = await getVideo('880000000000001', { fetchImpl, sleep: noSleep });
    expect(v).toMatchObject({ source: expect.stringContaining('testimonial.mp4'), length: 30.04 });
    const imgs = await getImagesByHash('act_1', ['1111aaaa2222bbbb3333cccc4444dddd', '1111aaaa2222bbbb3333cccc4444dddd', ''], { fetchImpl, sleep: noSleep });
    expect(imgs.get('1111aaaa2222bbbb3333cccc4444dddd')).toMatchObject({ width: 1080, height: 1350 });
  });
});

describe('Meta normaliser (one fixture per ad shape)', () => {
  const ads = [
    ...fixture<{ data: MetaAd[] }>('meta-ads-page1.json').data,
    ...fixture<{ data: MetaAd[] }>('meta-ads-page2.json').data,
  ];
  const videos = new Map(Object.entries(fixture<Record<string, MetaVideo>>('meta-videos.json')));
  const images = new Map(fixture<{ data: MetaImageInfo[] }>('meta-adimages.json').data.map((i) => [i.hash, i]));
  const [linkAd, videoAd, feedAd, carouselAd] = ads;

  it('collects every video id and image hash the ads refer to', () => {
    const refs = metaAdRefs(ads);
    expect(refs.videoIds.sort()).toEqual(['880000000000001', '880000000000002', '880000000000003']);
    expect(refs.imageHashes).toEqual(expect.arrayContaining(['a1b2c3d4e5f60718293a4b5c6d7e8f90', '1111aaaa2222bbbb3333cccc4444dddd', 'aaaa0000bbbb1111cccc2222dddd3333']));
  });

  it('link ad → one image creative filed under the account\'s client, full-size image, landing URL', () => {
    const [c, ...rest] = normaliseMetaAd(linkAd, ctx, { videos, images });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      businessId: 'biz-1', clientId: 'client-ch', campaignId: 'camp-1',
      platform: 'meta', platformAccountId: '428353095282383',
      platformAdId: '120210000000000001', platformCreativeId: '120210000000005001',
      platformCampaignId: '120210000000000900', platformCampaignName: 'Hearing Aids CH — Leads',
      mediaType: 'image', width: 1080, height: 1080,
      headline: 'Kostenloser Hörtest', bodyText: 'Jetzt Termin sichern.',
      landingPageUrl: 'https://hoertest.example.ch/gratis?utm_source=facebook&utm_campaign=ch55',
    });
    expect(c.sourceUrl).toContain('static-v3-full.jpg');
  });

  it('video ad → video creative with the playable source, length and CTA landing URL', () => {
    const [c] = normaliseMetaAd(videoAd, ctx, { videos, images });
    expect(c).toMatchObject({
      mediaType: 'video', durationS: 30.04, platformCreativeId: '120210000000005002',
      headline: 'Endlich wieder alles hören', landingPageUrl: 'https://hoertest.example.ch/termin',
    });
    expect(c.sourceUrl).toContain('testimonial.mp4');
  });

  it('video with no lookup → poster frame, never an empty creative', () => {
    const [c] = normaliseMetaAd(videoAd, ctx, {});
    expect(c.mediaType).toBe('video');
    expect(c.sourceUrl).toContain('testimonial-thumb.jpg');
  });

  it('dynamic creative → one creative per image and per video, stable distinct ids', () => {
    const out = normaliseMetaAd(feedAd, ctx, { videos, images });
    expect(out.map((c) => c.platformCreativeId)).toEqual([
      '120210000000005003:img:1111aaaa2222bbbb3333cccc4444dddd',
      '120210000000005003:img:5555eeee6666ffff7777000088889999',
      '120210000000005003:vid:880000000000002',
    ]);
    expect(out.map((c) => c.mediaType)).toEqual(['image', 'image', 'video']);
    for (const c of out) expect(c).toMatchObject({ headline: 'Hörgeräte im Test', landingPageUrl: 'https://hoertest.example.ch/vergleich', platformAdId: '120210000000000003' });
    expect(out[1]).toMatchObject({ width: 1200, height: 628 });
    expect(out[2]).toMatchObject({ durationS: 15.5 });
  });

  it('carousel → one creative per card with that card\'s link and headline', () => {
    const out = normaliseMetaAd(carouselAd, ctx, { videos, images });
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.platformCreativeId)).toEqual(['120210000000005004:card:0', '120210000000005004:card:1', '120210000000005004:card:2']);
    expect(out.map((c) => c.landingPageUrl)).toEqual(['https://hoertest.example.ch/modell-a', 'https://hoertest.example.ch/modell-b', 'https://hoertest.example.ch/modell-c']);
    expect(out[0].sourceUrl).toContain('card-a.jpg');
    expect(out[1]).toMatchObject({ mediaType: 'image', headline: 'Modell B' });
    // card C is a video whose source Meta didn't return → HD poster from the lookup
    expect(out[2]).toMatchObject({ mediaType: 'video', durationS: 6 });
    expect(out[2].sourceUrl).toContain('card-c-poster-hd.jpg');
    expect(out[0].platformCampaignName).toBe('Hearing Aids CH — Retargeting');
  });

  it('an ad without a creative, or without any media, yields nothing', () => {
    expect(normaliseMetaAd({ id: 'x' }, ctx)).toEqual([]);
    expect(normaliseMetaAd({ id: 'x', creative: { id: 'c', title: 'no media' } }, ctx)).toEqual([]);
  });
});

describe('Taboola client', () => {
  it('signs in once, caches the token, and skips terminated campaigns', async () => {
    const { fetchImpl, calls, tokenCount } = fakeTaboolaFetch();
    const groups = await listAccountItems('willwriting-sc', { fetchImpl, sleep: noSleep });
    const accounts = await listAllowedAccounts({ fetchImpl, sleep: noSleep });
    expect(tokenCount()).toBe(1);
    expect(groups.map((g) => g.campaign.id)).toEqual(['31000001']);
    expect(groups[0].items).toHaveLength(3);
    expect(calls.some((c) => c.url.includes('/campaigns/31000002/'))).toBe(false);
    expect(calls.find((c) => c.url.endsWith('/willwriting-sc/campaigns'))?.url).toBe(`${DEAD_BASE}/backstage/api/1.0/willwriting-sc/campaigns`);
    expect(accounts.map((a) => a.account_id)).toEqual(['leadgenerationio-network', 'willwriting-sc']);
    const tokenCall = calls.find((c) => c.url.endsWith('/backstage/oauth/token'))!;
    expect(String(tokenCall.init?.body)).toContain('grant_type=client_credentials');
  });

  it('refreshes the token once on 401', async () => {
    let first = true;
    const { fetchImpl, tokenCount } = fakeTaboolaFetch((url) => {
      if (url.pathname.endsWith('/campaigns') && first) { first = false; return json({ message: 'token expired' }, 401); }
      return undefined;
    });
    const groups = await listAccountItems('willwriting-sc', { fetchImpl, sleep: noSleep });
    expect(groups).toHaveLength(1);
    expect(tokenCount()).toBe(2);
  });

  it('backs off on 429 using Retry-After, then gives up with a plain error', async () => {
    const waits: number[] = [];
    const { fetchImpl } = fakeTaboolaFetch((url) => (url.pathname.endsWith('/campaigns') ? json({ message: 'rate limited' }, 429, { 'retry-after': '2' }) : undefined));
    const err = await listAccountItems('willwriting-sc', { fetchImpl, sleep: async (ms) => { waits.push(ms); }, maxRetries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(TaboolaApiError);
    expect(err.message).toBe('Taboola API 429: rate limited');
    expect(waits).toEqual([2000, 2000]);
  });
});

describe('Taboola normaliser', () => {
  const campaign = fixture<{ results: TaboolaCampaign[] }>('taboola-campaigns.json').results[0];
  const [running, crawling, motion] = fixture<{ results: TaboolaItem[] }>('taboola-items-31000001.json').results;
  const tctx: FilingContext = { businessId: 'biz-1', clientId: 'client-pl', campaignId: null, accountId: 'willwriting-sc' };

  it('native item → image creative filed under the account\'s client with its landing URL', () => {
    expect(normaliseTaboolaItem(running, campaign, tctx)).toEqual({
      businessId: 'biz-1', clientId: 'client-pl', campaignId: undefined,
      platform: 'taboola', platformAccountId: 'willwriting-sc',
      platformAdId: '4100000001', platformCreativeId: '4100000001',
      platformCampaignId: '31000001', platformCampaignName: 'PL Aparaty słuchowe — Native',
      landingPageUrl: 'https://aparaty.example.pl/bezplatny-test?utm_source=taboola&utm_medium=native',
      headline: 'Bezpłatny test słuchu w Twoim mieście', bodyText: 'Sprawdź, czy kwalifikujesz się do dopłaty.',
      mediaType: 'image', sourceUrl: expect.stringContaining('aparaty-1.jpg'),
      name: 'Bezpłatny test słuchu w Twoim mieście',
    });
  });

  it('item still being crawled → skipped', () => {
    expect(normaliseTaboolaItem(crawling, campaign, tctx)).toBeNull();
  });

  it('stopped or crawl-failed item → skipped even when it has a thumbnail', () => {
    expect(normaliseTaboolaItem({ ...running, status: 'STOPPED' }, campaign, tctx)).toBeNull();
    expect(normaliseTaboolaItem({ ...running, status: 'CRAWLING_ERROR' }, campaign, tctx)).toBeNull();
    expect(normaliseTaboolaItem({ ...running, status: 'PAUSED' }, campaign, tctx)).not.toBeNull();
  });

  it('motion ad → video creative with the mp4', () => {
    expect(normaliseTaboolaItem(motion, campaign, tctx)).toMatchObject({ mediaType: 'video', sourceUrl: 'https://cdn.taboola.com/motion/aparaty.mp4', bodyText: undefined });
  });
});
