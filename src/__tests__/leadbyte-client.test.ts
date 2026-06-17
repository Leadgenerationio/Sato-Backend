import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as lb from '../integrations/leadbyte/leadbyte-client.js';

const ORIGINAL_FETCH = global.fetch;

function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('LeadByte client — configuration', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.LEADBYTE_API_KEY;
    delete process.env.LEADBYTE_BASE_URL;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports not configured when LEADBYTE_API_KEY is missing', () => {
    expect(lb.isLeadByteConfigured()).toBe(false);
  });

  it('reports configured when key is set', () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    expect(lb.isLeadByteConfigured()).toBe(true);
  });

  // Per the no-fake-data policy, unconfigured fallbacks return empty arrays
  // (UI shows "No data available") rather than fabricating campaigns/leads.
  it('getCampaigns returns empty array when LEADBYTE_API_KEY is not set', async () => {
    const campaigns = await lb.getCampaigns();
    expect(campaigns).toEqual([]);
  });

  it('getDeliveryReports returns empty array when unconfigured', async () => {
    const reports = await lb.getDeliveryReports('lb-1', 7);
    expect(reports).toEqual([]);
  });

  it('throws when write endpoints are called without configuration', async () => {
    await expect(lb.submitLead({ email: 'x@y' })).rejects.toThrow(/not configured/);
    await expect(lb.returnLead({ leadId: 1, BID: 'B1', reason: 'X' })).rejects.toThrow(/not configured/);
    await expect(lb.addCredit({ BID: 'B1', amount: 10 })).rejects.toThrow(/not configured/);
    await expect(lb.createBuyer({ company: 'X' })).rejects.toThrow(/not configured/);
    await expect(lb.processQuarantine({ quarantineId: 1, action: 'process' })).rejects.toThrow(/not configured/);
  });
});

describe('LeadByte client — date window translation', () => {
  it('maps DeliveryWindow values to LeadByte presets', () => {
    expect(lb.windowToPreset('today')).toBe('today');
    expect(lb.windowToPreset('last_week')).toBe('lastweek');
    // ytd maps to LeadByte's real year-to-date preset, `this_year`.
    expect(lb.windowToPreset('ytd')).toBe('this_year');
  });

  it('returns an ISO range for ytd covering roughly the current year', () => {
    const { from, to } = lb.windowToRange('ytd');
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(to).getTime()).toBeGreaterThan(new Date(from).getTime());
  });

  it('returns a valid ISO range for yesterday (approximately 1 day span)', () => {
    const { from, to } = lb.windowToRange('yesterday');
    const spanMs = new Date(to).getTime() - new Date(from).getTime();
    expect(spanMs).toBeLessThan(2 * 24 * 3600 * 1000);
    expect(spanMs).toBeGreaterThan(0);
  });

  // 2026-06-17: ytd now resolves to LeadByte's `this_year` preset, so the query
  // path emits a datePreset (not an explicit from/to range) — the same as every
  // other window. This is what makes the supplier/campaign reports return real
  // per-source YTD data instead of spend-only-zero-leads.
  it('uses LeadByte\'s this_year preset for ytd on the query path', () => {
    expect(lb.windowToQuery('ytd')).toEqual({ datePreset: 'this_year' });
  });

  it('uses datePreset (not from/to) for windows LeadByte supports', () => {
    expect(lb.windowToQuery('today')).toEqual({ datePreset: 'today' });
    expect(lb.windowToQuery('last_week')).toEqual({ datePreset: 'lastweek' });
  });
});

