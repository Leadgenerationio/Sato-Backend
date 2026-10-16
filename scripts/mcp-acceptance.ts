/**
 * MCP acceptance harness: replays Sam Wynne's 16 MCP acceptance tests (MCP spec v1.0), plus a 17th for the fixes from his 15 Oct staging run, against a live Stato backend,
 * the way a bot sees it: the official MCP SDK client over Streamable HTTP at <base>/mcp with a Stato API key, plus the
 * owner's REST screens (clients, ad accounts, API keys, Activity, webhooks) as the reference to compare against.
 *
 *   STATO_BASE_URL=https://sato-backend-staging-staging.up.railway.app STATO_EMAIL=... STATO_PASSWORD=... pnpm mcp:acceptance
 *
 * Env (read only from the environment; never printed, never written to the results):
 *   STATO_BASE_URL   backend origin (no /api/v1). Refused unless the host contains "staging", or is localhost/127.0.0.1,
 *                    or ALLOW_HOST is set to exactly that host.
 *   STATO_EMAIL, STATO_PASSWORD   an Owner login (API keys, Activity and webhooks are Owner only).
 *   TESTS            optional, e.g. "3,5,7,8,10,11,12". Default: all 17.
 *   OUT              optional results folder. Default: ./acceptance-out/<run tag>/ (gitignored).
 *   STATO_CAMPAIGN_ID optional Stato campaign UUID for test 3. Default: the "MCP TEST" campaign (scripts/seed-staging-mcp-campaigns.ts).
 *   WEBHOOK_URL      optional receiver for the creative.added check. Default: https://httpbin.org/status/200.
 *   SAMPLE_MP4       optional path to a real short mp4, used when ffmpeg is not installed (duration and poster need a real video).
 *   VIDEO_MB         optional size of the test-3 video. Default 300.
 *   CLEANUP=1        optional: also delete the two "Yash Test" clients at the end (by default they are kept as evidence and listed).
 *
 * Everything it creates is named "Yash Test <date> ACC <tag> ..." and listed in results.json. Every API key it creates is
 * revoked at the end, the webhook endpoint it creates is deleted, and the campaign link it adds is removed.
 * Standalone on purpose (no imports from src/): it talks to the server only over HTTP, like a real bot.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── Config and guards ───────────────────────────────────────────────────────

const MiB = 1024 * 1024;
const ALL_SCOPES = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'ad_accounts:write', 'ad_links:write', 'creatives:read', 'creatives:write', 'creatives:archive', 'uploads:write', 'landing_pages:write'];
const READ_SCOPES = ['clients:read', 'campaigns:read', 'ad_accounts:read', 'creatives:read'];
const WRITE_TOOLS = new Set(['link_ad_account', 'create_upload', 'complete_upload', 'upload_asset', 'update_asset', 'archive_asset', 'restore_asset', 'link_ad_platform_ids', 'unlink_ad_platform_ids', 'add_landing_page', 'attach_landing_page']);
const ACCEPT = 'application/json, text/event-stream';
const TITLES: Record<number, string> = {
  1: 'Connect with the SDK: 22 tools, whoami, structured errors',
  2: 'list_clients / list_campaigns / list_ad_accounts match the REST screens',
  3: 'Direct multipart upload of a big mp4, filed for the client and campaign that own a Meta account',
  4: 'link_ad_platform_ids: act_ account, 18-digit IDs as strings, find_asset_by_platform_id',
  5: 'Link to a Meta account of another client: account_client_mismatch, nothing saved, audited',
  6: 'Upload under an unlinked ad account: account_not_linked with a link_ad_account hint',
  7: 'link_ad_account for another client\'s account: move_requires_confirm, then moved',
  8: 'Idempotency replay and duplicate detection: one creative',
  9: 'Signed download URL with expiry, anonymous Range fetch, ad IDs recorded',
  10: 'Read-only key gets insufficient_scope; revoked key gets 401 within 60 s',
  11: 'Refusals: 5 GB, .exe renamed .mp4, internal sourceUrls',
  12: '130 calls in a minute: 120 pass, then rate_limited with Retry-After',
  13: 'Archive, list, restore',
  14: 'TikTok 19-digit ID, Google dashes, tik-tok alias',
  15: 'Landing page with utm_ and fbclid twice: one record',
  16: 'Activity log: rows for every tool, bot name, transport, result, records touched, no key text',
  17: "Sam's 15 Oct fixes: null optional inputs, retryable on URL errors, campaigns on ad accounts, thumbnailStatus, Activity without connection steps",
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const rawBase = (process.env.STATO_BASE_URL ?? '').trim().replace(/\/+$/, '');
if (!rawBase) fail('Set STATO_BASE_URL (the backend origin, e.g. https://sato-backend-staging-staging.up.railway.app).');
let baseUrl: URL;
try { baseUrl = new URL(rawBase); } catch { fail('STATO_BASE_URL is not a valid URL.'); }
if (!/^https?:$/.test(baseUrl.protocol)) fail('STATO_BASE_URL must be http or https.');
const host = baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 [..] brackets so ::1 compares
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
// "staging" must be its own label (…-staging., staging.…), not merely a substring of a production host name.
const isStaging = /(^|[.-])staging([.-]|$)/.test(host);
const hostAllowed = isStaging || isLocal || (process.env.ALLOW_HOST ?? '').toLowerCase() === host;
if (!hostAllowed) fail(`Refusing to run against "${host}": this harness writes data. Only staging/localhost hosts run by default; set ALLOW_HOST=${host} if you really mean this host (never production).`);
const BASE = baseUrl.origin;
const EMAIL = process.env.STATO_EMAIL ?? '';
const PASSWORD = process.env.STATO_PASSWORD ?? '';
if (!EMAIL || !PASSWORD) fail('Set STATO_EMAIL and STATO_PASSWORD (an Owner login).');

const SELECTED = (process.env.TESTS ?? '').trim()
  ? [...new Set((process.env.TESTS ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 17))].sort((a, b) => a - b)
  : Array.from({ length: 17 }, (_, i) => i + 1);
if (!SELECTED.length) fail('TESTS lists no test between 1 and 17.');

const RUN_STARTED = new Date();
const TAG = String(Date.now()).slice(-9); // 9 digits: also the stem of every fake platform ID, so a run never collides with another
const DATE = RUN_STARTED.toISOString().slice(0, 10);
const PREFIX = `Yash Test ${DATE} ACC ${TAG}`;
const BOT = `yash-acceptance-bot-${TAG}`;
const OUT = path.resolve(process.env.OUT || path.join('acceptance-out', TAG));
const VIDEO_BYTES = Math.round(Number(process.env.VIDEO_MB || 300) * MiB);
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://httpbin.org/status/200';

// Fake but well-formed platform IDs, unique per run.
const META = { a: `act_8${TAG}0001`, b: `act_8${TAG}0002`, c: `act_8${TAG}0003`, unlinked: `act_8${TAG}0009` };
const ID18 = (n: number) => `120${TAG}${String(n).padStart(6, '0')}`; // 18 digits, above 2^53: a number would lose digits
const TIKTOK19 = `7${TAG}000000019`;
const GOOGLE_DASHED = `5${TAG.slice(0, 2)}-${TAG.slice(2, 5)}-${TAG.slice(5, 9)}`;
const digits = (s: string) => s.replace(/^act_/i, '').replace(/-/g, '');

// ─── Small utilities ─────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const SECRET_PATTERNS = [/stk_[A-Za-z0-9_-]+/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g];
// Only redact a password long enough to be unambiguous: blanking a 1-3 char password would replace those characters
// everywhere in the output and corrupt the evidence. The password is only ever sent in the login body, never echoed
// into an observed string, so a very short one going unredacted is harmless.
const secrets = new Set<string>(PASSWORD.length >= 6 ? [PASSWORD] : []);
function redact(s: string): string {
  let out = s;
  for (const v of secrets) if (v) out = out.split(v).join('[redacted]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (m.startsWith('stk_') ? 'stk_[redacted]' : '[redacted-token]'));
  return out;
}
const short = (v: unknown, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return redact(s.length > n ? `${s.slice(0, n)}…` : s); };
const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

// A tiny valid PNG (unique bytes per seed), so image uploads need no fixture file.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(seed: string): Buffer {
  const w = 64; const h = 64; const fill = createHash('sha256').update(`${seed}-${TAG}`).digest();
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = fill[(x + y) % fill.length]! ^ (x * y);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Results ─────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
type TestVerdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED';
interface CheckResult { id: string; name: string; verdict: Verdict; observed: string; ms: number }
interface TestResult { id: number; title: string; verdict: TestVerdict; ms: number; checks: CheckResult[] }
type Outcome = { verdict: Verdict; observed: string };
const pass = (ok: boolean, observed: string): Outcome => ({ verdict: ok ? 'PASS' : 'FAIL', observed });
const blocked = (observed: string): Outcome => ({ verdict: 'BLOCKED', observed });

class TestRun {
  readonly checks: CheckResult[] = [];
  constructor(readonly id: number) {}
  async check(name: string, fn: () => Promise<Outcome> | Outcome): Promise<Outcome> {
    const t0 = Date.now();
    let out: Outcome;
    try { out = await fn(); } catch (e) { out = { verdict: 'FAIL', observed: `threw: ${errText(e)}` }; }
    const row = { id: `${this.id}.${this.checks.length + 1}`, name, verdict: out.verdict, observed: redact(out.observed), ms: Date.now() - t0 };
    this.checks.push(row);
    console.log(`  ${row.verdict.padEnd(7)} ${row.id} ${name}: ${row.observed}`);
    return out;
  }
  verdict(): TestVerdict {
    const v = this.checks.map((c) => c.verdict);
    if (!v.length || v.every((x) => x === 'BLOCKED')) return 'BLOCKED';
    if (v.includes('FAIL')) return 'FAIL';
    return v.every((x) => x === 'PASS') ? 'PASS' : 'PARTIAL';
  }
}

// ─── REST (owner login) ──────────────────────────────────────────────────────

let jwt = '';
async function login(): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }), signal: AbortSignal.timeout(30_000) });
  const body = (await r.json().catch(() => ({}))) as { data?: { tokens?: { accessToken?: string; refreshToken?: string } }; message?: string };
  const token = body.data?.tokens?.accessToken;
  if (!r.ok || !token) throw new Error(`Owner login failed (HTTP ${r.status}${body.message ? `: ${redact(body.message)}` : ''})`);
  jwt = token; secrets.add(token);
  if (body.data?.tokens?.refreshToken) secrets.add(body.data.tokens.refreshToken);
}
interface RestRes { status: number; body: any; headers: Headers }
async function rest(method: string, p: string, body?: unknown, retried = false): Promise<RestRes> {
  const r = await fetch(`${BASE}/api/v1${p}`, {
    method, headers: { Authorization: `Bearer ${jwt}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
  });
  if (r.status === 401 && !retried) { await login(); return rest(method, p, body, true); } // the access token expired mid-run
  const text = await r.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, body: parsed, headers: r.headers };
}

// ─── MCP (SDK client) ────────────────────────────────────────────────────────

interface ToolRes { isError: boolean; sc: any; text: string; thrown?: string }
const createdKeys: Array<{ id: string; name: string; key: string; revoked: boolean }> = [];
const toolsCalled = new Set<string>();

async function createKey(label: string, scopes: string[]): Promise<{ id: string; key: string; name: string }> {
  const name = `Yash Test ACC ${TAG} ${label}`;
  const r = await rest('POST', '/api-keys', { name, scopes, agentLabel: BOT });
  const key = r.body?.data?.key as string | undefined; const id = r.body?.data?.apiKey?.id as string | undefined;
  if (r.status !== 201 || !key || !id) throw new Error(`Could not create API key "${name}" (HTTP ${r.status}: ${short(r.body?.message ?? r.body, 200)})`);
  secrets.add(key);
  createdKeys.push({ id, name, key, revoked: false });
  return { id, key, name };
}
async function revokeKey(id: string): Promise<number> {
  const r = await rest('DELETE', `/api-keys/${id}`);
  const k = createdKeys.find((x) => x.id === id);
  if (k && (r.status === 200 || r.status === 404)) k.revoked = true;
  return r.status;
}

class Bot {
  private client: Client | null = null;
  constructor(readonly key: string, readonly name = BOT) {}
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({ name: this.name, version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${this.key}`, 'X-Stato-Agent': this.name } } }));
    this.client = c;
    return c;
  }
  async listTools() { return (await this.connect()).listTools(); }
  /** One tools/call. A tool error comes back as isError + structuredContent; only a transport failure throws (kept in `thrown`). */
  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<ToolRes> {
    const c = await this.connect();
    toolsCalled.add(name);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        const text = Array.isArray(r.content) ? r.content.map((x) => (x as { text?: string }).text ?? '').join('\n') : '';
        return { isError: Boolean(r.isError), sc: r.structuredContent ?? {}, text };
      } catch (e) {
        // Over this key's 120 a minute: wait and repeat (the harness itself is a busy bot), except where the test wants to see it.
        if (/429|rate.?limit/i.test(String(e)) && attempt < 8) { await sleep(10_000); continue; }
        return { isError: true, sc: {}, text: '', thrown: errText(e) };
      }
    }
  }
  async close() { await this.client?.close().catch(() => {}); this.client = null; }
}

