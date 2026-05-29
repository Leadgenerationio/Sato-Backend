import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the redis module to a fake whose `set` resolves immediately. The
// real ioredis client would hang waiting for a connection in test env
// (Redis not running), causing the 5s vitest timeout we hit on first run.
vi.mock('../config/redis.js', () => ({
  redis: {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    status: 'ready',
  },
}));

import * as leadbyte from '../integrations/leadbyte/leadbyte-client.js';
import * as integrationCtrl from '../controllers/integration.controller.js';
import { prewarmLeadByteCache } from '../services/cache-prewarm.service.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';

// The prewarmer is what keeps the LeadByte dashboard fast — every 90s the
// BullMQ worker calls this and writes 7 windows × {report, supplier-spend}
// + buyers + deliveries to Redis. These tests assert the prewarmer covers
// every window the dashboard exposes (the original bug: only 4 of 7
// windows were prewarmed, so Yesterday / Last week / Last month always
// took 20-30s on first hit).

const ALL_WINDOWS: DeliveryWindow[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'ytd',
];

describe('prewarmLeadByteCache', () => {
  beforeEach(() => {
    process.env.LEADBYTE_API_KEY = 'prewarm-test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LEADBYTE_API_KEY;
  });

  it('fetches /reports/campaign for all 7 windows the dashboard exposes', async () => {
    const reportSpy = vi.spyOn(leadbyte, 'getCampaignReport').mockResolvedValue([
      { campaign: 'X', leads: 1, valid: 1, invalid: 0, pending: 0, rejections: 0, payable: 1, sold: 1, returns: 0, payout: 0, revenue: 0, profit: 0, currency: 'GBP' },
    ]);
    vi.spyOn(leadbyte, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getSupplierSpend').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getBuyers').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getDeliveries').mockResolvedValue([]);

    await prewarmLeadByteCache();

    const calledWindows = reportSpy.mock.calls.map((args) => args[0]);
    for (const w of ALL_WINDOWS) {
      expect(calledWindows).toContain(w);
    }
  });

  it('also prewarms supplier-spend for all 7 windows', async () => {
    vi.spyOn(leadbyte, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getCampaignReport').mockResolvedValue([]);
    const spendSpy = vi.spyOn(leadbyte, 'getSupplierSpend').mockResolvedValue([
      { supplierId: 's', supplierName: 'M', platform: 'M', campaignId: 'c', campaignName: 'C', window: 'today', spend: 1, leads: 1, validLeads: 1, cpl: 1 },
    ]);
    vi.spyOn(leadbyte, 'getBuyers').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getDeliveries').mockResolvedValue([]);

    await prewarmLeadByteCache();

    const calledWindows = spendSpy.mock.calls.map((args) => args[0]);
    for (const w of ALL_WINDOWS) {
      expect(calledWindows).toContain(w);
    }
  });

  it('prewarms buyers and deliveries listings', async () => {
    vi.spyOn(leadbyte, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getCampaignReport').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getSupplierSpend').mockResolvedValue([]);
    const buyersSpy = vi.spyOn(leadbyte, 'getBuyers').mockResolvedValue([{ company: 'Acme' }]);
    const deliveriesSpy = vi.spyOn(leadbyte, 'getDeliveries').mockResolvedValue([{ id: 'd' }]);

    await prewarmLeadByteCache();

    expect(buyersSpy).toHaveBeenCalled();
    expect(deliveriesSpy).toHaveBeenCalled();
  });

  it('records a successful sync timestamp so Settings tile reflects fresh data', async () => {
    vi.spyOn(leadbyte, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getCampaignReport').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getSupplierSpend').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getBuyers').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getDeliveries').mockResolvedValue([]);
    const recordSpy = vi.spyOn(integrationCtrl, 'recordLeadByteSync');

    await prewarmLeadByteCache();

    expect(recordSpy).toHaveBeenCalled();
    const ts = recordSpy.mock.calls[0]?.[0];
    expect(typeof ts).toBe('string');
    expect(new Date(ts!).toString()).not.toBe('Invalid Date');
  });

  it('returns the new shape with all counters', async () => {
    vi.spyOn(leadbyte, 'getCampaigns').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getCampaignReport').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getSupplierSpend').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getBuyers').mockResolvedValue([]);
    vi.spyOn(leadbyte, 'getDeliveries').mockResolvedValue([]);

    const result = await prewarmLeadByteCache();

    expect(result).toHaveProperty('campaignsCached');
    expect(result).toHaveProperty('reportsCached');
    expect(result).toHaveProperty('supplierSpendCached');
    expect(result).toHaveProperty('buyersCached');
    expect(result).toHaveProperty('deliveriesCached');
    expect(result).toHaveProperty('durationMs');
  });
});
