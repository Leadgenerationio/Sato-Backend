import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/rbac.middleware.js';
import * as lb from '../integrations/leadbyte/leadbyte-client.js';
import type { DeliveryWindow } from '../integrations/leadbyte/leadbyte-types.js';
import { cached } from '../utils/cache.js';

// Read-through TTL for the dashboard caches. The 90s prewarmer keeps these
// keys hot, so user requests almost always hit a warm Redis entry; this TTL
// is the safety net if the worker dies and acts as the cap on staleness.
const DASHBOARD_TTL_SECONDS = 300;
const LIST_TTL_SECONDS = 300;

export const leadbyteRoutes: RouterType = Router();

leadbyteRoutes.use(authMiddleware);

const owner = requireRole('owner');
const ops = requireRole('owner', 'ops_manager');
const finance = requireRole('owner', 'finance_admin');

function wrap<T>(fn: (req: Request) => Promise<T>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await fn(req);
      // Match the api/v1 envelope shape the FE's `unwrap()` + ApiClient expect.
      // Without `status: 'success'` here, every LeadByte route silently fails on
      // the FE — including the "Couldn't load campaign report" error on the
      // LeadByte Dashboard page.
      res.json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  };
}

function pathId(req: Request): string {
  return String(req.params.id);
}

// ─── Campaigns ──────────────────────────────────────────────────────────────
leadbyteRoutes.get('/campaigns/:id', ops, wrap((req) => lb.getCampaignById(pathId(req))));

// ─── Leads ──────────────────────────────────────────────────────────────────
leadbyteRoutes.post('/leads', ops, wrap((req) => {
  const body = req.body as { leads?: Array<Record<string, unknown>>; lead?: Record<string, unknown> };
  if (body.leads) return lb.submitLeads(body.leads);
  return lb.submitLead(body.lead ?? body);
}));
leadbyteRoutes.get('/leads/:id', ops, wrap((req) => lb.getLeadById(pathId(req))));
leadbyteRoutes.post('/leads/batch', ops, wrap((req) => lb.getLeadsBatch(req.body.leadIds)));
leadbyteRoutes.put('/leads', ops, wrap((req) => lb.updateLeads(req.body.leads)));
leadbyteRoutes.post('/leads/search', ops, wrap((req) => lb.searchLeads(req.body)));
leadbyteRoutes.post('/leads/return', ops, wrap((req) => lb.returnLead(req.body)));
leadbyteRoutes.put('/leads/feedback', ops, wrap((req) => lb.addLeadFeedback(req.body)));
leadbyteRoutes.put('/leads/internalfeedback', ops, wrap((req) => lb.addLeadInternalFeedback(req.body)));
leadbyteRoutes.post('/leads/reprocess', ops, wrap((req) => lb.reprocessLeads(req.body)));
leadbyteRoutes.post('/leads/assignbuyer', ops, wrap((req) => lb.assignBuyer(req.body)));
leadbyteRoutes.post('/leads/ping', ops, wrap((req) => lb.pingLead(req.body)));
leadbyteRoutes.post('/leads/deliverychecker', ops, wrap((req) => lb.deliveryChecker(req.body)));

// ─── Deliveries ─────────────────────────────────────────────────────────────
leadbyteRoutes.post('/deliveries/create', ops, wrap((req) => lb.createDelivery(req.body)));
leadbyteRoutes.get('/deliveries', ops, wrap((req) => {
  const filter = req.query as unknown as { status?: 'Active' | 'Inactive' | 'Saved'; bid?: string };
  // Cache only the unfiltered listing (the only shape the FE currently calls).
  // Filtered queries are rare and bypass the cache to keep results live.
  if (!filter.status && !filter.bid) {
    return cached('lb:deliveries:all:v1', LIST_TTL_SECONDS, () => lb.getDeliveries(filter));
  }
  return lb.getDeliveries(filter);
}));
leadbyteRoutes.get('/deliveries/:id', ops, wrap((req) => lb.getDeliveryById(pathId(req))));
leadbyteRoutes.put('/deliveries', ops, wrap((req) => lb.updateDeliveries(req.body.deliveries)));
leadbyteRoutes.put('/deliveries/:id', ops, wrap((req) => lb.updateDeliveryById(pathId(req), req.body.update)));
leadbyteRoutes.post('/deliveries/trigger', ops, wrap((req) => lb.triggerDeliveries(req.body)));

// ─── Responders ─────────────────────────────────────────────────────────────
leadbyteRoutes.get('/responders', ops, wrap(() => lb.getResponders()));
leadbyteRoutes.get('/responders/:id', ops, wrap((req) => lb.getResponderById(pathId(req))));

// ─── API Queue ──────────────────────────────────────────────────────────────
leadbyteRoutes.get('/queue/:ref', ops, wrap((req) => lb.getQueueItem(String(req.params.ref))));
leadbyteRoutes.post('/queue/batch', ops, wrap((req) => lb.getQueueItemsBatch(req.body.queueIds)));