/** A raw JSON-RPC POST to /mcp, for checks that need the HTTP status and headers (401, 429, Retry-After). */
async function rawCall(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: ACCEPT, 'Content-Type': 'application/json', 'X-Stato-Agent': BOT },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}

const code = (r: ToolRes) => (r.thrown ? `threw: ${r.thrown}` : String(r.sc?.code ?? (r.isError ? 'error' : 'ok')));

async function putBytes(url: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<{ status: number; etag: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers, signal: AbortSignal.timeout(15 * 60_000) });
      await r.arrayBuffer().catch(() => undefined);
      return { status: r.status, etag: r.headers.get('etag') ?? '' };
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(3000);
    }
  }
}

// ─── Fixtures (shared by the tests) ──────────────────────────────────────────

interface Asset { creativeId: string; name: string; sha256: string; bytes: number; head: Buffer; mediaType: 'video' | 'image'; uploadArgs: Record<string, unknown> }
const fx = {
  mainKey: { id: '', key: '', name: '' },
  bot: null as Bot | null,
  clientA: '', clientB: '',
  campaignId: null as string | null, campaignNote: '', campaignLinkCreated: false,
  webhookId: null as string | null,
  video: null as Asset | null, videoNote: '',
  small: null as Asset | null,
  createdAssets: [] as Array<{ creativeId: string; name: string }>,
  landingPages: [] as string[],
  adIds: {} as Record<string, string>,
  tmpFiles: [] as string[],
};
const bot = () => fx.bot!;

async function setup(): Promise<void> {
  await login();
  fx.mainKey = await createKey('main', ALL_SCOPES);
  fx.bot = new Bot(fx.mainKey.key);
  for (const which of ['A', 'B'] as const) {
    const r = await rest('POST', '/clients', { companyName: `${PREFIX} Client ${which}`, status: 'active', currency: 'GBP', notes: `Created by scripts/mcp-acceptance.ts run ${TAG}. Safe to delete.` });
    const id = r.body?.data?.client?.id as string | undefined;
    if (r.status !== 201 || !id) throw new Error(`Could not create client ${which} (HTTP ${r.status}: ${short(r.body?.message ?? r.body, 200)})`);
    if (which === 'A') fx.clientA = id; else fx.clientB = id;
  }
  // The campaign: a test campaign client A buys, so the Meta account can feed it (test 3 "client and campaign that own a Meta account").
  // Campaigns come from LeadByte (no create endpoint), so use STATO_CAMPAIGN_ID or the seeded "MCP TEST" campaign and add a buyer link.
  let campaignId = process.env.STATO_CAMPAIGN_ID?.trim() || null;
  if (!campaignId) {
    const found = await bot().call('list_campaigns', { q: 'MCP TEST', limit: 10 });
    const items = (found.sc?.items ?? []) as Array<{ campaignId: string; leadbyteId: string | null; name: string }>;
    campaignId = (items.find((c) => c.leadbyteId === 'MCPTEST-1') ?? items[0])?.campaignId ?? null;
    fx.campaignNote = campaignId ? `seeded test campaign ${campaignId}` : 'no "MCP TEST" campaign found and STATO_CAMPAIGN_ID not set';
  } else fx.campaignNote = `STATO_CAMPAIGN_ID ${campaignId}`;
  if (campaignId) {
    const link = await rest('POST', `/campaigns/${campaignId}/clients`, { clientId: fx.clientA });
    if (link.status === 201 || link.status === 200) { fx.campaignId = campaignId; fx.campaignLinkCreated = true; }
    else fx.campaignNote += `; linking client A failed (HTTP ${link.status}: ${short(link.body?.message ?? link.body, 120)})`;
  }
  // Ad accounts: A's Meta account feeds the campaign; B owns two (one for test 5, one test 7 moves to A).
  const links: Array<[string, string, string | null]> = [[fx.clientA, META.a, fx.campaignId], [fx.clientB, META.b, null], [fx.clientB, META.c, null]];
  for (const [clientId, accountId, campaignId2] of links) {
    const r = await bot().call('link_ad_account', { clientId, platform: 'meta', accountId, accountName: `${PREFIX} ${accountId}`, currency: 'GBP', ...(campaignId2 ? { campaignId: campaignId2 } : {}) });
    if (r.isError) throw new Error(`Could not link ${accountId} (${code(r)}: ${short(r.sc?.message ?? r.text, 200)})`);
  }
}

