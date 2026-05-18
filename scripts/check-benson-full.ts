import { db } from '../src/config/database.js';
import { users } from '../src/db/schema/users.js';
import { clientCampaigns } from '../src/db/schema/client-campaigns.js';
import { campaigns } from '../src/db/schema/campaigns.js';
import { eq } from 'drizzle-orm';

const BENSON_ID = '997f415b-a378-4ccb-ab14-9fb05a1a5769';

console.log('=== Portal users for Benson ===');
const usrs = await db.select().from(users).where(eq(users.clientId, BENSON_ID));
console.log(usrs.length === 0 ? 'NONE — needs creation' : usrs.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role })));

console.log('\n=== client_campaigns links for Benson ===');
const links = await db
  .select({ id: clientCampaigns.id, campId: clientCampaigns.campaignId, name: campaigns.name, lbId: campaigns.leadbyteCampaignId })
  .from(clientCampaigns)
  .innerJoin(campaigns, eq(campaigns.id, clientCampaigns.campaignId))
  .where(eq(clientCampaigns.clientId, BENSON_ID));
console.log(links.length === 0 ? 'NONE — Benson not linked to any campaign yet' : links);

process.exit(0);
