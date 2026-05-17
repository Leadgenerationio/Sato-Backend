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
  // Confirmed 2026-05-17 via list_fields_by_platform.
  // `TimePeriod` (TEXT) is incompatible with Microsoft Advertising's Summary
  // report aggregation; `Daily` (YEAR_MONTH_DAY) is the proper daily-date
  // dimension and switches Catchr to the Daily aggregation under the hood.
  'bing-ads': {
    spend: 'Spend',
    campaignId: 'CampaignId',
    campaignName: 'CampaignName',
    accountName: 'AccountName',
    accountCurrency: 'CurrencyCode',
    date: 'Daily',
  },
  // Confirmed 2026-05-17 via list_fields_by_platform. The 2026-05-03
  // FIELD_NOT_KNOW errors were because `account_name` / `account_currency`
  // / `campaign_name` don't exist on TikTok — the platform uses
  // `advertiser/*` and `campaign/*` namespaces, and `stat_time_day` is
  // deprecated in favour of the Catchr-normalized date field.
  'tik-tok': {
    spend: 'spend',
    campaignId: 'campaign/campaign_id',
    campaignName: 'campaign/campaign_name',
    accountName: 'advertiser/name',
    accountCurrency: 'advertiser/currency',
    date: '_NORMALIZED_DATE_FIELD_YEAR_MONTH_DAY',
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
