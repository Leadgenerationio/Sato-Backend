import 'dotenv/config';
import {
  isLeadByteConfigured,
  getCampaigns,
  getCampaignReport,
  getSupplierSpend,
} from '../src/integrations/leadbyte/leadbyte-client.js';

async function main() {
  console.log('─── LeadByte live test ───');
  console.log('Configured:', isLeadByteConfigured());
  console.log('Base URL:', process.env.LEADBYTE_BASE_URL || '(default)');
  console.log('API key:', process.env.LEADBYTE_API_KEY ? '***set***' : '(missing)');
  console.log();

  if (!isLeadByteConfigured()) {
    console.error('✗ LEADBYTE_API_KEY missing — cannot proceed.');
    process.exit(1);
  }

  console.log('─── GET /campaigns ───');
  const t0 = Date.now();
  const campaigns = await getCampaigns();
  console.log(`✓ Got ${campaigns.length} campaign(s) in ${Date.now() - t0}ms`);
  for (const c of campaigns.slice(0, 5)) {
    console.log(`  - ${c.id} | ${c.name} | status=${c.status} | currency=${c.currency}`);
  }
  console.log();

  console.log('─── getCampaignReport(last_month) — normalised ───');
  const t1 = Date.now();
  const rows = await getCampaignReport('last_month');
  console.log(`✓ Got ${rows.length} row(s) in ${Date.now() - t1}ms`);
  for (const r of rows.slice(0, 5)) {
    console.log(
      `  - ${r.campaign} | leads=${r.leads} | valid=${r.valid} | revenue=${r.revenue} | currency=${r.currency}`,
    );
    console.assert(typeof r.campaign === 'string', 'campaign should be flat string');
    console.assert(/^[A-Z]{3}$/.test(r.currency), `currency should be ISO, got "${r.currency}"`);
  }
  console.log();

  console.log('─── getSupplierSpend(last_month) — normalised ───');
  const t2 = Date.now();
  const suppliers = await getSupplierSpend('last_month');
  console.log(`✓ Got ${suppliers.length} supplier row(s) in ${Date.now() - t2}ms`);
  for (const s of suppliers.slice(0, 5)) {
    console.log(`  - ${s.supplierName} | campaign=${s.campaignName} (${s.campaignId}) | spend=${s.spend} | leads=${s.leads}`);
  }
  console.log();

  console.log('✓ LeadByte integration is live.');
  process.exit(0);
}

main().catch((err) => {
  console.error('LeadByte test failed:', err?.message ?? err);
  process.exit(1);
});