/** A small image asset under client A, filed with an idempotencyKey (the stand-in when test 3 did not run). */
async function uploadPng(seed: string, name: string, extra: Record<string, unknown> = {}): Promise<{ res: ToolRes; buf: Buffer; uploadId: string }> {
  const buf = png(seed);
  const c = await bot().call('create_upload', { filename: `${seed}.png`, contentType: 'image/png', sizeBytes: buf.length, sha256: sha256(buf) });
  if (c.isError) throw new Error(`create_upload: ${code(c)} ${short(c.sc?.message ?? c.text, 150)}`);
  const put = await putBytes(c.sc.uploadUrl, buf, c.sc.headers ?? { 'Content-Type': 'image/png' });
  if (put.status !== 200) throw new Error(`PUT to the presigned URL answered HTTP ${put.status}`);
  const done = await bot().call('complete_upload', { uploadId: c.sc.uploadId });
  if (done.isError || done.sc.status !== 'ready') throw new Error(`complete_upload: ${code(done)} ${short(done.sc, 150)}`);
  const res = await bot().call('upload_asset', { uploadId: c.sc.uploadId, platform: 'meta', platformAccountId: META.a, name, ...extra });
  return { res, buf, uploadId: c.sc.uploadId };
}
async function ensureSmall(): Promise<Asset> {
  if (fx.small) return fx.small;
  const name = `${PREFIX} small image`;
  const extra = { idempotencyKey: `acc-${TAG}-small`, ...(fx.campaignId ? { campaignId: fx.campaignId } : {}) };
  const { res, buf, uploadId } = await uploadPng('small', name, extra);
  if (res.isError) throw new Error(`upload_asset: ${code(res)} ${short(res.sc?.message ?? res.text, 150)}`);
  fx.small = { creativeId: res.sc.creativeId, name, sha256: sha256(buf), bytes: buf.length, head: buf.subarray(0, 1024), mediaType: 'image', uploadArgs: { uploadId, platform: 'meta', platformAccountId: META.a, name, ...extra } };
  fx.createdAssets.push({ creativeId: res.sc.creativeId, name });
  return fx.small;
}
/** Test 3's video if it ran and was filed, else the small image. */
async function anyAsset(): Promise<Asset> { return fx.video ?? ensureSmall(); }
async function activity(q: Record<string, string>): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ ...q, limit: '200', ...(cursor ? { cursor } : {}) });
    const r = await rest('GET', `/api-keys/activity?${qs}`);
    if (r.status !== 200) throw new Error(`Activity answered HTTP ${r.status}: ${short(r.body?.message ?? r.body, 150)}`);
    items.push(...(r.body.data.items as any[]));
    cursor = r.body.data.nextCursor;
    if (!cursor) break;
  }
  return items;
}
const since = (d: Date) => new Date(d.getTime() - 5000).toISOString();

// ─── The mp4 for test 3 ──────────────────────────────────────────────────────

interface Video { file: string; bytes: number; sha256: string; head: Buffer; how: string; real: boolean; expectedDurationS: number | null }
function has(bin: string): boolean { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; }
async function makeVideo(target: number): Promise<Video> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stato-acc-'));
  const base = path.join(dir, 'base.mp4');
  const file = path.join(dir, `yash-test-${TAG}.mp4`);
  fx.tmpFiles.push(dir);
  let how = ''; let real = false; let expectedDurationS: number | null = null;
  if (has('ffmpeg')) {
    const args = (codec: string[]) => ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=12:size=640x360:rate=25', ...codec, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', base];
    let r = spawnSync('ffmpeg', args(['-c:v', 'libx264']), { stdio: 'ignore' });
    if (r.status !== 0) r = spawnSync('ffmpeg', args(['-c:v', 'mpeg4']), { stdio: 'ignore' });
    if (r.status === 0) { how = 'ffmpeg testsrc2 12 s 640x360'; real = true; expectedDurationS = 12; }
  }
  if (!real && process.env.SAMPLE_MP4 && fs.existsSync(process.env.SAMPLE_MP4)) {
    fs.copyFileSync(process.env.SAMPLE_MP4, base);
    how = 'SAMPLE_MP4'; real = true;
    if (has('ffprobe')) {
      const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', base], { encoding: 'utf8' });
      const d = Number(String(p.stdout).trim());
      if (Number.isFinite(d) && d > 0) expectedDurationS = d;
    }
  }
  if (!real) {
    // No ffmpeg and no sample: a file the server accepts as mp4 (ftyp box) but cannot read a duration or poster from.
    const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4, 'ascii'); ftyp.write('isom', 8, 'ascii'); ftyp.write('isommp41', 16, 'ascii');
    fs.writeFileSync(base, ftyp);
    how = 'synthetic ftyp-only mp4 (no ffmpeg, no SAMPLE_MP4)';
  }
  // Pad to the target size with a top-level "free" box: still a valid ISO-BMFF file, and the run tag makes its SHA-256 unique.
  const baseBuf = fs.readFileSync(base);
  const pad = Math.max(0, target - baseBuf.length);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, baseBuf);
  if (pad >= 8) {
    const hdr = Buffer.alloc(8); hdr.writeUInt32BE(pad, 0); hdr.write('free', 4, 'ascii');
    fs.writeSync(fd, hdr);
    let left = pad - 8; const chunk = Buffer.alloc(16 * MiB); chunk.write(`yash-acceptance-${TAG}`, 0, 'ascii');
    while (left > 0) { const n = Math.min(left, chunk.length); fs.writeSync(fd, chunk, 0, n); left -= n; chunk.fill(0, 0, 64); }
  }
  fs.closeSync(fd);
  const hash = createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c as Buffer);
  const bytes = fs.statSync(file).size;
  return { file, bytes, sha256: hash.digest('hex'), head: fs.readFileSync(file).subarray(0, 1024), how, real, expectedDurationS };
}

// ─── The 17 tests ────────────────────────────────────────────────────────────

async function test1(t: TestRun) {
  await t.check('connect with the official SDK client (Streamable HTTP, Bearer stk_ key)', async () => {
    const info = (await bot().connect()).getServerVersion();
    return pass(Boolean(info), `server ${short(info)}; bot name sent as X-Stato-Agent and clientInfo: ${BOT}`);
  });
  await t.check('tools/list returns 22 tools, each with a description', async () => {
    const { tools } = await bot().listTools();
    const missing = tools.filter((x) => !(x.description ?? '').trim()).map((x) => x.name);
    return pass(tools.length === 22 && missing.length === 0, `${tools.length} tools; without description: ${missing.length ? missing.join(', ') : 'none'}`);
  });
  await t.check('whoami shows the key name and its scopes', async () => {
    const r = await bot().call('whoami');
    const scopes = (r.sc?.key?.scopes ?? []) as string[];
    const missing = ALL_SCOPES.filter((s) => !scopes.includes(s));
    return pass(!r.isError && r.sc.keyName === fx.mainKey.name && missing.length === 0, `keyName "${r.sc.keyName}", ${scopes.length} scopes${missing.length ? `, missing ${missing.join(', ')}` : ''}, agent ${r.sc.agent}`);
  });
  await t.check('a tool error comes back structured (code, message, hint), not thrown', async () => {
    const r = await bot().call('get_client', { clientId: '00000000-0000-4000-8000-000000000000' });
    return pass(!r.thrown && r.isError && r.sc.code === 'not_found' && typeof r.sc.message === 'string' && typeof r.sc.hint === 'string', `isError ${r.isError}, code ${code(r)}, message "${short(r.sc.message, 80)}", hint ${typeof r.sc.hint}`);
  });
  await t.check('bad input comes back structured as validation_failed with fields', async () => {
    const r = await bot().call('get_client', { clientId: 'not-a-uuid' });
    return pass(!r.thrown && r.isError && r.sc.code === 'validation_failed' && Array.isArray(r.sc.fields), `code ${code(r)}, fields ${short(r.sc.fields, 120)}`);
  });
}

const TO_SPEC: Record<string, string> = { 'facebook-ads': 'meta', 'google-ads': 'google', 'tik-tok': 'tiktok' };
const spec = (p: string) => TO_SPEC[p] ?? p;

