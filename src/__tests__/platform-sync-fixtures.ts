// Shared fakes for the phase-3 Meta / Taboola sync tests. Recorded-shape
// fixtures only — nothing here talks to a real platform.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformCreativeInput } from '../services/platform-creative-normalise.js';
import type { UpsertFn } from '../services/platform-creative-sync.service.js';

const dir = join(import.meta.dirname, 'fixtures', 'platform-sync');
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

// Unreachable on purpose: if a code path ever skips the injected fetch, it
// fails fast instead of reaching a real platform.
export const DEAD_BASE = 'http://127.0.0.1:9';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export interface FakeCall { url: string; init?: RequestInit }

/** Serves the Meta fixtures by path. `override` can replace any response. */
export function fakeMetaFetch(override?: (url: URL, n: number) => Response | undefined) {
  const calls: FakeCall[] = [];
  const page1 = fixture('meta-ads-page1.json');
  const page2 = fixture('meta-ads-page2.json');
  const videos = fixture<Record<string, unknown>>('meta-videos.json');
  const images = fixture('meta-adimages.json');
  const fetchImpl = async (raw: string, init?: RequestInit) => {
    calls.push({ url: raw, init });
    const url = new URL(raw);
    const o = override?.(url, calls.length);
    if (o) return o;
    if (url.pathname.endsWith('/ads')) return json(url.searchParams.get('after') ? page2 : page1);
    if (url.pathname.endsWith('/adimages')) return json(images);
    const id = url.pathname.split('/').pop() ?? '';
    if (videos[id]) return json(videos[id]);
    return json({ error: { message: 'Unsupported get request', code: 100 } }, 400);
  };
  return { fetchImpl, calls };
}

export function fakeTaboolaFetch(override?: (url: URL, n: number) => Response | undefined) {
  const calls: FakeCall[] = [];
  let tokens = 0;
  const fetchImpl = async (raw: string, init?: RequestInit) => {
    calls.push({ url: raw, init });
    const url = new URL(raw);
    const o = override?.(url, calls.length);
    if (o) return o;
    if (url.pathname === '/backstage/oauth/token') { tokens++; return json({ access_token: `tb-token-${tokens}`, token_type: 'bearer', expires_in: 43200 }); }
    if (url.pathname.endsWith('/users/current/allowed-accounts')) return json(fixture('taboola-allowed-accounts.json'));
    if (url.pathname.endsWith('/campaigns')) return json(fixture('taboola-campaigns.json'));
    if (url.pathname.endsWith('/campaigns/31000001/items/')) return json(fixture('taboola-items-31000001.json'));
    return json({ message: 'not found' }, 404);
  };
  return { fetchImpl, calls, tokenCount: () => tokens };
}

export const noSleep = async () => {};

/** In-memory stand-in for upsertPlatformCreative: dedupes on platform + creative id. */
export function fakeUpsert(fail?: (input: PlatformCreativeInput) => boolean) {
  const store = new Map<string, PlatformCreativeInput>();
  const inputs: PlatformCreativeInput[] = [];
  const upsert: UpsertFn = async (input) => {
    inputs.push(input);
    if (fail?.(input)) throw new Error(`storage refused ${input.platformCreativeId}`);
    const key = `${input.platform}:${input.platformCreativeId}`;
    const created = !store.has(key);
    store.set(key, input);
    return { creative: { id: key }, created };
  };
  return { upsert, inputs, store };
}