// ─── Lead Financials ────────────────────────────────────────────────────────
leadbyteRoutes.put('/leadfinancials', finance, wrap((req) => lb.updateLeadFinancials(req.body)));

// ─── Reports ────────────────────────────────────────────────────────────────
leadbyteRoutes.get('/reports/email', ops, wrap((req) => lb.getEmailReport(req.query as unknown as Parameters<typeof lb.getEmailReport>[0])));
leadbyteRoutes.get('/reports/sms', ops, wrap((req) => lb.getSmsReport(req.query as unknown as Parameters<typeof lb.getSmsReport>[0])));
leadbyteRoutes.get('/reports/bulkemail', ops, wrap((req) => lb.getBulkEmailReport(req.query as unknown as Parameters<typeof lb.getBulkEmailReport>[0])));
leadbyteRoutes.get('/reports/bulksms', ops, wrap((req) => lb.getBulkSmsReport(req.query as unknown as Parameters<typeof lb.getBulkSmsReport>[0])));
leadbyteRoutes.get('/reports/buyer', ops, wrap((req) => lb.getBuyerReport(req.query as unknown as Parameters<typeof lb.getBuyerReport>[0])));

// ─── Time-slice dashboard endpoints ─────────────────────────────────────────
const VALID_WINDOWS = new Set<DeliveryWindow>(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'ytd']);

function parseWindow(req: Request): DeliveryWindow {
  const raw = String(req.query.window || 'today') as DeliveryWindow;
  return VALID_WINDOWS.has(raw) ? raw : 'today';
}

/** Per-campaign summary (leads/valid/revenue/payout/profit) for a given time window. */
leadbyteRoutes.get('/reports/campaign', ops, wrap((req) => {
  const window = parseWindow(req);
  return cached(`lb:report:${window}:v5`, DASHBOARD_TTL_SECONDS, () => lb.getCampaignReport(window));
}));

/** Supplier-level spend breakdown for a given time window. */
leadbyteRoutes.get('/reports/supplier-spend', ops, wrap((req) => {
  const window = parseWindow(req);
  return cached(`lb:supplier-spend:${window}:v1`, DASHBOARD_TTL_SECONDS, () => lb.getSupplierSpend(window));
}));

/**
 * Aggregated dashboard summary — totals across all campaigns for the selected window.
 * Returns { window, leads, valid, revenue, payout, profit, campaigns: n }.
 * Per Sam's spec: no invalid split shown in UI.
 *
 * Reuses the same `lb:report:{window}:v5` cache key as /reports/campaign so we
 * don't double-hit LeadByte when the dashboard loads (summary + campaign-table
 * + supplier-spend fire concurrently).
 */
leadbyteRoutes.get('/reports/summary', ops, wrap(async (req) => {
  const window = parseWindow(req);
  const rows = await cached(`lb:report:${window}:v5`, DASHBOARD_TTL_SECONDS, () => lb.getCampaignReport(window));
  const totals = rows.reduce(
    (acc, r) => {
      acc.leads += Number(r.leads || 0);
      acc.valid += Number(r.valid || 0);
      acc.revenue += Number(r.revenue || 0);
      acc.payout += Number(r.payout || 0);
      acc.profit += Number(r.profit || 0);
      return acc;
    },
    { leads: 0, valid: 0, revenue: 0, payout: 0, profit: 0 },
  );
  return {
    window,
    campaigns: rows.length,
    ...totals,
    currency: rows[0]?.currency || 'GBP',
  };
}));

// ─── Credit ─────────────────────────────────────────────────────────────────
leadbyteRoutes.post('/credit/add', finance, wrap((req) => lb.addCredit(req.body)));

// ─── Buyers ─────────────────────────────────────────────────────────────────
leadbyteRoutes.post('/buyers', owner, wrap((req) => lb.createBuyer(req.body)));
leadbyteRoutes.get('/buyers', ops, wrap((req) => {
  const status = req.query.status as 'Active' | 'Inactive' | undefined;
  if (!status) {
    return cached('lb:buyers:all:v1', LIST_TTL_SECONDS, () => lb.getBuyers());
  }
  return lb.getBuyers(status);
}));
leadbyteRoutes.get('/buyers/:id', ops, wrap((req) => lb.getBuyerById(pathId(req))));
leadbyteRoutes.put('/buyers', owner, wrap((req) => lb.updateBuyers(req.body.buyers)));
leadbyteRoutes.put('/buyers/:id', owner, wrap((req) => lb.updateBuyerById(pathId(req), req.body.update)));

// ─── Quarantine ─────────────────────────────────────────────────────────────
leadbyteRoutes.post('/quarantine/process', ops, wrap((req) => lb.processQuarantine(req.body)));