describe('LeadByte client — API calls (fetch mocked)', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...originalEnv };
  });

  // ── Campaigns ────────────────────────────────────────────────────────────
  it('getCampaignById calls GET /campaigns/{id} with key query param', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: 1, name: 'X', fields: [] }));
    await lb.getCampaignById(42);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/campaigns/42');
    expect(url).toContain('key=test-key');
  });

  // ── Leads ────────────────────────────────────────────────────────────────
  it('submitLeads posts an array under leads with X_KEY header', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.submitLeads([{ email: 'a@b' }, { email: 'c@d' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/restapi/v1.3/leads');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X_KEY']).toBe('test-key');
    expect(JSON.parse(init.body as string)).toEqual({ leads: [{ email: 'a@b' }, { email: 'c@d' }] });
  });

  it('getLeadById hits GET /leads/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: '7' }));
    await lb.getLeadById('7');
    expect(fetchMock.mock.calls[0][0]).toContain('/leads/7');
  });

  it('getLeadsBatch issues a GET with a body containing leadIds + key', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse([]));
    await lb.getLeadsBatch(['a', 'b', 'c']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/restapi/v1.3/leads');
    expect(init.method).toBe('GET');
    const body = JSON.parse(init.body as string);
    expect(body.key).toBe('test-key');
    expect(body.leadIds).toEqual(['a', 'b', 'c']);
  });

  it('updateLeads sends PUT /leads with leads array', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.updateLeads([{ id: 1, action: 'reprocess' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/leads');
    expect(JSON.parse(init.body as string)).toEqual({ leads: [{ id: 1, action: 'reprocess' }] });
  });

  it('searchLeads posts /leads/search with key in body', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ results: [] }));
    await lb.searchLeads({ searches: [{ campaignId: 1, email: 'x@y.com' }] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.key).toBe('test-key');
    expect(body.searches).toHaveLength(1);
  });

  it('addLeadFeedback sends PUT /leads/feedback with BID and feedback code', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.addLeadFeedback({ leads: [1], BID: 'B33', feedback: 'BAD_PHONE' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(url).toContain('/leads/feedback');
    const body = JSON.parse(init.body as string);
    expect(body.BID).toBe('B33');
    expect(body.feedback).toBe('BAD_PHONE');
  });

  it('addLeadInternalFeedback sends PUT /leads/internalfeedback', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.addLeadInternalFeedback({ leads: [1], feedback: 'INTERNAL_NOTE' });
    expect(fetchMock.mock.calls[0][0]).toContain('/leads/internalfeedback');
  });

  it('reprocessLeads sends POST /leads/reprocess', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.reprocessLeads({ leadIds: [1, 2] });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][0]).toContain('/leads/reprocess');
  });

  it('assignBuyer sends POST /leads/assignbuyer with deliveryId', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.assignBuyer({ leadId: 1, deliveryId: 99, triggerActions: 'Responders,Webhooks' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.deliveryId).toBe(99);
    expect(body.triggerActions).toBe('Responders,Webhooks');
  });

  it('pingLead sends POST /leads/ping with callback_url', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.pingLead({ lead: { email: 'x@y' }, callback_url: 'https://cb' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.callback_url).toBe('https://cb');
  });

  it('deliveryChecker posts /leads/deliverychecker with key in body', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ results: [] }));
    await lb.deliveryChecker({ lead: { email: 'x@y' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.key).toBe('test-key');
  });

  // ── Deliveries ───────────────────────────────────────────────────────────
  it('createDelivery posts /deliveries/create', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok', deliveryId: 99 }));
    await lb.createDelivery({
      campaign_code: 'CAMP-1',
      delivery_type: 'Store Lead',
      delivery_name: 'Test',
      revenue: 10,
      bid: 'B1',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/deliveries/create');
  });

  it('getDeliveries sends GET /deliveries with status filter', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse([]));
    await lb.getDeliveries({ status: 'Active' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/deliveries');
    expect(url).toContain('status=Active');
  });

  it('getDeliveryById hits /deliveries/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: 1 }));
    await lb.getDeliveryById(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/deliveries/1');
  });

  it('updateDeliveries sends PUT /deliveries with deliveries array', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.updateDeliveries([{ id: 1, update: { status: 'Active' } }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.deliveries).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
  });

  it('updateDeliveryById sends PUT /deliveries/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.updateDeliveryById(5, { status: 'Inactive' });
    expect(fetchMock.mock.calls[0][0]).toContain('/deliveries/5');
  });

  it('triggerDeliveries posts /deliveries/trigger', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ pushResults: [] }));
    await lb.triggerDeliveries({ leadId: 1, deliveryId: 2 });
    expect(fetchMock.mock.calls[0][0]).toContain('/deliveries/trigger');
  });

  // ── Responders ───────────────────────────────────────────────────────────
  it('getResponders hits /responders', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse([]));
    await lb.getResponders();
    expect(fetchMock.mock.calls[0][0]).toContain('/responders');
  });

  it('getResponderById hits /responders/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ id: 1 }));
    await lb.getResponderById(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/responders/1');
  });

  // ── API Queue ────────────────────────────────────────────────────────────
  it('getQueueItem hits /apiqueue/{queueRef}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ queueRef: 'abc', status: 'Processed' }));
    await lb.getQueueItem('abc-123');
    expect(fetchMock.mock.calls[0][0]).toContain('/apiqueue/abc-123');
  });

  it('getQueueItemsBatch issues GET /apiqueue with body', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse([]));
    await lb.getQueueItemsBatch(['a', 'b']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/restapi/v1.3/apiqueue');
    expect(init.method).toBe('GET');
    expect(JSON.parse(init.body as string).queueIds).toEqual(['a', 'b']);
  });

  // ── Lead Financials ──────────────────────────────────────────────────────
  it('updateLeadFinancials sends PUT /leadfinancials with payout/revenue', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.updateLeadFinancials({ leads: [1], newPayout: 6.5, newRevenue: 12, BID: '33' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.newPayout).toBe(6.5);
    expect(body.newRevenue).toBe(12);
    expect(body.BID).toBe('33');
  });

  // ── Reports ──────────────────────────────────────────────────────────────
  it('getEmailReport pulls /reports/email and unwraps report array', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ report: [{ campaign: 'X', sent: 10, delivered: 9, clicks: 1, conversions: 0, cost: 0, revenue: 0, profit: 0, currency: 'GBP' }] }));
    const rows = await lb.getEmailReport({ campaignId: 1, window: 'today' });
    expect(rows).toHaveLength(1);
    expect(rows[0].sent).toBe(10);
  });

  it('getSmsReport pulls /reports/sms', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ report: [] }));
    await lb.getSmsReport({ campaignId: 1, window: 'this_week' });
    expect(fetchMock.mock.calls[0][0]).toContain('/reports/sms');
  });

  it('getBulkEmailReport pulls /reports/bulkemail', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ report: [] }));
    await lb.getBulkEmailReport({ campaignId: 'all', window: 'ytd' });
    expect(fetchMock.mock.calls[0][0]).toContain('/reports/bulkemail');
  });

  it('getBulkSmsReport pulls /reports/bulksms', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ report: [] }));
    await lb.getBulkSmsReport({ campaignId: 1, window: 'last_month' });
    expect(fetchMock.mock.calls[0][0]).toContain('/reports/bulksms');
  });

  it('getBuyerReport pulls /reports/buyer', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ report: [{ campaign: 'X', buyer: 'B', posted: 10, accepted: 8, sold: 7, rejected: 1, returned: 0, revenue: 100, currency: 'GBP' }] }));
    const rows = await lb.getBuyerReport({ campaignId: 1, window: 'this_month' });
    expect(rows[0].accepted).toBe(8);
  });

  // ── Credit ───────────────────────────────────────────────────────────────
  it('addCredit posts /credit/add with BID+amount', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.addCredit({ BID: 'BUY-A', amount: 100, invoice: 'INV-1' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.BID).toBe('BUY-A');
    expect(body.amount).toBe(100);
    expect(body.invoice).toBe('INV-1');
  });

  // ── Buyers ───────────────────────────────────────────────────────────────
  it('createBuyer posts /buyers/create', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok', bid: 'B1' }));
    await lb.createBuyer({ company: 'Acme Ltd' });
    expect(fetchMock.mock.calls[0][0]).toContain('/buyers/create');
  });

  it('getBuyers hits /buyers with optional status filter', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse([]));
    await lb.getBuyers('Active');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/buyers');
    expect(url).toContain('status=Active');
  });

  it('getBuyerById hits /buyers/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ company: 'A' }));
    await lb.getBuyerById(7);
    expect(fetchMock.mock.calls[0][0]).toContain('/buyers/7');
  });

  // Sam's 30-Apr report: /leadbyte/buyers and /leadbyte/deliveries pages "did
  // not load after 1 min". Root cause: lbGet returned LeadByte's envelope
  // {status, message, buyers: [...]} but typed as LeadByteBuyer[]. FE then
  // tried to .map() over an object → page hung. unwrapList must dig into
  // the named key (or 'data', or array) and always return an array.
  it('getBuyers unwraps the LeadByte envelope into the buyers array', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        message: 'OK',
        buyers: [
          { id: '2', bid: 'THE-SOLAR-GEEKS', company: 'The Solar Geeks', status: 'Active' },
          { id: '4', bid: 'AMPLIFON-CH', company: 'Amplifon CH', status: 'Active' },
        ],
      }),
    );
    const buyers = await lb.getBuyers();
    expect(Array.isArray(buyers)).toBe(true);
    expect(buyers).toHaveLength(2);
    expect(buyers[0].company).toBe('The Solar Geeks');
  });

  it('getDeliveries unwraps the LeadByte envelope into the deliveries array', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        message: 'OK',
        deliveries: [
          { id: '4', reference: 'The Solar Geeks - All PCs', status: 'Active' },
        ],
      }),
    );
    const deliveries = await lb.getDeliveries();
    expect(Array.isArray(deliveries)).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].reference).toBe('The Solar Geeks - All PCs');
  });

  it('getResponders unwraps the LeadByte envelope into the responders array', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        message: 'OK',
        responders: [{ id: 1, name: 'Welcome Series' }],
      }),
    );
    const responders = await lb.getResponders();
    expect(Array.isArray(responders)).toBe(true);
    expect(responders).toHaveLength(1);
  });

  it('list endpoints return [] not throw when the envelope is missing the array key', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'Success', message: 'OK' }));
    expect(await lb.getBuyers()).toEqual([]);
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'Success', message: 'OK' }));
    expect(await lb.getDeliveries()).toEqual([]);
  });

  it('updateBuyers sends PUT /buyers with buyers array', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok', buyers: [] }));
    await lb.updateBuyers([{ id: 819, update: { status: 'Active', caps: { day: 3 } } }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.buyers).toHaveLength(1);
    expect(body.buyers[0].update.caps.day).toBe(3);
  });

  it('updateBuyerById sends PUT /buyers/{id}', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.updateBuyerById(819, { status: 'Inactive' });
    expect(fetchMock.mock.calls[0][0]).toContain('/buyers/819');
  });

  // ── Quarantine ───────────────────────────────────────────────────────────
  it('processQuarantine posts /quarantine/process with action', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'ok' }));
    await lb.processQuarantine({ quarantineIds: [1, 2], action: 'reject' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.action).toBe('reject');
    expect(body.quarantineIds).toEqual([1, 2]);
  });

  // ── Error handling ───────────────────────────────────────────────────────
  it('throws when the server returns non-OK', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ error: 'bad' }, false, 500));
    await expect(lb.getResponders()).rejects.toThrow(/500/);
  });

  // ── Real-API response shape ──────────────────────────────────────────────
  it('getCampaignReport unwraps the real-API `data` envelope and flattens campaign + currency', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        message: 'OK',
        data: [
          {
            campaign: { id: '85', name: 'Conservatory Upgrades', reference: 'CONSERVATORY-UPGRADE' },
            leads: 23,
            valid: 21,
            invalid: 2,
            pending: 0,
            rejections: 1,
            payable: 20,
            sold: 20,
            returns: 0,
            payout: 0,
            revenue: 105,
            profit: 105,
            currency: 'Britain (United Kingdom), Pounds',
          },
        ],
        benchmark: 0.5,
      }),
    );
    const rows = await lb.getCampaignReport('last_month');
    expect(rows).toHaveLength(1);
    expect(rows[0].campaign).toBe('Conservatory Upgrades');
    expect(rows[0].currency).toBe('GBP');
    expect(rows[0].leads).toBe(23);
    expect(rows[0].revenue).toBe(105);
    // Preserves the raw `{id}` ref so the daily lead_deliveries pro-rater
    // can match by LeadByte campaign id without relying on name equality.
    expect(rows[0].campaignId).toBe('85');
  });

  it('getCampaignReport leaves campaignId undefined when the raw ref has no id', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        data: [
          {
            campaign: 'Conservatory Upgrades',
            leads: 10,
            valid: 10,
            invalid: 0,
            pending: 0,
            rejections: 0,
            payable: 10,
            sold: 10,
            returns: 0,
            payout: 0,
            revenue: 50,
            profit: 50,
            currency: 'GBP',
          },
        ],
      }),
    );
    const rows = await lb.getCampaignReport('last_month');
    expect(rows[0].campaign).toBe('Conservatory Upgrades');
    expect(rows[0].campaignId).toBeUndefined();
  });

  it('getSupplierSpend handles `data` shape with object campaign+supplier refs', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        data: [
          {
            campaign: { id: '85', name: 'Conservatory Upgrades' },
            supplier: { id: 's-9', name: 'Google Ads UK' },
            leads: 200,
            valid: 180,
            invalid: 20,
            pending: 0,
            rejected: 0,
            payable: 180,
            sold: 180,
            returns: 0,
            payout: 1500,
            revenue: 4000,
            profit: 2500,
            eCPL: 7.5,
            currency: 'Britain (United Kingdom), Pounds',
          },
        ],
      }),
    );
    const rows = await lb.getSupplierSpend('last_month');
    expect(rows).toHaveLength(1);
    expect(rows[0].supplierName).toBe('Google Ads UK');
    expect(rows[0].campaignName).toBe('Conservatory Upgrades');
    expect(rows[0].campaignId).toBe('85');
    expect(rows[0].spend).toBe(1500);
    expect(rows[0].cpl).toBe(7.5);
  });

  // The portal By Source breakdown needs per-source leads for ANY date range
  // (YTD, manual calendar selection), not just named presets. getSupplierSpendByRange
  // hits /reports/supplier with explicit date-only from/to and parses leads the
  // same way getSupplierSpend does.
  it('getSupplierSpendByRange queries /reports/supplier with date-only from/to and parses valid leads', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        status: 'Success',
        data: [
          {
            campaign: { id: '85', name: 'Conservatory Upgrades' },
            supplier: { id: 's-9', name: 'Google Ads UK' },
            leads: 200,
            valid: 180,
            invalid: 20,
            payout: 1500,
            revenue: 4000,
            profit: 2500,
            eCPL: 7.5,
            currency: 'Britain (United Kingdom), Pounds',
          },
        ],
      }),
    );
    const rows = await lb.getSupplierSpendByRange('2026-01-01', '2026-06-15');
    const url = fetchMock.mock.calls[0][0] as string;
    // Real range path: explicit date-only from/to, NOT a datePreset.
    expect(url).toContain('/reports/supplier');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-06-15');
    expect(url).not.toContain('datePreset');
    // Leads parse identically to the preset path; window is tagged 'custom'.
    expect(rows).toHaveLength(1);
    expect(rows[0].validLeads).toBe(180);
    expect(rows[0].leads).toBe(200);
    expect(rows[0].spend).toBe(1500);
    expect(rows[0].window).toBe('custom');
  });

  it('getSupplierSpendByRange slices off any time component before sending from/to', async () => {
    fetchMock.mockResolvedValue(mockJsonResponse({ status: 'Success', data: [] }));
    await lb.getSupplierSpendByRange('2026-01-01T00:00:00Z', '2026-06-15T23:59:59Z');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-06-15');
    expect(url).not.toContain('T00');
    expect(url).not.toContain('%3A'); // no encoded ':' from a timestamp
  });

  it('getEmailReport accepts both `data` (real API) and `report` (legacy) envelopes', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        status: 'Success',
        data: [
          { campaign: { id: '1', name: 'X' }, sent: 10, delivered: 9, clicks: 1, conversions: 0, cost: 0, revenue: 0, profit: 0, currency: 'Britain (United Kingdom), Pounds' },
        ],
      }),
    );
    const realApi = await lb.getEmailReport({ campaignId: 1, window: 'today' });
    expect(realApi[0].campaign).toBe('X');
    expect(realApi[0].currency).toBe('GBP');

    fetchMock.mockResolvedValueOnce(mockJsonResponse({ report: [{ campaign: 'Y', sent: 5, delivered: 4, clicks: 0, conversions: 0, cost: 0, revenue: 0, profit: 0, currency: 'GBP' }] }));
    const legacy = await lb.getEmailReport({ campaignId: 1, window: 'today' });
    expect(legacy[0].campaign).toBe('Y');
    expect(legacy[0].currency).toBe('GBP');
  });

  it('getCampaigns maps human-readable currency labels to ISO codes', async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { id: 2, name: 'Solar Panels (UK)', active: 'Yes', currency: 'Britain (United Kingdom), Pounds' },
        { id: 14, name: 'Hearing Aids (CH)', active: 'Yes', currency: 'EUR' },
      ]),
    );
    const campaigns = await lb.getCampaigns();
    expect(campaigns).toHaveLength(2);
    expect(campaigns[0].currency).toBe('GBP');
    expect(campaigns[1].currency).toBe('EUR');
  });

  // Sam reported "Solar Panels" + "Last Empower Attorney" not showing under
  // the Active filter even though they were live in LeadByte. Root cause:
  // the live API returns `active` as '1'/0/etc or omits it entirely, but the
  // old normaliser only matched 'Yes'|true → defaulted everything else to 'paused'.
  describe('normaliseCampaign — active/archived flag tolerance', () => {
    it('marks active when LeadByte returns active="1"', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse([{ id: 1, name: 'Solar Panels UK', active: '1', currency: 'GBP' }]),
      );
      const [c] = await lb.getCampaigns();
      expect(c.status).toBe('active');
    });

    it('marks active when LeadByte returns active=1 (number)', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse([{ id: 1, name: 'Last Empower Attorney', active: 1, currency: 'GBP' }]),
      );
      const [c] = await lb.getCampaigns();
      expect(c.status).toBe('active');
    });

    it('defaults to active when active flag is absent (live campaign)', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse([{ id: 1, name: 'Mortgage Leads', currency: 'GBP' }]),
      );
      const [c] = await lb.getCampaigns();
      expect(c.status).toBe('active');
    });

    it('marks paused when active is explicitly No/false/0', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse([
          { id: 1, name: 'A', active: 'No', currency: 'GBP' },
          { id: 2, name: 'B', active: false, currency: 'GBP' },
          { id: 3, name: 'C', active: '0', currency: 'GBP' },
        ]),
      );
      const campaigns = await lb.getCampaigns();
      expect(campaigns.map((c) => c.status)).toEqual(['paused', 'paused', 'paused']);
    });

    it('marks inactive when archived is truthy regardless of active flag', async () => {
      fetchMock.mockResolvedValue(
        mockJsonResponse([
          { id: 1, name: 'A', active: 'Yes', archived: 'Yes', currency: 'GBP' },
          { id: 2, name: 'B', active: '1', archived: '1', currency: 'GBP' },
        ]),
      );
      const campaigns = await lb.getCampaigns();
      expect(campaigns.map((c) => c.status)).toEqual(['inactive', 'inactive']);
    });
  });
});

