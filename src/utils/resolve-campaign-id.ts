import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { campaigns as campaignsTable } from '../db/schema/campaigns.js';
import { isUuid } from './zod-helpers.js';

/**
 * The Campaigns UI lists/details key campaigns by LeadByte's numeric id
 * (e.g. "38" for INSULATION), but Sato's own `campaigns` row uses a uuid
 * primary key. Sub-resource endpoints (traffic-sources, creatives) need
 * the uuid for FK joins, so resolve the input to a uuid here before
 * touching the DB.
 *
 * Returns null when neither lookup hits — caller treats that as a 404.
 */
export async function resolveSatoCampaignId(idOrLeadbyteId: string): Promise<string | null> {
  if (isUuid(idOrLeadbyteId)) return idOrLeadbyteId;
  const [row] = await db
    .select({ id: campaignsTable.id })
    .from(campaignsTable)
    .where(eq(campaignsTable.leadbyteCampaignId, idOrLeadbyteId));
  return row?.id ?? null;
}
