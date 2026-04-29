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
    expect(lb.windowToPreset('ytd')).toBeUndefined();
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

  it('fetches campaigns and reports unmapped ids when no DB rows match', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { campaignId: 'ext-1', name: 'Campaign One', status: 'Active', type: 'Solar', pricePerLead: '10' },
        { campaignId: 'ext-2', name: 'Campaign Two', status: 'Active', type: 'Finance', pricePerLead: '20' },
      ]),
    );

    // db.update(...).set(...).where(...).returning() — always returns [] (no matches)
    const dbMock = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    };

    const result = await lb.syncAll({
      db: dbMock as never,
      campaigns: { leadbyteCampaignId: 'col' } as never,
    });

    expect(result.campaignsFetched).toBe(2);
    expect(result.campaignsUpdated).toBe(0);
    expect(result.unmappedCampaignIds).toHaveLength(2);
    expect(result.error).toBeUndefined();
  });

  it('counts campaignsUpdated when db.update returns a row', async () => {
    process.env.LEADBYTE_API_KEY = 'test-key';
    process.env.LEADBYTE_BASE_URL = 'https://example.test/restapi/v1.3';
    fetchMock.mockResolvedValue(
      mockJsonResponse([
        { campaignId: 'ext-1', name: 'Campaign One', status: 'Active', type: 'Solar', pricePerLead: '10' },
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