describe('LeadByte client — syncAll()', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  function makeDbMock(matchIds: string[]) {
    const calls: { where: unknown }[] = [];
    const chain = {
      set: () => chain,
      where: (clause: unknown) => {
        calls.push({ where: clause });
        return chain;
      },
      returning: async () => {
        const lastWhere = calls[calls.length - 1].where as { _matchValue?: string };
        const matched = lastWhere && matchIds.includes(String(lastWhere._matchValue ?? ''));
        return matched ? [{ id: 'stato-' + lastWhere._matchValue }] : [];
      },
    };
    return {
      update: () => chain,
    };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...originalEnv };
  });

  it('returns an error result when LeadByte is not configured', async () => {
    delete process.env.LEADBYTE_API_KEY;
    const result = await lb.syncAll({
      db: {} as never,
      campaigns: {} as never,
    });
    expect(result.error).toMatch(/not configured/);
    expect(result.campaignsFetched).toBe(0);
  });

  it('returns an error result when db is not configured', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    const result = await lb.syncAll({
      db: null as never,
      campaigns: {} as never,
    });
    expect(result.error).toMatch(/Database not configured/);
  });

  it('auto-creates local campaign rows for LeadByte campaigns with no DB match (Piece 1)', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { id: 'ext-1', name: 'Campaign One', active: 'Yes', archived: 'No', currency: 'GBP' },
        { id: 'ext-2', name: 'Campaign Two', active: 'Yes', archived: 'No', currency: 'GBP' },
      ]),
    );

    const insertedValues: unknown[] = [];
    // UPDATE always misses (no existing rows); INSERT always succeeds.
    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: (v: unknown) => {
          insertedValues.push(v);
          return {
            returning: async () => [{ id: 'stato-new' }],
          };
        },
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: { leadbyteCampaignId: 'col' } as never,
    });

    expect(result.campaignsFetched).toBe(2);
    expect(result.campaignsUpdated).toBe(0);
    expect(result.campaignsCreated).toBe(2);
    expect(result.unmappedCampaignIds).toHaveLength(0);
    expect(result.error).toBeUndefined();
    // Verify the rows we asked to insert carry the LeadByte campaign id + name.
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0]).toMatchObject({ leadbyteCampaignId: 'ext-1', name: 'Campaign One' });
    expect(insertedValues[1]).toMatchObject({ leadbyteCampaignId: 'ext-2', name: 'Campaign Two' });
  });

  it('auto-links Sato client to a campaign when LeadByte buyer report matches (Piece 2)', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';

    // /campaigns → one LeadByte campaign, then /buyers → one buyer matching
    // the Sato client by leadbyte id, then /reports/buyer for the campaign
    // → one row showing that buyer was active.
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse([
          { id: 'lb-camp-1', name: 'Solar Panels', active: 'Yes', archived: 'No', currency: 'GBP' },
        ]),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [
            { id: 113, company: 'Benson Goldstein Ltd', status: 'Active' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [
            {
              campaign: 'Solar Panels',
              buyer: 'Benson Goldstein Ltd',
              posted: 50,
              accepted: 50,
              sold: 50,
              rejected: 0,
              returned: 0,
              revenue: 1000,
              currency: 'GBP',
            },
          ],
        }),
      );

    const insertedLinks: unknown[] = [];

    // Campaign UPDATE always misses; INSERT creates a stato row.
    // Then discovery: select(clients) returns 1, select(campaigns) returns 1
    // candidate, then insert(clientCampaigns) succeeds.
    let campaignsInsertCount = 0;
    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: unknown) => {
          // Distinguish campaigns insert from clientCampaigns insert by the
          // table object passed.
          if (table === campaignsTableRef) {
            campaignsInsertCount++;
            return { returning: async () => [{ id: 'stato-camp-1' }] };
          }
          // clientCampaigns insert
          insertedLinks.push(v);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: 'cc-1' }],
            }),
          };
        },
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async (_clause: unknown) => {
            if (table === clientsTableRef) {
              return [{ id: 'sato-client-1', companyName: 'Benson Goldstein Ltd', leadbyteClientId: '113' }];
            }
            // campaigns candidates
            return [{ campaignId: 'stato-camp-1', leadbyteCampaignId: 'lb-camp-1' }];
          },
        }),
      }),
    };

    // Use distinct token objects so the mock can identify which table was
    // passed to insert()/select().from().
    const campaignsTableRef = { __ref: 'campaigns' };
    const clientsTableRef = { __ref: 'clients' };
    const clientCampaignsTableRef = { __ref: 'clientCampaigns' };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: campaignsTableRef as never,
      clients: clientsTableRef as never,
      clientCampaigns: clientCampaignsTableRef as never,
    });

    expect(result.campaignsFetched).toBe(1);
    expect(result.campaignsCreated).toBe(1);
    expect(campaignsInsertCount).toBe(1);
    expect(result.campaignLinksCreated).toBe(1);
    expect(insertedLinks).toEqual([{ clientId: 'sato-client-1', campaignId: 'stato-camp-1' }]);
  });

  it('writes per-day lead_deliveries for single-linked-client campaigns (Piece 3)', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';

    // Sequence:
    //  1. /campaigns → 1 campaign
    //  2. /buyers (Piece 2) → 1 buyer
    //  3. /reports/buyer (Piece 2) → 1 buyer row matching the client
    //  4. /reports/leadactivity (Piece 3) → 2 daily rows
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse([
          { id: 'lb-camp-1', name: 'Solar Panels', active: 'Yes', archived: 'No', currency: 'GBP' },
        ]),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [{ id: 113, company: 'Benson Goldstein Ltd', status: 'Active' }],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [
            {
              campaign: 'Solar Panels',
              buyer: 'Benson Goldstein Ltd',
              posted: 50,
              accepted: 50,
              sold: 50,
              rejected: 0,
              returned: 0,
              revenue: 1000,
              currency: 'GBP',
            },
          ],
        }),
      )
      // Piece 3 money fix: /reports/campaign for last_month + this_month
      // (windowed revenue/payout totals to pro-rate across daily lead counts).
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [
            {
              campaign: { id: 'lb-camp-1', name: 'Solar Panels' },
              leads: 5,
              valid: 5,
              invalid: 0,
              pending: 0,
              rejections: 0,
              payable: 5,
              sold: 5,
              returns: 0,
              payout: 40,
              revenue: 100,
              profit: 60,
              currency: 'GBP',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [
            {
              campaign: { id: 'lb-camp-1', name: 'Solar Panels' },
              leads: 20,
              valid: 20,
              invalid: 0,
              pending: 0,
              rejections: 0,
              payable: 20,
              sold: 20,
              returns: 0,
              payout: 80,
              revenue: 200,
              profit: 120,
              currency: 'GBP',
            },
          ],
        }),
      )
      // Piece 3 fetches BOTH last_month and this_month per campaign.
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [{ date: '2026-04-15', count: 5 }],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [
            { date: '2026-05-15', count: 8 },
            { date: '2026-05-16', count: 12 },
          ],
        }),
      );

    const upsertedDeliveries: unknown[] = [];

    const campaignsTableRef = { __ref: 'campaigns' };
    const clientsTableRef = { __ref: 'clients' };
    const clientCampaignsTableRef = { __ref: 'clientCampaigns' };
    const leadDeliveriesTableRef = {
      campaignId: 'd_campaignId',
      clientId: 'd_clientId',
      deliveryDate: 'd_deliveryDate',
      id: 'd_id',
      __ref: 'leadDeliveries',
    };

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: unknown) => {
          if (table === campaignsTableRef) {
            return { returning: async () => [{ id: 'stato-camp-1' }] };
          }
          if (table === clientCampaignsTableRef) {
            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: 'cc-1' }],
              }),
            };
          }
          // leadDeliveries insert
          upsertedDeliveries.push(v);
          return {
            onConflictDoUpdate: () => ({
              returning: async () => [{ id: 'ld-' + upsertedDeliveries.length }],
            }),
          };
        },
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === clientsTableRef) {
              return [{ id: 'sato-client-1', companyName: 'Benson Goldstein Ltd', leadbyteClientId: '113' }];
            }
            return [{ campaignId: 'stato-camp-1', leadbyteCampaignId: 'lb-camp-1' }];
          },
          innerJoin: () => ({
            where: async () => [
              { campaignId: 'stato-camp-1', clientId: 'sato-client-1', leadbyteCampaignId: 'lb-camp-1' },
            ],
          }),
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: campaignsTableRef as never,
      clients: clientsTableRef as never,
      clientCampaigns: clientCampaignsTableRef as never,
      leadDeliveries: leadDeliveriesTableRef as never,
    });

    expect(result.deliveriesUpserted).toBe(3);
    expect(result.deliveryCampaignsSkipped).toBe(0);
    // Money fix: revenue + cost are pro-rated from /reports/campaign totals.
    //   last_month  → 5 leads in the window, £100 revenue / £40 payout → all
    //                 attributed to the single day (5/5 of each): £100 / £40
    //   this_month  → 20 leads, £200 revenue / £80 payout
    //                 day 5/15 (8 leads): 8/20 × £200 = £80; 8/20 × £80 = £32
    //                 day 5/16 (12 leads): 12/20 × £200 = £120; 12/20 × £80 = £48
    expect(upsertedDeliveries).toEqual([
      expect.objectContaining({
        campaignId: 'stato-camp-1',
        clientId: 'sato-client-1',
        deliveryDate: '2026-04-15',
        leadCount: 5,
        revenue: '100.00',
        cost: '40.00',
      }),
      expect.objectContaining({
        campaignId: 'stato-camp-1',
        clientId: 'sato-client-1',
        deliveryDate: '2026-05-15',
        leadCount: 8,
        revenue: '80.00',
        cost: '32.00',
      }),
      expect.objectContaining({
        campaignId: 'stato-camp-1',
        clientId: 'sato-client-1',
        deliveryDate: '2026-05-16',
        leadCount: 12,
        revenue: '120.00',
        cost: '48.00',
      }),
    ]);
  });

  it('skips lead_deliveries write for campaigns linked to multiple clients (Piece 3 safety)', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';

    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse([
          { id: 'lb-camp-1', name: 'Solar Panels', active: 'Yes', archived: 'No', currency: 'GBP' },
        ]),
      )
      .mockResolvedValueOnce(mockJsonResponse({ data: [] })) // /buyers
      .mockResolvedValueOnce(mockJsonResponse({ report: [] })); // /reports/buyer (no new links)

    const campaignsTableRef = { __ref: 'campaigns' };
    const clientsTableRef = { __ref: 'clients' };
    const clientCampaignsTableRef = { __ref: 'clientCampaigns' };
    const leadDeliveriesTableRef = { __ref: 'leadDeliveries' };

    const dbMock = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'x' }] }) }) }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
          onConflictDoUpdate: () => ({ returning: async () => [] }),
          returning: async () => [{ id: 'x' }],
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === clientsTableRef ? [] : []),
          innerJoin: () => ({
            where: async () => [
              // Two clients linked to the same campaign — should skip.
              { campaignId: 'stato-camp-1', clientId: 'sato-client-1', leadbyteCampaignId: 'lb-camp-1' },
              { campaignId: 'stato-camp-1', clientId: 'sato-client-2', leadbyteCampaignId: 'lb-camp-1' },
            ],
          }),
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: campaignsTableRef as never,
      clients: clientsTableRef as never,
      clientCampaigns: clientCampaignsTableRef as never,
      leadDeliveries: leadDeliveriesTableRef as never,
    });

    expect(result.deliveriesUpserted).toBe(0);
    expect(result.deliveryCampaignsSkipped).toBe(1);
  });

  it('omits revenue/cost from upserts when /reports/campaign returns no matching row (preserves existing values)', async () => {
    // Guards the regression we saw post-deploy: a transient empty
    // /reports/campaign for last_month had been overwriting good revenue
    // numbers with £0 on subsequent syncs. Now we only set money fields
    // when we actually have totals to pro-rate from.
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';

    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse([
          { id: 'lb-camp-1', name: 'Solar Panels', active: 'Yes', archived: 'No', currency: 'GBP' },
        ]),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [{ id: 113, company: 'Benson Goldstein Ltd', status: 'Active' }],
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [
            {
              campaign: 'Solar Panels',
              buyer: 'Benson Goldstein Ltd',
              posted: 50,
              accepted: 50,
              sold: 50,
              rejected: 0,
              returned: 0,
              revenue: 1000,
              currency: 'GBP',
            },
          ],
        }),
      )
      // /reports/campaign both windows return NO matching campaign row
      // (e.g. campaignId mismatch / cache returned negative-cached empty).
      .mockResolvedValueOnce(mockJsonResponse({ data: [] }))
      .mockResolvedValueOnce(mockJsonResponse({ data: [] }))
      // /reports/leadactivity per window still has daily counts.
      .mockResolvedValueOnce(mockJsonResponse({ report: [{ date: '2026-04-15', count: 5 }] }))
      .mockResolvedValueOnce(mockJsonResponse({ report: [{ date: '2026-05-15', count: 8 }] }));

    const upsertedDeliveries: Array<Record<string, unknown>> = [];
    const updatedDeliveries: Array<Record<string, unknown>> = [];
    const campaignsTableRef = { __ref: 'campaigns' };
    const clientsTableRef = { __ref: 'clients' };
    const clientCampaignsTableRef = { __ref: 'clientCampaigns' };
    const leadDeliveriesTableRef = {
      campaignId: 'd_campaignId',
      clientId: 'd_clientId',
      deliveryDate: 'd_deliveryDate',
      id: 'd_id',
      __ref: 'leadDeliveries',
    };

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: unknown) => {
          if (table === campaignsTableRef) {
            return { returning: async () => [{ id: 'stato-camp-1' }] };
          }
          if (table === clientCampaignsTableRef) {
            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: 'cc-1' }],
              }),
            };
          }
          // leadDeliveries insert
          upsertedDeliveries.push(v as Record<string, unknown>);
          return {
            onConflictDoUpdate: (args: { set: Record<string, unknown> }) => {
              updatedDeliveries.push(args.set);
              return { returning: async () => [{ id: 'ld-' + upsertedDeliveries.length }] };
            },
          };
        },
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === clientsTableRef) {
              return [{ id: 'sato-client-1', companyName: 'Benson Goldstein Ltd', leadbyteClientId: '113' }];
            }
            return [{ campaignId: 'stato-camp-1', leadbyteCampaignId: 'lb-camp-1' }];
          },
          innerJoin: () => ({
            where: async () => [
              { campaignId: 'stato-camp-1', clientId: 'sato-client-1', leadbyteCampaignId: 'lb-camp-1' },
            ],
          }),
        }),
      }),
    };

    await lb.syncAll({
      db: dbMock as never,
      campaigns: campaignsTableRef as never,
      clients: clientsTableRef as never,
      clientCampaigns: clientCampaignsTableRef as never,
      leadDeliveries: leadDeliveriesTableRef as never,
    });

    expect(upsertedDeliveries).toHaveLength(2);
    // Money fields must NOT be in the INSERT values…
    for (const row of upsertedDeliveries) {
      expect(row).not.toHaveProperty('revenue');
      expect(row).not.toHaveProperty('cost');
    }
    // …or in the ON CONFLICT SET clause (so existing values are preserved).
    for (const set of updatedDeliveries) {
      expect(set).not.toHaveProperty('revenue');
      expect(set).not.toHaveProperty('cost');
    }
  });

  it('skips client_campaigns discovery when clients/clientCampaigns deps are omitted (legacy callers)', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { id: 'ext-1', name: 'Campaign One', active: 'Yes', archived: 'No', currency: 'GBP' },
      ]),
    );

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: 'stato-1' }],
          }),
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: { leadbyteCampaignId: 'col' } as never,
    });

    expect(result.campaignLinksCreated).toBe(0);
  });

  it('still falls back to unmappedCampaignIds when both update and insert return 0 rows', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { id: 'ext-1', name: 'Campaign One', active: 'Yes', archived: 'No', currency: 'GBP' },
      ]),
    );

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: async () => [],
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: { leadbyteCampaignId: 'col' } as never,
    });

    expect(result.campaignsCreated).toBe(0);
    expect(result.unmappedCampaignIds).toEqual(['ext-1']);
  });

  it('counts campaignsUpdated when db.update returns a row', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { id: 'ext-1', name: 'Campaign One', active: 'Yes', archived: 'No', currency: 'GBP' },
      ]),
    );

    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: 'stato-1' }],
          }),
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: { leadbyteCampaignId: 'col' } as never,
    });

    expect(result.campaignsFetched).toBe(1);
    expect(result.campaignsUpdated).toBe(1);
    expect(result.unmappedCampaignIds).toHaveLength(0);
  });
});

