import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '../src/config/database.js';

// Cross-checks Stato DB aggregates against the three upstream sources.
// Output is a single side-by-side report Sam can read in a meeting.

const fmtMoney = (n: number) => '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
const fmtInt = (n: number) => n.toLocaleString('en-GB');

console.log('─── Stato platform-data validation ───');
console.log('Generated:', new Date().toISOString());
console.log('');

// ── 1. ad_spend (vs Catchr) ─────────────────────────────────────────
console.log('━━━ CATCHR (ad_spend table) ━━━');
const adSpendByPlatform = await db.execute(sql`
  select platform,
         count(*) as rows,
         count(distinct account_id) as accounts,
         min(date) as earliest,
         max(date) as latest,
         round(coalesce(sum(spend::numeric), 0)::numeric, 2) as lifetime_spend
    from ad_spend
   group by platform
   order by lifetime_spend desc;
`);
console.table(adSpendByPlatform.map((r: Record<string, unknown>) => ({
  platform: r.platform,
  rows: r.rows,
  accounts: r.accounts,
  earliest: r.earliest,
  latest: r.latest,
  lifetime: fmtMoney(Number(r.lifetime_spend)),
})));

const adSpendWindow = await db.execute(sql`
  select
    coalesce(sum(case when date >= current_date - interval '7 days' then spend::numeric end), 0) as last_7d,
    coalesce(sum(case when date >= current_date - interval '30 days' then spend::numeric end), 0) as last_30d,
    coalesce(sum(case when date >= current_date - interval '90 days' then spend::numeric end), 0) as last_90d,
    coalesce(sum(spend::numeric), 0) as lifetime
   from ad_spend;
`);
const w = adSpendWindow[0] as Record<string, string>;
console.log('Windowed sums:');
console.log('  Last 7d:   ', fmtMoney(Number(w.last_7d)));
console.log('  Last 30d:  ', fmtMoney(Number(w.last_30d)));
console.log('  Last 90d:  ', fmtMoney(Number(w.last_90d)));
console.log('  Lifetime:  ', fmtMoney(Number(w.lifetime)));
console.log('');

// ── 2. lead_deliveries (vs LeadByte) ─────────────────────────────────
console.log('━━━ LEADBYTE (lead_deliveries table) ━━━');
const ld = await db.execute(sql`
  select
    count(*) as rows,
    count(distinct campaign_id) as campaigns,
    count(distinct client_id) as clients,
    min(delivery_date) as earliest,
    max(delivery_date) as latest,
    coalesce(sum(lead_count), 0) as total_leads,
    coalesce(sum(revenue::numeric), 0) as total_revenue,
    count(*) filter (where revenue is null) as null_revenue_rows
   from lead_deliveries;
`);
const l = ld[0] as Record<string, string>;
console.log('Overall:');
console.log('  Rows:          ', fmtInt(Number(l.rows)));
console.log('  Campaigns:     ', l.campaigns);
console.log('  Clients:       ', l.clients);
console.log('  Earliest:      ', l.earliest);
console.log('  Latest:        ', l.latest);
console.log('  Total leads:   ', fmtInt(Number(l.total_leads)));
console.log('  Total revenue: ', fmtMoney(Number(l.total_revenue)));
console.log('  NULL-revenue:  ', l.null_revenue_rows, '(was 4185 before the 19 May fix; should be ≪ that now)');
console.log('');

const ldWindow = await db.execute(sql`
  select
    coalesce(sum(case when delivery_date >= current_date - interval '7 days' then lead_count end), 0) as leads_7d,
    coalesce(sum(case when delivery_date >= date_trunc('month', current_date) then lead_count end), 0) as leads_this_month,
    coalesce(sum(case when delivery_date >= date_trunc('month', current_date) - interval '1 month'
                   and delivery_date <  date_trunc('month', current_date) then lead_count end), 0) as leads_last_month,
    coalesce(sum(case when delivery_date >= current_date - interval '90 days' then lead_count end), 0) as leads_90d
   from lead_deliveries;
`);
const lw = ldWindow[0] as Record<string, string>;
console.log('Lead windows:');
console.log('  Last 7d:       ', fmtInt(Number(lw.leads_7d)));
console.log('  This month:    ', fmtInt(Number(lw.leads_this_month)));
console.log('  Last month:    ', fmtInt(Number(lw.leads_last_month)));
console.log('  Last 90d:      ', fmtInt(Number(lw.leads_90d)));
console.log('');

// ── 3. Top campaigns (last 30 days) ──────────────────────────────────
console.log('Top 8 campaigns by leads (last 30 days):');
const topCamp = await db.execute(sql`
  select c.name,
         c.leadbyte_campaign_id as lb_id,
         coalesce(sum(ld.lead_count), 0) as leads_30d,
         coalesce(sum(ld.revenue::numeric), 0) as revenue_30d
    from campaigns c
    left join lead_deliveries ld
      on ld.campaign_id = c.id
     and ld.delivery_date >= current_date - interval '30 days'
   group by c.id, c.name, c.leadbyte_campaign_id
  having coalesce(sum(ld.lead_count), 0) > 0
   order by leads_30d desc
   limit 8;
`);
console.table(topCamp.map((r: Record<string, unknown>) => ({
  name: r.name,
  lb_id: r.lb_id,
  leads_30d: fmtInt(Number(r.leads_30d)),
  revenue_30d: fmtMoney(Number(r.revenue_30d)),
})));

// ── 4. Invoices (vs Xero) ────────────────────────────────────────────
console.log('━━━ XERO (invoices table) ━━━');
const inv = await db.execute(sql`
  select status,
         count(*) as rows,
         coalesce(sum(total::numeric), 0) as total
    from invoices
   group by status
   order by total desc;
`);
console.table(inv.map((r: Record<string, unknown>) => ({
  status: r.status,
  count: r.rows,
  total: fmtMoney(Number(r.total)),
})));

const paidTotal = await db.execute(sql`
  select coalesce(sum(total::numeric), 0) as paid_lifetime
    from invoices where status = 'paid';
`);
console.log('Lifetime paid sum: ', fmtMoney(Number((paidTotal[0] as Record<string, string>).paid_lifetime)));
console.log('  (Should match Xero Income report)');
console.log('');

// ── 5. Clients overview ──────────────────────────────────────────────
console.log('━━━ CLIENTS ━━━');
const clients = await db.execute(sql`
  select status, count(*) as rows
    from clients
   group by status;
`);
console.table(clients);

const linkedClients = await db.execute(sql`
  select count(distinct client_id) as linked_clients,
         count(*) as junction_rows
    from client_campaigns;
`);
console.log('client_campaigns junction:', linkedClients[0]);
console.log('');

// ── 6. Traffic source linkage ────────────────────────────────────────
console.log('━━━ TRAFFIC SOURCES ━━━');
const ts = await db.execute(sql`
  select c.name as campaign,
         ts.platform,
         ts.account_id as legacy_account,
         jsonb_array_length(coalesce(ts.account_ids, '[]'::jsonb)) as multi_count
    from traffic_sources ts
    join campaigns c on c.id = ts.campaign_id
   order by c.name, ts.platform;
`);
console.table(ts);

console.log('');
console.log('─── Validation complete ───');
process.exit(0);
