import 'dotenv/config';
import { listSources, runApiRequest } from '../src/integrations/catchr/catchr-client.js';
import { FIELD_MAP } from '../src/integrations/catchr/field-map.js';

// One-shot probe: does the current `tik-tok` field-map produce a successful
// /run_api_request_json with at least one row of spend data?
//
// Background: 2026-05-03 we saw FIELD_NOT_KNOW errors because TikTok uses
// `campaign/*` and `advertiser/*` namespaced field IDs (not flat
// account_name / campaign_name). Field-map.ts was updated 2026-05-17 to
// use the namespaced names. This script confirms the fix actually works.

const PLATFORM = 'tik-tok';
const map = FIELD_MAP[PLATFORM];
if (!map) {
  console.error(`No field map for ${PLATFORM}`);
  process.exit(1);
}

console.log('─── TikTok Catchr probe ───');
console.log('Current field map:', map);
console.log('');

// Step 1 — find a TikTok account to query.
console.log('Step 1: listSources(tik-tok) — find a connected account');
const sources = await listSources({ platform: PLATFORM, includeAvailableAccounts: true });
const flat = sources.sources as unknown as Array<Record<string, unknown>>;
console.log(`  returned ${flat.length} source rows`);

// Walk into the nested 'accounts' / 'availableAccounts' arrays to find one
// we can probe. Source shape varies per platform — try several keys.
type Account = { id: string; authorization_id?: number | string; name?: string };
const accounts: Account[] = [];
for (const s of flat) {
  for (const key of ['accounts', 'availableAccounts', 'available_accounts', 'connectedAccounts'] as const) {
    const arr = s[key];
    if (Array.isArray(arr)) {
      for (const a of arr as Array<Record<string, unknown>>) {
        const id = a.id ?? a.account_id ?? a.accountId;
        const authId = a.authorization_id ?? a.authorizationId ?? s.authorization_id ?? s.authorizationId;
        if (typeof id === 'string' && id && authId) {
          accounts.push({ id, authorization_id: authId as number | string, name: a.name as string | undefined });
        }
      }
    }
  }
  // Some shapes put the account at the source root.
  const rootId = s.id ?? s.account_id;
  const rootAuth = s.authorization_id ?? s.authorizationId;
  if (typeof rootId === 'string' && rootAuth && !accounts.find((x) => x.id === rootId)) {
    accounts.push({ id: rootId, authorization_id: rootAuth as number | string, name: s.name as string | undefined });
  }
}
console.log(`  parsed ${accounts.length} account candidates`);
if (accounts.length === 0) {
  console.error('  ✗ No TikTok accounts found. Possible: (a) no TikTok auth in Catchr, (b) source shape changed.');
  console.log('  Raw source rows:');
  console.log(JSON.stringify(flat.slice(0, 3), null, 2));
  process.exit(1);
}

console.log(`  Probing all ${accounts.length} TikTok accounts over LAST_90_DAYS`);
console.log('');

// Step 2 — try a real spend query for each account, last 90 days.
console.log('Step 2: runApiRequest with current field-map per account');
const today = new Date();
const start = new Date(today);
start.setDate(start.getDate() - 90);
const iso = (d: Date) => d.toISOString().split('T')[0];

let totalRows = 0;
let totalSpend = 0;
const summary: Array<{ account: string; rows: number; spend: number; error?: string }> = [];

for (const acct of accounts) {
  try {
    const res = await runApiRequest({
      platform: PLATFORM,
      accounts: [{ id: acct.id, authorization_id: acct.authorization_id! }],
      date: 'CUSTOM',
      start_date: iso(start),
      end_date: iso(today),
      dimensions: [map.date, map.campaignId, map.campaignName, map.accountName, map.accountCurrency],
      metrics: [map.spend],
    });
    const rows = ((res as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const spend = rows.reduce((acc, r) => acc + Number(r[map.spend] ?? 0), 0);
    summary.push({ account: acct.name ?? acct.id, rows: rows.length, spend });
    totalRows += rows.length;
    totalSpend += spend;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    summary.push({ account: acct.name ?? acct.id, rows: 0, spend: 0, error: msg });
  }
}

console.log('');
console.log('─── Per-account TikTok results (last 90d) ─────');
for (const s of summary) {
  const status = s.error ? `✗ ${s.error}` : `${s.rows} rows · £${s.spend.toFixed(2)}`;
  console.log(`  ${s.account.padEnd(40)} ${status}`);
}
console.log('');
console.log(`Total: ${totalRows} rows · £${totalSpend.toFixed(2)} across ${accounts.length} accounts`);
console.log('');
if (summary.some((s) => s.error)) {
  console.log('─── RESULT: some accounts FAILED — see errors above');
  process.exit(2);
}
if (totalRows === 0) {
  console.log('─── RESULT: field map works (no errors) but every TikTok account has £0 spend in last 90d');
  process.exit(0);
}
console.log('─── RESULT: TikTok field map WORKING — spend data flows ─────');
process.exit(0);