describe('LeadByte client — normalizeBuyerName', () => {
  it('treats "Benson Goldstein Ltd" and "Benson Goldstein" as the same buyer', () => {
    expect(lb.normalizeBuyerName('Benson Goldstein Ltd')).toBe(
      lb.normalizeBuyerName('Benson Goldstein'),
    );
  });

  it('treats "Limited" and "Ltd" suffixes as equivalent', () => {
    expect(lb.normalizeBuyerName('Acme Limited')).toBe(lb.normalizeBuyerName('Acme Ltd'));
  });

  it('strips trailing punctuation and case differences', () => {
    expect(lb.normalizeBuyerName('Tomic Zero, Inc.')).toBe(
      lb.normalizeBuyerName('tomic zero inc'),
    );
  });

  it('collapses internal whitespace', () => {
    expect(lb.normalizeBuyerName('  Two   Words  ')).toBe('two words');
  });

  it('keeps distinct buyers distinct', () => {
    expect(lb.normalizeBuyerName('Acme')).not.toBe(lb.normalizeBuyerName('Acme Solutions'));
  });

  it('handles PLC / Corp / LLC / Co suffixes', () => {
    const base = lb.normalizeBuyerName('Northwind');
    expect(lb.normalizeBuyerName('Northwind PLC')).toBe(base);
    expect(lb.normalizeBuyerName('Northwind Corp')).toBe(base);
    expect(lb.normalizeBuyerName('Northwind LLC')).toBe(base);
    expect(lb.normalizeBuyerName('Northwind Co.')).toBe(base);
    expect(lb.normalizeBuyerName('Northwind Corporation')).toBe(base);
  });
});

