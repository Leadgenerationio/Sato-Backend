import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { leadDeliveries } from '../db/schema/lead-deliveries.js';
import { campaigns } from '../db/schema/campaigns.js';
import { clients } from '../db/schema/clients.js';
import { invoices } from '../db/schema/invoices.js';
import { agreements } from '../db/schema/agreements.js';
import { creditChecks } from '../db/schema/credit-checks.js';
import type { AuthPayload } from '../types/index.js';

export interface LeadsByDayPoint {
  /** Short weekday label, e.g. "Mon". */
  day: string;
  /** ISO YYYY-MM-DD for cross-checking. */
  date: string;
  leads: number;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

/**
 * Daily lead totals across all clients for the last N days. Powers the
 * "Leads This Week" bar chart on the admin dashboard.
 *
 * Days with zero leads are returned as `leads: 0` so the chart never has gaps.
 */
export async function getLeadsByDay(_requester: AuthPayload, days = 7): Promise<LeadsByDayPoint[]> {
  const safeDays = Math.max(1, Math.min(90, days));
  const fromDate = isoDay(-(safeDays - 1));

  const rows = await db
    .select({
      date: leadDeliveries.deliveryDate,
      leads: sql<number>`coalesce(sum(${leadDeliveries.leadCount}), 0)::int`,
    })
    .from(leadDeliveries)
    .where(gte(leadDeliveries.deliveryDate, fromDate))
    .groupBy(leadDeliveries.deliveryDate);

  const byDate = new Map(rows.map((r) => [r.date, r.leads]));
  const out: LeadsByDayPoint[] = [];
  for (let i = safeDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    out.push({
      day: WEEKDAY_LABELS[d.getDay()],
      date: dateStr,
      leads: byDate.get(dateStr) ?? 0,
    });
  }
  return out;
}

export interface ActivityItem {
  /** Stable id so the FE can dedupe and use as a key. */
  id: string;
  /** Display label for the actor. "System" for automated events. */
  user: string;
  /** Human-readable description, e.g. "Created invoice INV-1050 for Apex Media". */
  action: string;
  /** ISO timestamp; FE renders a relative time. */
  timestamp: string;
  /** Category — FE picks an icon from this. */
  category: 'invoice' | 'agreement' | 'credit' | 'system';
}

/**
 * Merge recent invoices, agreements, and credit checks into a single
 * chronological activity feed. Replaces the hardcoded mock the dashboard
 * was using.
 */
export async function getRecentActivity(_requester: AuthPayload, limit = 10): Promise<ActivityItem[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));

  // Pull a generous batch from each source then merge — most-recent-first.
  const [recentInvoices, recentAgreements, recentCredit] = await Promise.all([
    db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        total: invoices.total,
        currency: invoices.currency,
        createdAt: invoices.createdAt,
        clientName: clients.companyName,
      })
      .from(invoices)
      .leftJoin(clients, eq(clients.id, invoices.clientId))
      .orderBy(desc(invoices.createdAt))
      .limit(safeLimit),
    db
      .select({
        id: agreements.id,
        signedAt: agreements.signedAt,
        sentAt: agreements.sentAt,
        signerName: agreements.signerName,
        status: agreements.status,
        clientName: clients.companyName,
      })
      .from(agreements)
      .leftJoin(clients, eq(clients.id, agreements.clientId))
      .orderBy(desc(agreements.sentAt))
      .limit(safeLimit),
    db
      .select({
        id: creditChecks.id,
        creditScore: creditChecks.creditScore,
        scoreChange: creditChecks.scoreChange,
        checkedAt: creditChecks.checkedAt,
        clientName: clients.companyName,
      })
      .from(creditChecks)
      .leftJoin(clients, eq(clients.id, creditChecks.clientId))
      .orderBy(desc(creditChecks.checkedAt))
      .limit(safeLimit),
  ]);

  const items: ActivityItem[] = [];

  for (const r of recentInvoices) {
    if (!r.createdAt) continue;
    const amount = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: r.currency ?? 'GBP',
      maximumFractionDigits: 0,
    }).format(Number(r.total ?? 0));
    items.push({
      id: `inv-${r.id}`,
      user: 'System',
      action: `Invoice ${r.invoiceNumber ?? ''} created for ${r.clientName ?? 'client'} (${amount})`,
      timestamp: r.createdAt.toISOString(),
      category: 'invoice',
    });
  }

  for (const a of recentAgreements) {
    const ts = a.signedAt ?? a.sentAt;
    if (!ts) continue;
    const verb = a.signedAt ? 'signed' : 'sent';
    items.push({
      id: `agr-${a.id}`,
      user: 'System',
      action: `Agreement ${verb} — ${a.signerName ?? a.clientName ?? 'client'}`,
      timestamp: ts.toISOString(),
      category: 'agreement',
    });
  }

  for (const c of recentCredit) {
    if (!c.checkedAt) continue;
    const change = c.scoreChange ?? 0;
    const changeStr = change > 0 ? `+${change}` : change < 0 ? String(change) : '';
    const action = changeStr
      ? `Credit check: ${c.clientName ?? 'client'} score ${c.creditScore ?? '?'} (${changeStr})`
      : `Credit check: ${c.clientName ?? 'client'} score ${c.creditScore ?? '?'}`;
    items.push({
      id: `credit-${c.id}`,
      user: 'System',
      action,
      timestamp: c.checkedAt.toISOString(),
      category: 'credit',
    });
  }

  return items
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, safeLimit);
}

void and;  // and is exported just-in-case future filters need scoping
