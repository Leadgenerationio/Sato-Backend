import 'dotenv/config';
import { isXeroConfigured, getValidToken } from '../src/integrations/xero/xero-client.js';

async function main() {
  console.log('─── Xero Custom Connection live test ───');
  console.log('Configured:', isXeroConfigured());
  console.log('Client ID:', process.env.XERO_CLIENT_ID ? '***set***' : '(missing)');
  console.log('Client Secret:', process.env.XERO_CLIENT_SECRET ? '***set***' : '(missing)');
  console.log();

  if (!isXeroConfigured()) {
    console.error('✗ XERO_CLIENT_ID / XERO_CLIENT_SECRET missing — cannot proceed.');
    process.exit(1);
  }

  console.log('─── Authenticating ───');
  const started = Date.now();
  const { accessToken, tenantId } = await getValidToken();
  console.log(`✓ Token obtained in ${Date.now() - started}ms`);
  console.log('Tenant ID:', tenantId);
  console.log();

  console.log('─── Fetching /connections to verify tenant ───');
  const connRes = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const connections = await connRes.json();
  console.log(JSON.stringify(connections, null, 2));
  console.log();

  console.log('─── GET /Contacts (first 3) ───');
  const contactsRes = await fetch('https://api.xero.com/api.xro/2.0/Contacts?page=1&PageSize=3', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
    },
  });

  if (!contactsRes.ok) {
    console.error('✗ Contacts call failed:', contactsRes.status, await contactsRes.text());
    process.exit(1);
  }

  const data = (await contactsRes.json()) as { Contacts?: Array<{ Name: string; ContactID: string }> };
  const contacts = data.Contacts ?? [];
  console.log(`Got ${contacts.length} contacts:`);
  for (const c of contacts.slice(0, 3)) {
    console.log(`  - ${c.Name} (${c.ContactID})`);
  }
  console.log();
  console.log('✓ Xero Custom Connection is live.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Xero test failed:', err?.message ?? err);
  process.exit(1);
});