describe('LeadByte client — discoverClientCampaignLinks name-suffix tolerance', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...originalEnv };
  });

  // Regression test for Benson Goldstein (2026-05-17): /buyers returned
  // "Benson Goldstein Ltd" but /reports/buyer returned "Benson Goldstein" so
  // the old exact-name match silently dropped the link despite
  // leadbyte_client_id being set on the Sato client. The normalizer should
  // close this gap.
  it('links a client even when /buyers and /reports/buyer disagree on the Ltd suffix', async () => {
    fetchMock
      // 1) /campaigns
      .mockResolvedValueOnce(
        mockJsonResponse([
          { id: 'lb-camp-1', name: 'Solar Panels', active: 'Yes', archived: 'No', currency: 'GBP' },
        ]),
      )
      // 2) /buyers — name has the Ltd suffix
      .mockResolvedValueOnce(
        mockJsonResponse({
          data: [{ id: 113, company: 'Benson Goldstein Ltd', status: 'Active' }],
        }),
      )
      // 3) /reports/buyer — same buyer, no suffix
      .mockResolvedValueOnce(
        mockJsonResponse({
          report: [
            {
              campaign: 'Solar Panels',
              buyer: 'Benson Goldstein',
              posted: 50,
              accepted: 50,
              sold: 50,
              rejected: 0,
              returned: 0,
              revenue: 1000,
              currency: 'GBP',
            },
          ],
        }),
      );

    const insertedLinks: unknown[] = [];
    const campaignsTableRef = { __ref: 'campaigns' };
    const clientsTableRef = { __ref: 'clients' };
    const clientCampaignsTableRef = { __ref: 'clientCampaigns' };

    const dbMock = {
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }),
      insert: (table: unknown) => ({
        values: (v: unknown) => {
          if (table === campaignsTableRef) {
            return { returning: async () => [{ id: 'stato-camp-1' }] };
          }
          insertedLinks.push(v);
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: 'cc-1' }],
            }),
          };
        },
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === clientsTableRef) {
              return [{ id: 'sato-client-1', companyName: 'Benson Goldstein Ltd', leadbyteClientId: '113' }];
            }
            return [{ campaignId: 'stato-camp-1', leadbyteCampaignId: 'lb-camp-1' }];
          },
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: campaignsTableRef as never,
      clients: clientsTableRef as never,
      clientCampaigns: clientCampaignsTableRef as never,
    });

    expect(result.campaignLinksCreated).toBe(1);
    expect(insertedLinks).toEqual([{ clientId: 'sato-client-1', campaignId: 'stato-camp-1' }]);
  });
});

