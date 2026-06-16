import { describe, it, expect } from 'vitest';
import { canonicalizePlatform } from '../utils/catchr-platform.js';
import { supplierNameToCatchrPlatform } from '../services/report.service.js';

// Parity guard: `supplierNameToCatchrPlatform` (the LeadByte-supplier → Catchr
// platform mapping used for lead attribution) must agree with
// `canonicalizePlatform` (the single source of truth, also mirrored in the SQL
// join `canonicalPlatformSql`) across the prod platform vocabulary. They had
// drifted before — e.g. an exact-"bing" check dropped "Bing Search", so such a
// supplier's spend was bucketed by the SQL path but attributed 0 leads here.
describe('supplierNameToCatchrPlatform ↔ canonicalizePlatform parity', () => {
  // Prod supplier-name vocabulary observed in traffic_sources / LeadByte,
  // plus the "Bing Search" drift case this fix closed.
  const cases: Array<[string, ReturnType<typeof canonicalizePlatform>]> = [
    ['facebook', 'facebook-ads'],
    ['Facebook Ads', 'facebook-ads'],
    ['Meta', 'facebook-ads'],
    ['google', 'google-ads'],
    ['Google Ads', 'google-ads'],
    ['TikTok', 'tik-tok'],
    ['Taboola', 'taboola'],
    ['bing', 'bing-ads'],
    ['Bing Search', 'bing-ads'], // the drift this fix closed
    ['Microsoft Advertising', 'bing-ads'],
    ['Direct', null], // unmapped → no canonical platform
    ['Outbrain', null], // Catchr-supported but unwired
  ];

  it.each(cases)('maps %j → %j and matches canonicalizePlatform', (supplierName, expected) => {
    expect(supplierNameToCatchrPlatform(supplierName)).toBe(expected);
    expect(supplierNameToCatchrPlatform(supplierName)).toBe(canonicalizePlatform(supplierName));
  });
});
