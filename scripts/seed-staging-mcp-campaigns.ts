/**
 * @runs-in-image (run inside the production container: only files the Dockerfile copies may be imported; see src/__tests__/scripts-in-image.test.ts)
 * Staging only: give the "MCP TEST - DO NOT BILL" client two test campaigns,
 * because LeadByte is in mock mode on staging and list_campaigns would be empty.
 *
 * Usage (inside the staging container, or locally against a test database):
 *   npx tsx scripts/seed-staging-mcp-campaigns.ts --confirm-staging --host=<database host>
 *
 * Safe to repeat: campaigns are keyed on their LeadByte number (MCPTEST-1,
 * MCPTEST-2) and the client link on (client, campaign). Changes nothing else.
 * It refuses to run unless --host names the host this DATABASE_URL really points
 * at (so a production URL cannot be used by mistake: you have to type its host
 * on purpose), and when the client does not exist. Never prints the connection string.
 *
 * Add --dummy-client to test before Sam has created his client: it creates (once) a client named
 * "Yash MCP TEST (dummy) - DO NOT BILL" in the first business and seeds the campaigns on that one.
 * Sam's real client is never created or touched by this flag.
 */

import 'dotenv/config';
import postgres from 'postgres';

const CLIENT_NAME = 'MCP TEST - DO NOT BILL';
const DUMMY_CLIENT_NAME = 'Yash MCP TEST (dummy) - DO NOT BILL';
const CAMPAIGNS = [
  { leadbyteId: 'MCPTEST-1', name: 'MCP TEST - Solar', vertical: 'Solar' },
  { leadbyteId: 'MCPTEST-2', name: 'MCP TEST - Boilers', vertical: 'Boilers' },
];

async function main() {
  if (!process.argv.includes('--confirm-staging')) {
    console.error('Refusing to run: pass --confirm-staging to say this database is staging, not production.');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  const host = new URL(url).hostname;
  const given = process.argv.find((a) => a.startsWith('--host='))?.slice('--host='.length);
  if (given !== host) {
    console.error(`Refusing to run: pass --host=<the database host>. This DATABASE_URL points at "${host}"; check it is the staging database, then type that host.`);
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  try {
    const dummy = process.argv.includes('--dummy-client');
    const name = dummy ? DUMMY_CLIENT_NAME : CLIENT_NAME;
    let [client] = await sql<{ id: string }[]>`select id from clients where company_name = ${name} limit 1`;
    if (!client && dummy) {
      const [biz] = await sql<{ id: string }[]>`select id from businesses order by created_at limit 1`;
      if (!biz) { console.error('No business exists to attach the dummy client to.'); process.exit(2); }
      [client] = await sql<{ id: string }[]>`
        insert into clients (business_id, company_name, status) values (${biz.id}, ${name}, 'active') returning id`;
      console.log(`created client "${name}"`);
    }
    if (!client) {
      console.error(`No client named "${CLIENT_NAME}" yet. Create it in the portal first (or pass --dummy-client to test with a dummy one), then run this again.`);
      process.exit(2);
    }
    for (const c of CAMPAIGNS) {
      const [existing] = await sql<{ id: string }[]>`select id from campaigns where leadbyte_campaign_id = ${c.leadbyteId} limit 1`;
      const id = existing?.id ?? (await sql<{ id: string }[]>`
        insert into campaigns (leadbyte_campaign_id, name, vertical, status)
        values (${c.leadbyteId}, ${c.name}, ${c.vertical}, 'active') returning id`)[0]!.id;
      await sql`insert into client_campaigns (client_id, campaign_id) values (${client.id}, ${id}) on conflict do nothing`;
      console.log(`${existing ? 'kept   ' : 'created'} ${c.leadbyteId} ${c.name}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