// ─── Pro-ration math for lead_deliveries.revenue/cost (Piece 3 money fix) ─────

describe('LeadByte client — proRateDailyMoney', () => {
  it('spreads windowed revenue/payout proportionally across daily lead counts', () => {
    // 100 leads over the window → £1000 revenue / £400 payout.
    // A day with 25 leads gets 25/100 of each.
    expect(
      lb.proRateDailyMoney({ leadCount: 25, totalLeads: 100, totalRevenue: 1000, totalPayout: 400 }),
    ).toEqual({ revenue: 250, cost: 100 });
  });

  it('rounds to 2 decimal places (banker-free, half-away-from-zero via Math.round)', () => {
    // 33 leads × (100 / 100) → 33, but 1 lead × (100 / 3) → 33.333… → 33.33
    expect(
      lb.proRateDailyMoney({ leadCount: 1, totalLeads: 3, totalRevenue: 100, totalPayout: 50 }),
    ).toEqual({ revenue: 33.33, cost: 16.67 });
  });

  it('returns zeros when totalLeads is 0 (avoid divide-by-zero)', () => {
    expect(
      lb.proRateDailyMoney({ leadCount: 5, totalLeads: 0, totalRevenue: 999, totalPayout: 999 }),
    ).toEqual({ revenue: 0, cost: 0 });
  });

  it('returns zeros when leadCount is 0 (no attribution for blank day)', () => {
    expect(
      lb.proRateDailyMoney({ leadCount: 0, totalLeads: 100, totalRevenue: 1000, totalPayout: 400 }),
    ).toEqual({ revenue: 0, cost: 0 });
  });

  it('survives NaN/Infinity in totals without producing garbage rows', () => {
    expect(
      lb.proRateDailyMoney({
        leadCount: 10,
        totalLeads: 50,
        totalRevenue: Number.NaN,
        totalPayout: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ revenue: 0, cost: 0 });
  });

  it('preserves cost when revenue is missing (and vice versa)', () => {
    // Some windows have payout populated but no buyer revenue logged yet.
    expect(
      lb.proRateDailyMoney({ leadCount: 10, totalLeads: 100, totalRevenue: 0, totalPayout: 250 }),
    ).toEqual({ revenue: 0, cost: 25 });
  });
});