async function test2(t: TestRun) {
  await t.check('list_clients matches the Clients screen (count and IDs)', async () => {
    const mcpIds = new Set<string>(); let cursor: string | null = null;
    do {
      const r = await bot().call('list_clients', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (r.isError) return pass(false, `list_clients ${code(r)}`);
      for (const c of r.sc.items) mcpIds.add(c.clientId);
      cursor = r.sc.nextCursor;
    } while (cursor);
    const restIds = new Set<string>(); let total = 0;
    for (let page = 1; page < 200; page++) {
      const r = await rest('GET', `/clients?limit=100&page=${page}`);
      if (r.status !== 200) return pass(false, `REST /clients HTTP ${r.status}`);
      total = r.body.data.total;
      for (const c of r.body.data.clients) restIds.add(c.id);
      if (restIds.size >= total || !r.body.data.clients.length) break;
    }
    const onlyMcp = [...mcpIds].filter((x) => !restIds.has(x)); const onlyRest = [...restIds].filter((x) => !mcpIds.has(x));
    return pass(mcpIds.size === total && !onlyMcp.length && !onlyRest.length, `MCP ${mcpIds.size}, REST total ${total}; only in MCP ${onlyMcp.length}, only in REST ${onlyRest.length}`);
  });
  const restAcc = await rest('GET', '/ad-accounts');
  const mcpAcc: any[] = [];
  let summary: any = null;
  { let cursor: string | null = null;
    do { const r = await bot().call('list_ad_accounts', { limit: 200, ...(cursor ? { cursor } : {}) }); if (r.isError) break; mcpAcc.push(...r.sc.items); summary = r.sc.summary; cursor = r.sc.nextCursor; } while (cursor); }
  await t.check('list_ad_accounts matches the Ad accounts screen (linked count, every link, no extra accounts)', async () => {
    if (restAcc.status !== 200) return pass(false, `REST /ad-accounts HTTP ${restAcc.status}`);
    const restByKey = new Map<string, any>((restAcc.body.data.accounts as any[]).map((a) => [`${spec(a.platform)}:${a.accountId}`, a]));
    const wrong: string[] = []; const extra: string[] = [];
    for (const a of mcpAcc) {
      const r = restByKey.get(`${a.platform}:${a.accountId}`);
      if (!r) { extra.push(`${a.platform}:${a.accountId}`); continue; }
      if ((r.link?.clientId ?? null) !== a.clientId) wrong.push(`${a.platform}:${a.accountId}`);
    }
    const restLinked = (restAcc.body.data.accounts as any[]).filter((a) => a.link).length;
    // The REST screen also lists unclaimed accounts with spend from other businesses' feeds; MCP hides those (businessOnly), so only linked counts must match.
    return pass(!wrong.length && !extra.length && summary?.linked === restLinked, `MCP total ${summary?.total} (linked ${summary?.linked}), REST total ${restAcc.body.data.summary?.total} (linked ${restLinked}); link mismatches ${wrong.length}${wrong.length ? ` (${wrong.slice(0, 3).join(', ')})` : ''}; MCP-only ${extra.length}`);
  });
  await t.check('the run\'s clients A and B show the ad accounts linked to them (MCP vs REST)', async () => {
    const r = await bot().call('list_clients', { q: `ACC ${TAG}`, limit: 10 });
    const items = (r.sc.items ?? []) as Array<{ clientId: string; adAccountCount: number }>;
    const restCount = (id: string) => (restAcc.body?.data?.accounts as any[] ?? []).filter((a) => a.link?.clientId === id).length;
    const a = items.find((x) => x.clientId === fx.clientA); const b = items.find((x) => x.clientId === fx.clientB);
    return pass(Boolean(a && b) && a!.adAccountCount === restCount(fx.clientA) && b!.adAccountCount === restCount(fx.clientB),
      `A: MCP ${a?.adAccountCount} vs REST ${restCount(fx.clientA)}; B: MCP ${b?.adAccountCount} vs REST ${restCount(fx.clientB)}`);
  });
  await t.check('list_campaigns matches the Campaigns screen', async () => {
    const r = await bot().call('list_campaigns', { limit: 100 });
    return blocked(`the Campaigns screen is sourced from LeadByte, which is in mock mode on staging, so it cannot be compared with Stato's campaign table; list_campaigns returned ${r.sc?.items?.length ?? code(r)} campaign(s) on the first page`);
  });
}

async function test3(t: TestRun) {
  const hook = await t.check('a webhook endpoint subscribed to creative.added is in place', async () => {
    const r = await rest('POST', '/webhook-endpoints', { url: WEBHOOK_URL, events: ['creative.added'], description: `${PREFIX} acceptance (deleted at the end)` });
    fx.webhookId = r.body?.data?.endpoint?.id ?? null;
    if (r.body?.data?.secret) secrets.add(r.body.data.secret);
    return pass(r.status === 201 && Boolean(fx.webhookId), `HTTP ${r.status}, endpoint ${fx.webhookId ?? short(r.body?.message ?? r.body, 120)} -> ${WEBHOOK_URL}`);
  });
  let video: Video | null = null;
  await t.check(`generate a ${Math.round(VIDEO_BYTES / MiB)} MB mp4 locally`, async () => {
    video = await makeVideo(VIDEO_BYTES);
    fx.videoNote = video.how;
    return pass(video.bytes >= VIDEO_BYTES, `${video.how}; ${video.bytes} bytes; sha256 ${video.sha256.slice(0, 16)}…`);
  });
  if (!video) return;
  const v = video as Video;
  let up: ToolRes | null = null;
  await t.check('create_upload answers multipart with presigned part URLs', async () => {
    up = await bot().call('create_upload', { filename: path.basename(v.file), contentType: 'video/mp4', sizeBytes: v.bytes, sha256: v.sha256 });
    const parts = (up.sc.parts ?? []) as unknown[];
    return pass(!up.isError && up.sc.mode === 'multipart' && parts.length === Math.ceil(v.bytes / (64 * MiB)) && !up.sc.uploadUrl, `mode ${up.sc.mode}, ${parts.length} parts of ${up.sc.partSize} bytes, expires ${up.sc.expiresAt}${up.isError ? `, ${code(up)}` : ''}`);
  });
  const created = up as ToolRes | null;
  if (!created || created.isError) return;
  const etags: Array<{ partNumber: number; etag: string }> = [];
  await t.check('PUT every part straight to its presigned URL', async () => {
    const t0 = Date.now(); const fd = fs.openSync(v.file, 'r'); const bad: string[] = [];
    try {
      for (const p of created.sc.parts as Array<{ partNumber: number; url: string; bytes: number }>) {
        const buf = Buffer.alloc(p.bytes);
        fs.readSync(fd, buf, 0, p.bytes, (p.partNumber - 1) * created.sc.partSize);
        const r = await putBytes(p.url, buf);
        if (r.status !== 200 || !r.etag) bad.push(`part ${p.partNumber}: HTTP ${r.status}, etag ${r.etag ? 'yes' : 'no'}`);
        etags.push({ partNumber: p.partNumber, etag: r.etag });
      }
    } finally { fs.closeSync(fd); }
    const s = (Date.now() - t0) / 1000;
    return pass(!bad.length, `${etags.length} parts in ${s.toFixed(1)} s (${(v.bytes / MiB / s).toFixed(1)} MB/s)${bad.length ? `; ${bad.join('; ')}` : ''}`);
  });
  let ready: ToolRes | null = null;
  await t.check('complete_upload verifies size, type and SHA-256 (polled until ready)', async () => {
    const t0 = Date.now();
    let r = await bot().call('complete_upload', { uploadId: created.sc.uploadId, parts: etags }, 300_000);
    while (!r.isError && r.sc.status === 'processing' && Date.now() - t0 < 15 * 60_000) { await sleep(5000); r = await bot().call('complete_upload', { uploadId: created.sc.uploadId, parts: etags }, 300_000); }
    ready = r;
    return pass(!r.isError && r.sc.status === 'ready' && r.sc.sizeBytes === v.bytes && r.sc.contentType === 'video/mp4' && r.sc.sha256 === v.sha256,
      `status ${r.sc.status ?? code(r)}, size ${r.sc.sizeBytes}, type ${r.sc.contentType}, sha256 ${r.sc.sha256 === v.sha256 ? 'matches' : `differs (${String(r.sc.sha256).slice(0, 12)}…)`}, after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  });
  if (!ready || (ready as ToolRes).isError) return;
  const name = `${PREFIX} 300MB video`;
  const uploadArgs = { uploadId: created.sc.uploadId, platform: 'meta', platformAccountId: META.a, name, idempotencyKey: `acc-${TAG}-t3`, ...(fx.campaignId ? { campaignId: fx.campaignId } : {}) };
  let filed: ToolRes | null = null;
  await t.check('upload_asset files it from the uploadId for the Meta account', async () => {
    filed = await bot().call('upload_asset', uploadArgs, 300_000);
    if (!filed.isError) {
      fx.video = { creativeId: filed.sc.creativeId, name, sha256: v.sha256, bytes: v.bytes, head: v.head, mediaType: 'video', uploadArgs };
      fx.createdAssets.push({ creativeId: filed.sc.creativeId, name });
    }
    return pass(!filed.isError && filed.sc.result === 'created' && filed.sc.mediaType === 'video', `result ${filed.sc.result ?? code(filed)}, creative ${filed.sc.creativeId}, fileStatus ${filed.sc.fileStatus}, portalUrl ${filed.sc.portalUrl}`);
  });
  if (!fx.video) return;
  const id = fx.video.creativeId;
  await t.check('filed under the client and campaign that own the Meta account', async () => {
    const g = await bot().call('get_asset', { creativeId: id });
    if (!fx.campaignId) return g.sc.creative?.clientId === fx.clientA ? blocked(`client A is right; no campaign to check (${fx.campaignNote})`) : pass(false, `clientId ${g.sc.creative?.clientId}`);
    return pass(g.sc.creative?.clientId === fx.clientA && g.sc.creative?.campaignId === fx.campaignId, `client ${g.sc.creative?.clientName} (${g.sc.creative?.clientId === fx.clientA ? 'A' : 'wrong'}), campaign ${g.sc.creative?.campaignName} (${g.sc.creative?.campaignId === fx.campaignId ? 'right' : 'wrong'})`);
  });
  // The server reads duration and makes the poster in the background (ffprobe/ffmpeg on the server): poll get_asset.
  let detail: ToolRes | null = null;
  const t0 = Date.now();
  const waitMs = v.real ? 6 * 60_000 : 90_000; // a synthetic file has no duration or poster to wait for
  do { detail = await bot().call('get_asset', { creativeId: id }); if (detail.sc.creative?.fileStatus !== 'processing') break; await sleep(5000); } while (Date.now() - t0 < waitMs);
  const c = detail!.sc.creative ?? {};
  await t.check('size is the exact byte count', () => pass(c.sizeBytes === v.bytes, `sizeBytes ${c.sizeBytes} (sent ${v.bytes}), fileStatus ${c.fileStatus} after ${((Date.now() - t0) / 1000).toFixed(0)} s`));
  await t.check('duration is read from the video', () => {
    if (!v.real) return blocked(`the test file is ${v.how}: install ffmpeg or set SAMPLE_MP4 for a real video (server reported durationSeconds ${c.durationSeconds}, fileStatus ${c.fileStatus})`);
    const ok = typeof c.durationSeconds === 'number' && c.durationSeconds > 0 && (v.expectedDurationS == null || Math.abs(c.durationSeconds - v.expectedDurationS) <= 1);
    return pass(ok, `durationSeconds ${c.durationSeconds} (expected ${v.expectedDurationS ?? '> 0'}), ${c.width}x${c.height}, fileStatus ${c.fileStatus}`);
  });
  await t.check('the poster (thumbnail) downloads', async () => {
    if (!v.real) return blocked(`the test file is ${v.how}: the server cannot make a poster from it`);
    const url = c.thumbnailUrl as string | null;
    if (!url) return pass(false, `thumbnailUrl is null (fileStatus ${c.fileStatus})`);
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const len = (await r.arrayBuffer()).byteLength;
    return pass(r.status === 200 && /^image\//.test(r.headers.get('content-type') ?? '') && len > 0, `HTTP ${r.status}, ${r.headers.get('content-type')}, ${len} bytes`);
  });
  await t.check('a creative.added webhook delivery is recorded for this creative', async () => {
    if (hook.verdict !== 'PASS' || !fx.webhookId) return blocked('no webhook endpoint was created');
    const t1 = Date.now();
    while (Date.now() - t1 < 90_000) {
      const r = await rest('GET', `/webhook-endpoints/${fx.webhookId}/deliveries?limit=50`);
      const d = ((r.body?.data?.deliveries ?? []) as any[]).find((x) => x.event === 'creative.added' && JSON.stringify(x.payload).includes(id));
      if (d) return pass(true, `delivery ${d.id}: status ${d.status}, HTTP ${d.responseCode ?? '-'}, attempts ${d.attempts}`);
      await sleep(3000);
    }
    return pass(false, 'no creative.added delivery for this creative within 90 s');
  });
}

async function test4(t: TestRun) {
  const asset = await anyAsset();
  fx.adIds = { platformCampaignId: ID18(1), adsetId: ID18(2), adId: ID18(3), platformCreativeId: ID18(4), platformAssetId: ID18(5) };
  let r: ToolRes | null = null;
  await t.check('link_ad_platform_ids with the account as act_… and campaign/adset/ad/creative/video IDs', async () => {
    r = await bot().call('link_ad_platform_ids', { creativeId: asset.creativeId, platform: 'meta', accountId: META.a, ...fx.adIds, platformCampaignName: `${PREFIX} campaign`, adsetName: `${PREFIX} adset`, adName: `${PREFIX} ad`, status: 'active' });
    return pass(!r.isError && r.sc.result === 'created', `result ${r.sc.result ?? code(r)}, adLinkId ${r.sc.adLinkId} on ${asset.mediaType} ${asset.creativeId}`);
  });
  const link = (r as ToolRes | null)?.sc?.adLink ?? {};
  await t.check('the account is stored as digits (act_ removed)', () => pass(link.accountId === digits(META.a), `sent ${META.a}, stored ${link.accountId}`));
  await t.check('18-digit IDs round-trip exactly, as strings', () => {
    const bad = Object.entries(fx.adIds).filter(([k, val]) => typeof link[k] !== 'string' || link[k] !== val);
    return pass(!bad.length, bad.length ? `differs: ${bad.map(([k]) => `${k}=${short(link[k], 30)}`).join(', ')}` : `all 5 equal (e.g. adId "${link.adId}", typeof ${typeof link.adId})`);
  });
  await t.check('get_asset shows the link', async () => {
    const g = await bot().call('get_asset', { creativeId: asset.creativeId });
    const l = (g.sc.adLinks ?? []).find((x: any) => x.adId === fx.adIds.adId);
    return pass(Boolean(l) && l.accountId === digits(META.a), `${g.sc.adLinks?.length ?? 0} ad link(s); this one ${l ? `status ${l.status}, account ${l.accountId}` : 'missing'}`);
  });
  await t.check('find_asset_by_platform_id finds it by adId and by platformCreativeId', async () => {
    const a = await bot().call('find_asset_by_platform_id', { platform: 'meta', adId: fx.adIds.adId });
    const b = await bot().call('find_asset_by_platform_id', { platform: 'meta', platformCreativeId: fx.adIds.platformCreativeId });
    return pass(a.sc.found === true && a.sc.creative?.id === asset.creativeId && b.sc.found === true && b.sc.creative?.id === asset.creativeId, `by adId: found ${a.sc.found} (${a.sc.creative?.id === asset.creativeId ? 'same creative' : a.sc.creative?.id}); by creative ID: found ${b.sc.found}`);
  });
}

async function test5(t: TestRun) {
  const asset = await anyAsset();
  const started = new Date();
  const adId = ID18(51);
  const before = await bot().call('get_asset', { creativeId: asset.creativeId });
  await t.check('linking A\'s creative to B\'s Meta account is account_client_mismatch', async () => {
    const r = await bot().call('link_ad_platform_ids', { creativeId: asset.creativeId, platform: 'meta', accountId: META.b, adId, status: 'active' });
    return pass(r.isError && r.sc.code === 'account_client_mismatch', `code ${code(r)}, hint "${short(r.sc.hint, 100)}"`);
  });
  await t.check('nothing was saved', async () => {
    const f = await bot().call('find_asset_by_platform_id', { platform: 'meta', adId });
    const g = await bot().call('get_asset', { creativeId: asset.creativeId });
    return pass(f.sc.found === false && (g.sc.adLinks?.length ?? 0) === (before.sc.adLinks?.length ?? 0), `find by that adId: found ${f.sc.found}; ad links ${before.sc.adLinks?.length ?? 0} -> ${g.sc.adLinks?.length ?? 0}`);
  });
  await t.check('the refused call is in the audit log', async () => {
    await sleep(2000);
    const rows = await activity({ keyId: fx.mainKey.id, tool: 'link_ad_platform_ids', errorCode: 'account_client_mismatch', from: since(started) });
    return pass(rows.length >= 1, `${rows.length} Activity row(s)${rows[0] ? `: at ${rows[0].at}, result ${short(rows[0].result)}, agent ${rows[0].agent}` : ''}`);
  });
}

async function test6(t: TestRun) {
  const buf = png('t6');
  await t.check('upload_asset under an unlinked Meta account is account_not_linked, hint names link_ad_account', async () => {
    const c = await bot().call('create_upload', { filename: 't6.png', contentType: 'image/png', sizeBytes: buf.length });
    if (c.isError) return pass(false, `create_upload ${code(c)}`);
    await putBytes(c.sc.uploadUrl, buf, c.sc.headers ?? {});
    const done = await bot().call('complete_upload', { uploadId: c.sc.uploadId });
    if (done.sc.status !== 'ready') return pass(false, `complete_upload ${done.sc.status ?? code(done)}`);
    const r = await bot().call('upload_asset', { uploadId: c.sc.uploadId, platform: 'meta', platformAccountId: META.unlinked, name: `${PREFIX} unlinked` });
    return pass(r.isError && r.sc.code === 'account_not_linked' && /link_ad_account/.test(String(r.sc.hint)), `code ${code(r)}, hint "${short(r.sc.hint, 140)}"`);
  });
  await t.check('nothing was saved for that file', async () => {
    const f = await bot().call('find_asset_by_platform_id', { sha256: sha256(buf) });
    return pass(f.sc.found === false, `find by sha256: found ${f.sc.found}`);
  });
}

async function test7(t: TestRun) {
  const started = new Date();
  await t.check('link_ad_account of B\'s account to A is move_requires_confirm', async () => {
    const r = await bot().call('link_ad_account', { clientId: fx.clientA, platform: 'meta', accountId: META.c });
    return pass(r.isError && r.sc.code === 'move_requires_confirm', `code ${code(r)}, hint "${short(r.sc.hint, 100)}"`);
  });
  await t.check('the account still belongs to B', async () => {
    const r = await bot().call('find_client_by_ad_account', { platform: 'meta', accountId: META.c });
    return pass(r.sc.client?.clientId === fx.clientB, `owner ${r.sc.client?.name ?? code(r)}`);
  });
  await t.check('with confirmMove it is moved to A', async () => {
    const r = await bot().call('link_ad_account', { clientId: fx.clientA, platform: 'meta', accountId: META.c, confirmMove: true });
    return pass(!r.isError && r.sc.result === 'moved' && r.sc.link?.clientId === fx.clientA && r.sc.link?.movedFromClientId === fx.clientB, `result ${r.sc.result ?? code(r)}, now ${r.sc.link?.clientName}, moved from ${r.sc.link?.movedFromClientId === fx.clientB ? 'B' : r.sc.link?.movedFromClientId}`);
  });
  await t.check('both calls are logged', async () => {
    await sleep(2000);
    const rows = await activity({ keyId: fx.mainKey.id, tool: 'link_ad_account', from: since(started) });
    const refused = rows.filter((x) => x.errorCode === 'move_requires_confirm');
    const moved = rows.filter((x) => !x.errorCode && JSON.stringify(x.args ?? {}).includes('confirmMove'));
    return pass(refused.length >= 1 && moved.length >= 1, `${rows.length} link_ad_account rows: refused ${refused.length}, moved ${moved.length}${moved[0] ? ` (before ${short(moved[0].before, 80)}, after ${short(moved[0].after, 80)})` : ''}`);
  });
}

async function test8(t: TestRun) {
  await t.check('the same upload_asset with the same idempotencyKey replays the first answer', async () => {
    const a = fx.video ?? (await ensureSmall());
    const r = await bot().call('upload_asset', a.uploadArgs, 300_000);
    return pass(!r.isError && r.sc.replayed === true && r.sc.creativeId === a.creativeId, `${fx.video ? 'test 3 video' : 'small image (test 3 not run)'}: replayed ${r.sc.replayed}, creative ${r.sc.creativeId === a.creativeId ? 'same' : `${r.sc.creativeId ?? code(r)}`}`);
  });
  const n1 = `${PREFIX} dup first`; const n2 = `${PREFIX} dup second`;
  let first: ToolRes | null = null;
  await t.check('a small file filed twice under new keys: the second is result duplicate with the same creativeId', async () => {
    const one = await uploadPng('t8', n1, { idempotencyKey: `acc-${TAG}-t8-1` });
    first = one.res;
    if (one.res.isError) return pass(false, `first upload_asset ${code(one.res)}`);
    fx.createdAssets.push({ creativeId: one.res.sc.creativeId, name: n1 });
    const two = await uploadPng('t8', n2, { idempotencyKey: `acc-${TAG}-t8-2` });
    return pass(two.res.sc.result === 'duplicate' && two.res.sc.creativeId === one.res.sc.creativeId && two.res.sc.replayed === false, `first ${one.res.sc.result}, second ${two.res.sc.result ?? code(two.res)} (${two.res.sc.creativeId === one.res.sc.creativeId ? 'same creativeId' : 'different creativeId'})`);
  });
  await t.check('only one creative exists for that file', async () => {
    const f = first as ToolRes | null;
    if (!f || f.isError) return blocked('the first upload failed');
    const byHash = await bot().call('find_asset_by_platform_id', { sha256: sha256(png('t8')) });
    // Both names share "<prefix> dup": however the duplicate call treats the name, there must be one asset.
    const l = await bot().call('list_assets', { clientId: fx.clientA, q: `${PREFIX} dup`, includeArchived: true });
    const items = (l.sc.items ?? []) as Array<{ creativeId: string; name: string }>;
    return pass(byHash.sc.creative?.id === f.sc.creativeId && items.length === 1 && items[0]!.creativeId === f.sc.creativeId, `by sha256 -> ${byHash.sc.creative?.id === f.sc.creativeId ? 'the first creative' : byHash.sc.creative?.id}; ${items.length} asset(s) named "… dup …"${items[0] ? `, its name is now "${items[0].name.replace(PREFIX, '<prefix>')}"` : ''}`);
  });
}

async function test9(t: TestRun) {
  const asset = await anyAsset();
  await t.check('list_assets finds the asset', async () => {
    const r = await bot().call('list_assets', { clientId: fx.clientA, q: asset.name, limit: 10 });
    return pass((r.sc.items ?? []).some((x: any) => x.creativeId === asset.creativeId), `${r.sc.items?.length ?? code(r)} item(s) for "${asset.name}"`);
  });
  let g: ToolRes | null = null;
  await t.check('get_asset gives a signed download URL with an expiry', async () => {
    g = await bot().call('get_asset', { creativeId: asset.creativeId, downloadUrlMinutes: 30 });
    const exp = Date.parse(g.sc.expiresAt); const want = Date.now() + 30 * 60_000;
    return pass(typeof g.sc.downloadUrl === 'string' && Math.abs(exp - want) < 3 * 60_000, `downloadUrl ${g.sc.downloadUrl ? 'present' : 'null'}, expiresAt ${g.sc.expiresAt} (asked 30 min)`);
  });
  await t.check('an anonymous Range request to the URL works', async () => {
    const url = (g as ToolRes | null)?.sc?.downloadUrl as string | undefined;
    if (!url) return pass(false, 'no downloadUrl');
    const r = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(60_000) });
    const body = Buffer.from(await r.arrayBuffer());
    return pass(r.status === 206 && body.length === 1024 && body.equals(asset.head.subarray(0, 1024)), `HTTP ${r.status}, ${body.length} bytes, ${r.headers.get('content-range')}, first KB ${body.equals(asset.head.subarray(0, 1024)) ? 'matches the file' : 'differs'}`);
  });
  await t.check('link_ad_platform_ids records the ad IDs on the asset', async () => {
    let links = ((g as ToolRes | null)?.sc?.adLinks ?? []) as any[];
    if (!links.length) {
      const adId = ID18(91);
      await bot().call('link_ad_platform_ids', { creativeId: asset.creativeId, platform: 'meta', accountId: META.a, adId, platformAssetId: ID18(95) });
      links = (await bot().call('get_asset', { creativeId: asset.creativeId })).sc.adLinks ?? [];
    }
    return pass(links.length >= 1 && links.every((l) => typeof l.adId === 'string' || l.adId === null), `${links.length} ad link(s): ${links.map((l) => `ad ${l.adId}`).join(', ')}`);
  });
  await t.check('Sam\'s bot creates the Meta ad from the URL through Pipeboard', () => blocked('needs Sam\'s bot with Pipeboard/Meta access; this harness never writes to an ad platform'));
}

async function test10(t: TestRun) {
  const ro = await createKey('readonly', READ_SCOPES);
  const roBot = new Bot(ro.key);
  await t.check('a read-only key calling upload_asset gets insufficient_scope', async () => {
    const r = await roBot.call('upload_asset', { mediaType: 'copy', headline: `${PREFIX} read-only`, platform: 'meta', platformAccountId: META.a });
    return pass(r.isError && r.sc.code === 'insufficient_scope', `code ${code(r)}, hint "${short(r.sc.hint, 100)}"`);
  });
  await roBot.close();
  const ok = await rawCall(ro.key, 'whoami');
  let revokedAt = 0;
  await t.check('the owner revokes the key', async () => {
    const s = await revokeKey(ro.id); revokedAt = Date.now();
    return pass(s === 200 && ok.status === 200, `before: HTTP ${ok.status}; DELETE /api-keys/:id HTTP ${s}`);
  });
  await t.check('the revoked key gets 401 within 60 s', async () => {
    let last = 0;
    while (Date.now() - revokedAt < 60_000) {
      last = (await rawCall(ro.key, 'whoami')).status;
      if (last === 401) return pass(true, `401 after ${((Date.now() - revokedAt) / 1000).toFixed(1)} s`);
      await sleep(2000);
    }
    return pass(false, `still HTTP ${last} after 60 s`);
  });
}

async function test11(t: TestRun) {
  await t.check('create_upload of a 5 GB video is file_too_large with no URL', async () => {
    const r = await bot().call('create_upload', { filename: `${PREFIX} huge.mp4`.replace(/ /g, '_'), contentType: 'video/mp4', sizeBytes: 5 * 1024 * MiB });
    return pass(r.isError && r.sc.code === 'file_too_large' && !r.sc.uploadUrl && !r.sc.parts && !/https?:\/\//.test(r.text), `code ${code(r)}, uploadUrl ${r.sc.uploadUrl ?? 'none'}, parts ${r.sc.parts ? 'present' : 'none'}, hint "${short(r.sc.hint, 80)}"`);
  });
  await t.check('an .exe renamed .mp4 is unsupported_type', async () => {
    const exe = Buffer.concat([Buffer.from('4d5a90000300000004000000ffff0000', 'hex'), Buffer.from(`yash-acceptance-${TAG}`), Buffer.alloc(4000, 0x20)]);
    const c = await bot().call('create_upload', { filename: 'setup.mp4', contentType: 'video/mp4', sizeBytes: exe.length });
    if (c.isError) return pass(false, `create_upload ${code(c)}`);
    const put = await putBytes(c.sc.uploadUrl, exe, c.sc.headers ?? {});
    const r = await bot().call('complete_upload', { uploadId: c.sc.uploadId });
    return pass(put.status === 200 && r.isError && r.sc.code === 'unsupported_type', `PUT HTTP ${put.status}; complete_upload ${code(r)}: "${short(r.sc.message, 100)}"`);
  });
  for (const url of ['http://localhost:3001/x.mp4', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/x.mp4', 'http://127.0.0.1:5432/x.mp4']) {
    await t.check(`sourceUrl ${url} is source_unreachable`, async () => {
      const r = await bot().call('upload_asset', { sourceUrl: url, mediaType: 'video', platform: 'meta', platformAccountId: META.a, name: `${PREFIX} ssrf` });
      return pass(r.isError && r.sc.code === 'source_unreachable', `code ${code(r)}, "${short(r.sc.message, 100)}"`);
    });
  }
}

async function test12(t: TestRun) {
  const k = await createKey('ratelimit', ['clients:read']);
  const statuses: number[] = []; const limited: Array<{ status: number; retryAfterHeader: string | null; body: any }> = [];
  const t0 = Date.now();
  // 130 calls as fast as 10 in flight allow, all inside one minute.
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < 130) {
      next++;
      const r = await rawCall(k.key, 'whoami');
      statuses.push(r.status);
      if (r.status === 429) limited.push({ status: r.status, retryAfterHeader: r.headers.get('retry-after'), body: r.body });
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  const ok = statuses.filter((s) => s === 200).length;
  await t.check('about 120 of 130 calls in one minute pass', () => pass(secs < 60 && ok >= 115 && ok <= 120 && ok + limited.length === 130, `${ok} x 200, ${limited.length} x 429, other ${130 - ok - limited.length}, in ${secs.toFixed(1)} s`));
  await t.check('the rest are rate_limited with retryAfter in the body', () => {
    const bad = limited.filter((l) => l.body?.error?.data?.code !== 'rate_limited' || !(Number(l.body?.error?.data?.retryAfter) > 0));
    return pass(limited.length > 0 && !bad.length, limited[0] ? `e.g. ${short(limited[0].body?.error?.data, 200)}` : 'no 429 seen');
  });
  await t.check('HTTP 429 with a Retry-After header', () => {
    const bad = limited.filter((l) => !(Number(l.retryAfterHeader) > 0));
    return pass(limited.length > 0 && !bad.length, limited[0] ? `HTTP ${limited[0].status}, Retry-After ${limited[0].retryAfterHeader}` : 'no 429 seen');
  });
  await revokeKey(k.id);
}

async function test13(t: TestRun) {
  const a = await ensureSmall();
  const before = (await bot().call('get_asset', { creativeId: a.creativeId })).sc.creative ?? {};
  await t.check('archive_asset archives it', async () => {
    const r = await bot().call('archive_asset', { creativeId: a.creativeId, reason: `${PREFIX} acceptance test 13` });
    return pass(!r.isError && r.sc.result === 'archived' && Boolean(r.sc.creative?.archivedAt), `result ${r.sc.result ?? code(r)}, archivedAt ${r.sc.creative?.archivedAt}`);
  });
  await t.check('hidden from list_assets by default', async () => {
    const r = await bot().call('list_assets', { clientId: fx.clientA, q: a.name });
    return pass(!(r.sc.items ?? []).some((x: any) => x.creativeId === a.creativeId), `${r.sc.items?.length ?? code(r)} item(s) without includeArchived`);
  });
  await t.check('visible with includeArchived', async () => {
    const r = await bot().call('list_assets', { clientId: fx.clientA, q: a.name, includeArchived: true });
    const hit = (r.sc.items ?? []).find((x: any) => x.creativeId === a.creativeId);
    return pass(Boolean(hit?.archivedAt), `found ${Boolean(hit)}, archivedAt ${hit?.archivedAt}`);
  });
  await t.check('the file is still served while archived', async () => {
    const g = await bot().call('get_asset', { creativeId: a.creativeId });
    if (!g.sc.downloadUrl) return pass(false, 'downloadUrl null');
    const r = await fetch(g.sc.downloadUrl, { signal: AbortSignal.timeout(60_000) });
    const body = Buffer.from(await r.arrayBuffer());
    return pass(r.status === 200 && sha256(body) === a.sha256, `HTTP ${r.status}, ${body.length} bytes, sha256 ${sha256(body) === a.sha256 ? 'matches' : 'differs'}`);
  });
  await t.check('restore_asset brings it back intact', async () => {
    const r = await bot().call('restore_asset', { creativeId: a.creativeId, reason: `${PREFIX} acceptance test 13` });
    const after = (await bot().call('get_asset', { creativeId: a.creativeId })).sc.creative ?? {};
    const l = await bot().call('list_assets', { clientId: fx.clientA, q: a.name });
    const fields = ['name', 'sizeBytes', 'sha256', 'clientId', 'campaignId', 'mediaType', 'approvalStatus', 'tags'];
    const changed = fields.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
    return pass(r.sc.result === 'restored' && after.archivedAt === null && !changed.length && (l.sc.items ?? []).some((x: any) => x.creativeId === a.creativeId), `result ${r.sc.result ?? code(r)}, archivedAt ${after.archivedAt}, changed fields: ${changed.join(', ') || 'none'}, listed by default again`);
  });
}

async function test14(t: TestRun) {
  await t.check('a 19-digit TikTok advertiser ID linked with platform "tik-tok" round-trips exactly', async () => {
    const r = await bot().call('link_ad_account', { clientId: fx.clientA, platform: 'tik-tok', accountId: TIKTOK19, accountName: `${PREFIX} tiktok` });
    const f = await bot().call('find_client_by_ad_account', { platform: 'tiktok', accountId: TIKTOK19 });
    return pass(!r.isError && r.sc.link?.accountId === TIKTOK19 && f.sc.accountId === TIKTOK19 && f.sc.client?.clientId === fx.clientA, `link ${r.sc.result ?? code(r)} as ${r.sc.link?.platform}:${r.sc.link?.accountId}; find -> ${f.sc.accountId} (${typeof f.sc.accountId})`);
  });
  await t.check('the "tik-tok" alias finds it too', async () => {
    const f = await bot().call('find_client_by_ad_account', { platform: 'tik-tok', accountId: TIKTOK19 });
    return pass(f.sc.client?.clientId === fx.clientA && f.sc.platform === 'tiktok', `platform ${f.sc.platform ?? code(f)}, client ${f.sc.client?.name}`);
  });
  await t.check('a Google ID with dashes is stored as digits', async () => {
    const r = await bot().call('link_ad_account', { clientId: fx.clientA, platform: 'google', accountId: GOOGLE_DASHED, accountName: `${PREFIX} google` });
    return pass(!r.isError && r.sc.link?.accountId === digits(GOOGLE_DASHED), `sent ${GOOGLE_DASHED}, stored ${r.sc.link?.accountId ?? code(r)}`);
  });
  await t.check('the Google account is found with and without dashes', async () => {
    const a = await bot().call('find_client_by_ad_account', { platform: 'google', accountId: GOOGLE_DASHED });
    const b = await bot().call('find_client_by_ad_account', { platform: 'google', accountId: digits(GOOGLE_DASHED) });
    return pass(a.sc.client?.clientId === fx.clientA && b.sc.client?.clientId === fx.clientA, `with dashes: ${a.sc.client?.name ?? code(a)}; without: ${b.sc.client?.name ?? code(b)}`);
  });
}

async function test15(t: TestRun) {
  const page = `https://example.com/yash-test-${TAG}/landing`;
  const first = `${page}?utm_source=meta&utm_campaign=acc-${TAG}&fbclid=IwAR${TAG}a`;
  const second = `${page}/?fbclid=IwAR${TAG}b&utm_medium=paid&utm_source=facebook`;
  let a: ToolRes | null = null; let b: ToolRes | null = null;
  await t.check('the first add_landing_page creates it', async () => {
    a = await bot().call('add_landing_page', { clientId: fx.clientA, url: first, title: `${PREFIX} landing` });
    if (a.sc.landingPage?.id) fx.landingPages.push(a.sc.landingPage.id);
    return pass(!a.isError && a.sc.result === 'created', `result ${a.sc.result ?? code(a)}, id ${a.sc.landingPage?.id}`);
  });
  await t.check('the same page with other utm_/fbclid values is the same record', async () => {
    b = await bot().call('add_landing_page', { clientId: fx.clientA, url: second });
    return pass(!b.isError && b.sc.result === 'existing' && b.sc.landingPage?.id === (a as ToolRes | null)?.sc?.landingPage?.id, `result ${b.sc.result ?? code(b)}, ${b.sc.landingPage?.id === (a as ToolRes | null)?.sc?.landingPage?.id ? 'same id' : 'different id'}`);
  });
  await t.check('the stored URL is normalised (no utm_, no fbclid)', () => {
    const n = (a as ToolRes | null)?.sc?.landingPage?.normalisedUrl;
    return pass(n === page, `normalisedUrl ${n}`);
  });
  await t.check('one record for the client', async () => {
    const l = await bot().call('list_landing_pages', { clientId: fx.clientA, q: `yash-test-${TAG}` });
    return pass(l.sc.items?.length === 1, `${l.sc.items?.length ?? code(l)} landing page(s)`);
  });
}

async function test16(t: TestRun) {
  await sleep(3000); // audit rows are written after each response
  const rows: any[] = [];
  for (const k of createdKeys) rows.push(...(await activity({ keyId: k.id, from: since(RUN_STARTED) })));
  const tools = new Set(rows.map((r) => r.tool).filter(Boolean));
  await t.check('every tool the run called has Activity rows', () => {
    const missing = [...toolsCalled].filter((x) => !tools.has(x));
    return pass(rows.length > 0 && !missing.length, `${rows.length} rows for ${createdKeys.length} keys; ${toolsCalled.size} tools called; without rows: ${missing.join(', ') || 'none'}`);
  });
  await t.check('every row has the bot name, transport and result', () => {
    const bad = rows.filter((r) => r.agent !== BOT || !r.transport || !r.result || typeof r.result.outcome !== 'string');
    const transports = [...new Set(rows.map((r) => r.transport))].join('/');
    return pass(rows.length > 0 && !bad.length, `${bad.length} of ${rows.length} rows incomplete${bad[0] ? ` (e.g. ${short({ tool: bad[0].tool, agent: bad[0].agent, transport: bad[0].transport, result: bad[0].result }, 150)})` : ''}; transports ${transports}`);
  });
  await t.check('every successful write lists the records it touched', () => {
    const writes = rows.filter((r) => WRITE_TOOLS.has(r.tool) && r.result?.outcome === 'ok');
    const bad = writes.filter((r) => !Array.isArray(r.recordsTouched) || r.recordsTouched.length === 0);
    return pass(writes.length > 0 && !bad.length, `${writes.length} successful writes; without recordsTouched: ${bad.length}${bad[0] ? ` (e.g. ${bad[0].tool} ${bad[0].at})` : ''}`);
  });
  await t.check('no API key text anywhere in the log', () => {
    const text = JSON.stringify(rows);
    const full = createdKeys.filter((k) => text.includes(k.key)).length;
    const shaped = (text.match(/stk_[A-Za-z0-9_-]{12,}/g) ?? []).length;
    return pass(full === 0 && shaped === 0, `${full} of ${createdKeys.length} full keys found, ${shaped} key-shaped strings, in ${rows.length} rows`);
  });
}

/** The five points from Sam's staging run on 15 Oct (fixed in #126 and #94). */
async function test17(t: TestRun) {
  await t.check('null on an optional input means "not set" (list_campaigns { clientId: null })', async () => {
    const r = await bot().call('list_campaigns', { clientId: null, status: null, limit: 5 });
    return pass(!r.isError && Array.isArray(r.sc.items), `${code(r)}, ${Array.isArray(r.sc.items) ? `${r.sc.items.length} campaigns` : short(r.sc?.message ?? r.text, 120)}`);
  });
  await t.check('null on a required input still fails (get_client { clientId: null })', async () => {
    const r = await bot().call('get_client', { clientId: null });
    return pass(r.isError, `${code(r)}`);
  });
  const fromUrl = (sourceUrl: string) => bot().call('upload_asset', { sourceUrl, mediaType: 'image', platform: 'meta', platformAccountId: META.a, name: `${PREFIX} url error check` }, 60_000);
  await t.check('a blocked address is retryable: false', async () => {
    const r = await fromUrl('http://127.0.0.1:5432/x.png');
    return pass(r.isError && r.sc.retryable === false, `${code(r)}, retryable ${r.sc.retryable}, hint "${short(r.sc.hint, 100)}"`);
  });
  await t.check('a 404 source is retryable: false and its hint names the status', async () => {
    const r = await fromUrl('https://httpbin.org/status/404');
    return pass(r.isError && r.sc.retryable === false && /404|not found|gone/i.test(String(r.sc.hint)), `${code(r)}, retryable ${r.sc.retryable}, hint "${short(r.sc.hint, 100)}"`);
  });
  await t.check('a 503 source is retryable: true', async () => {
    const r = await fromUrl('https://httpbin.org/status/503');
    return pass(r.isError && r.sc.retryable === true, `${code(r)}, retryable ${r.sc.retryable}, hint "${short(r.sc.hint, 100)}"`);
  });
  await t.check('list_ad_accounts lists the linked campaign in campaigns', async () => {
    if (!fx.campaignId) return blocked(`no test campaign (${fx.campaignNote})`);
    const r = await bot().call('list_ad_accounts', { clientId: fx.clientA, limit: 50 });
    const a = ((r.sc.items ?? []) as any[]).find((x) => x.accountId === META.a);
    const ids = (a?.campaigns ?? []).map((c: any) => c.campaignId);
    return pass(!r.isError && a?.campaignId === fx.campaignId && ids[0] === fx.campaignId, `${code(r)}; ${META.a}: campaignId ${a?.campaignId ?? 'none'}, campaigns [${ids.join(', ')}]`);
  });
  await t.check('upload_asset and get_asset return thumbnailStatus', async () => {
    const a = await ensureSmall();
    const again = await bot().call('upload_asset', a.uploadArgs);
    const got = await bot().call('get_asset', { creativeId: a.creativeId });
    const ok = (s: unknown) => s === 'ready' || s === 'pending' || s === 'none';
    return pass(ok(again.sc.thumbnailStatus) && ok(got.sc.thumbnailStatus) && (got.sc.thumbnailStatus === 'ready') === Boolean(got.sc.thumbnailUrl), `upload_asset ${code(again)} thumbnailStatus ${again.sc.thumbnailStatus}; get_asset ${code(got)} thumbnailStatus ${got.sc.thumbnailStatus}, thumbnailUrl ${got.sc.thumbnailUrl ? 'set' : 'null'}`);
  });
  await t.check('Activity with includeConnection=false hides the connection steps; the default keeps them', async () => {
    await sleep(3000); // audit rows are written after each response
    const q = { keyId: fx.mainKey.id, from: since(RUN_STARTED) };
    const all = await activity(q);
    const toolsOnly = await activity({ ...q, includeConnection: 'false' });
    const conn = (rows: any[]) => rows.filter((r) => r.transport === 'mcp' && !r.tool).length;
    return pass(conn(all) > 0 && conn(toolsOnly) === 0 && toolsOnly.length === all.length - conn(all), `default ${all.length} rows (${conn(all)} connection steps); includeConnection=false ${toolsOnly.length} rows (${conn(toolsOnly)} connection steps)`);
  });
}

const TESTS: Record<number, (t: TestRun) => Promise<void>> = { 1: test1, 2: test2, 3: test3, 4: test4, 5: test5, 6: test6, 7: test7, 8: test8, 9: test9, 10: test10, 11: test11, 12: test12, 13: test13, 14: test14, 15: test15, 16: test16, 17: test17 };

// ─── Run ─────────────────────────────────────────────────────────────────────

async function cleanup(notes: string[]): Promise<void> {
  if (jwt) {
    for (const k of createdKeys.filter((x) => !x.revoked)) {
      const s = await revokeKey(k.id).catch((e) => { notes.push(`revoke ${k.name}: ${errText(e)}`); return 0; });
      notes.push(`revoked key "${k.name}" (HTTP ${s})`);
    }
    if (fx.webhookId) {
      const r = await rest('DELETE', `/webhook-endpoints/${fx.webhookId}`).catch(() => null);
      notes.push(`deleted webhook endpoint ${fx.webhookId} (HTTP ${r?.status ?? 'error'})`);
    }
    if (fx.campaignLinkCreated && fx.campaignId) {
      const r = await rest('DELETE', `/campaigns/${fx.campaignId}/clients/${fx.clientA}`).catch(() => null);
      notes.push(`removed client A from campaign ${fx.campaignId} (HTTP ${r?.status ?? 'error'})`);
    }
    if (process.env.CLEANUP === '1') {
      for (const id of [fx.clientA, fx.clientB].filter(Boolean)) {
        const r = await rest('DELETE', `/clients/${id}`).catch(() => null);
        notes.push(`deleted client ${id} (HTTP ${r?.status ?? 'error'})`);
      }
    }
  }
  for (const d of fx.tmpFiles) fs.rmSync(d, { recursive: true, force: true });
}

function writeResults(results: TestResult[], notes: string[], setupError: string | null) {
  fs.mkdirSync(OUT, { recursive: true });
  const count = (v: TestVerdict) => results.filter((r) => r.verdict === v).length;
  const summary = `${count('PASS')} passed, ${count('PARTIAL')} partial, ${count('FAIL')} failed, ${count('BLOCKED')} blocked`;
  const fixtures = {
    clients: [{ which: 'A', id: fx.clientA, name: `${PREFIX} Client A` }, { which: 'B', id: fx.clientB, name: `${PREFIX} Client B` }].filter((c) => c.id),
    metaAccounts: META, tiktokAccount: TIKTOK19, googleAccount: GOOGLE_DASHED, adIds: fx.adIds,
    campaign: { id: fx.campaignId, note: fx.campaignNote, linkAddedAndRemoved: fx.campaignLinkCreated },
    webhookEndpoint: fx.webhookId, assets: fx.createdAssets, landingPages: fx.landingPages,
    apiKeys: createdKeys.map((k) => ({ id: k.id, name: k.name, revoked: k.revoked })), video: fx.videoNote,
  };
  const doc = { tag: TAG, base: BASE, startedAt: RUN_STARTED.toISOString(), finishedAt: new Date().toISOString(), bot: BOT, tests: SELECTED, summary, setupError, cleanup: notes, fixtures, results };
  fs.writeFileSync(path.join(OUT, 'results.json'), redact(JSON.stringify(doc, null, 2)));
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    `# MCP acceptance run ${TAG}`, '',
    `- Backend: ${BASE}`, `- Started: ${doc.startedAt}`, `- Bot: ${BOT}`, `- Tests: ${SELECTED.join(', ')}`, `- **${summary}**`,
    ...(setupError ? [`- Setup failed: ${esc(setupError)}`] : []), '',
    '| Test | Verdict | Title |', '| --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.verdict} | ${esc(r.title)} |`), '',
    '| Check | Verdict | Name | Observed | ms |', '| --- | --- | --- | --- | --- |',
    ...results.flatMap((r) => r.checks.map((c) => `| ${c.id} | ${c.verdict} | ${esc(c.name)} | ${esc(c.observed)} | ${c.ms} |`)), '',
    '## Data created (for clean-up)', '', '```json', JSON.stringify(fixtures, null, 2), '```', '',
    '## Clean-up done', '', ...notes.map((n) => `- ${n}`), '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'results.md'), redact(md));
  return summary;
}

async function main() {
  console.log(`MCP acceptance run ${TAG} against ${BASE} (tests ${SELECTED.join(',')}); results in ${OUT}`);
  const results: TestResult[] = [];
  const notes: string[] = [];
  let setupError: string | null = null;
  try {
    try { await setup(); } catch (e) { setupError = errText(e); console.error(`Setup failed: ${setupError}`); }
    for (const id of SELECTED) {
      const t = new TestRun(id); const t0 = Date.now();
      console.log(`\nTest ${id}: ${TITLES[id]}`);
      if (setupError) await t.check('fixtures are in place', () => blocked(`setup failed: ${setupError}`));
      else {
        try { await TESTS[id]!(t); } catch (e) { await t.check('test ran to the end', () => pass(false, `threw: ${errText(e)}`)); }
      }
      results.push({ id, title: TITLES[id]!, verdict: t.verdict(), ms: Date.now() - t0, checks: t.checks });
      console.log(`Test ${id}: ${t.verdict()}`);
    }
  } finally {
    await fx.bot?.close();
    await cleanup(notes).catch((e) => notes.push(`clean-up failed: ${errText(e)}`));
    const summary = writeResults(results, notes, setupError);
    console.log(`\n${notes.map((n) => `  ${n}`).join('\n')}\n\n${summary}\nResults: ${path.join(OUT, 'results.md')}`);
  }
  process.exit(results.some((r) => r.verdict === 'FAIL') || setupError ? 1 : 0);
}

main().catch((e) => { console.error(errText(e)); process.exit(1); });
