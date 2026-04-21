import type { CatchrPlatform } from './catchr-types.js';

/**
 * Per-platform Catchr field IDs.
 *
 * Catchr uses different field_id conventions per source. Facebook/Bing use
 * snake_case; Google uses PascalCase; TikTok/Taboola snake_case. The concrete
 * field IDs are discovered by calling `list_fields_by_platform` at dev time.
 *
 * Only `google-ads` and `facebook-ads` are confirmed — the other three are
 * best-effort defaults that the sync validates on first run and logs if wrong.
 */
export interface PlatformFieldMap {
  /** Metric: daily spend / cost. */
  spend: string;
  /** Dimensions we always request for per-day-per-campaign bucketing. */
  campaignId: string;
  campaignName: string;
  accountName: string;
  accountCurrency: string;
  /** Per-day dimension so we can bucket rows by date. */
  date: string;
}

export const FIELD_MAP: Record<CatchrPlatform, PlatformFieldMap | null> = {
  // Confirmed 2026-04-20 via list_fields_by_platform
  'facebook-ads': {
    spend: 'spend',
    campaignId: 'campaign_id',
    campaignName: 'campaign_name',
    accountName: 'account_name',
    accountCurrency: 'account_currency',
    date: 'date_start',
  },
  // Confirmed 2026-04-20 via list_fields_by_platform
  'google-ads': {
    spend: 'Cost',
    campaignId: 'CampaignId',
    campaignName: 'CampaignName',
    accountName: 'AccountDescriptiveName',
    accountCurrency: 'AccountCurrencyCode',
    date: 'Date',
  },
  // Best-effort defaults — verify with list_fields_by_platform and update
  'bing-ads': {
    spend: 'Spend',
    campaignId: 'CampaignId',
    campaignName: 'CampaignName',
    accountName: 'AccountName',
    accountCurrency: 'CurrencyCode',
    date: 'TimePeriod',
  },
  'tik-tok': {
    spend: 'spend',
    campaignId: 'campaign_id',
    campaignName: 'campaign_name',
    accountName: 'advertiser_name',
    accountCurrency: 'currency',
    date: 'stat_time_day',
  },
  'taboola': {
    spend: 'spend',
    campaignId: 'campaign_id',
    campaignName: 'campaign_name',
    accountName: 'account_name',
    accountCurrency: 'currency',
    date: 'date',
  },
};

export function fieldMapFor(platform: string): PlatformFieldMap | null {
  return FIELD_MAP[platform as CatchrPlatform] ?? null;
}
