import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import type { LeadByteSupplier } from '../integrations/leadbyte/leadbyte-types.js';
import { cached } from '../utils/cache.js';

const PER_CAMPAIGN_TTL = 300; // 5 min

/**
 * LeadByte's last-30-days supplier report for one campaign (leads, payout
 * and buyer revenue per supplier). Shared by campaign detail (Supplier CPL
 * Comparison) and the Ad Account Links card so both read the same cached
 * rows. v2: rows now carry `revenue` (Sam S11) — the v1 cache entries
 * didn't, so the key moves rather than serving stale-shaped rows.
 */
export function getCampaignSuppliers(lbCampaignId: string): Promise<LeadByteSupplier[]> {
  return cached(`lb:suppliers:${lbCampaignId}:30d:v2`, PER_CAMPAIGN_TTL, () => leadbyte.getSuppliers(lbCampaignId));
}
