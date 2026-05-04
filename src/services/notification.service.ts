import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { notifications } from '../db/schema/notifications.js';
import { sendEmail } from '../integrations/resend/resend-client.js';
import { renderEmailHtml, renderEmailText, templates } from '../integrations/resend/resend-templates.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

export type NotificationType =
  | 'invoice_overdue'
  | 'credit_alert'
  | 'workflow_complete'
  | 'payment_received'
  | 'onboarding_update'
  | 'lead_delivery'
  | 'vat_shortfall'
  | 'agreement_signed'
  | 'system_error';

export interface Notification {
  id: string;
  userId?: string | null;
  type: string;
  title: string;
  message: string | null;
  severity?: string | null;
  read: boolean;
  actionUrl?: string | null;
  metadata?: unknown;
  createdAt: string | Date | null;
}

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  userId?: string;
  severity?: 'info' | 'warning' | 'error';
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  emailTo?: string | string[];
  emailTemplate?: { subject: string; headline: string; body: string; ctaLabel?: string; ctaUrl?: string };
}

// ─── In-memory fallback used when no DATABASE_URL is configured (tests, local dev) ───
const mockNotifications: Notification[] = [
  { id: 'ntf-001', type: 'invoice_overdue', title: 'Invoice INV-2026-042 overdue', message: 'TradeFX Ltd invoice of £4,200.00 is 14 days past due. Consider sending a chase.', severity: 'warning', read: false, createdAt: '2026-04-15T09:30:00Z' },
  { id: 'ntf-002', type: 'credit_alert', title: 'Credit score drop — Apex Leads', message: 'Apex Leads credit score fell from 72 to 54. Risk rating changed to Medium.', severity: 'warning', read: false, createdAt: '2026-04-15T08:45:00Z' },
  { id: 'ntf-003', type: 'workflow_complete', title: 'Monthly invoicing workflow finished', message: 'Auto-invoicing workflow completed. 12 invoices generated for March billing cycle.', severity: 'info', read: false, createdAt: '2026-04-15T07:00:00Z' },
  { id: 'ntf-004', type: 'payment_received', title: 'Payment received — GreenField Marketing', message: 'GreenField Marketing paid invoice INV-2026-038 (£6,750.00) via bank transfer.', severity: 'info', read: false, createdAt: '2026-04-14T16:20:00Z' },
  { id: 'ntf-005', type: 'onboarding_update', title: 'Client onboarding progressed — BlueStar Digital', message: 'BlueStar Digital completed agreement signing. Awaiting first campaign setup.', severity: 'info', read: false, createdAt: '2026-04-14T14:10:00Z' },
  { id: 'ntf-006', type: 'lead_delivery', title: 'Lead delivery spike — Solar UK campaign', message: 'Solar UK campaign received 342 leads today, 85% above daily average.', severity: 'info', read: true, createdAt: '2026-04-14T12:00:00Z' },
  { id: 'ntf-007', type: 'vat_shortfall', title: 'VAT shortfall detected — Q1 2026', message: 'Estimated VAT liability exceeds collected VAT by £1,230.45. Review needed.', severity: 'warning', read: false, createdAt: '2026-04-14T10:30:00Z' },
  { id: 'ntf-008', type: 'system_error', title: 'LeadByte sync failed', message: 'Hourly LeadByte sync failed at 09:00 — connection timeout. Retrying in 15 minutes.', severity: 'error', read: false, createdAt: '2026-04-14T09:05:00Z' },
  { id: 'ntf-009', type: 'invoice_overdue', title: 'Invoice INV-2026-035 overdue', message: 'FastTrack Media invoice of £2,100.00 is 21 days past due. Third chase recommended.', severity: 'warning', read: true, createdAt: '2026-04-13T15:00:00Z' },
  { id: 'ntf-010', type: 'payment_received', title: 'Payment received — NovaTech Solutions', message: 'NovaTech Solutions paid invoice INV-2026-031 (£3,450.00) via Stripe.', severity: 'info', read: true, createdAt: '2026-04-13T11:45:00Z' },
  { id: 'ntf-011', type: 'credit_alert', title: 'New CCJ registered — QuickLeads Ltd', message: 'QuickLeads Ltd has a new CCJ of £8,500 registered. Immediate review recommended.', severity: 'warning', read: false, createdAt: '2026-04-13T09:20:00Z' },
  { id: 'ntf-012', type: 'lead_delivery', title: 'Low lead volume — Home Insurance campaign', message: 'Home Insurance campaign delivered only 12 leads today, 70% below target.', severity: 'info', read: true, createdAt: '2026-04-12T17:30:00Z' },
  { id: 'ntf-013', type: 'workflow_complete', title: 'Credit check batch completed', message: 'Weekly credit check workflow ran for 28 clients. 3 flagged for review.', severity: 'info', read: true, createdAt: '2026-04-12T06:00:00Z' },
  { id: 'ntf-014', type: 'agreement_signed', title: 'Agreement sent — Vertex Partners', message: 'Vertex Partners received their service agreement via SignNow. Awaiting signature.', severity: 'info', read: true, createdAt: '2026-04-11T14:00:00Z' },
  { id: 'ntf-015', type: 'system_error', title: 'Xero webhook delivery failed', message: 'Xero invoice webhook returned 503. 4 invoices pending sync. Auto-retry queued.', severity: 'error', read: true, createdAt: '2026-04-11T11:15:00Z' },
];

let memoryStore: Notification[] = [...mockNotifications];

/**
 * Use DB whenever it's configured. The hardcoded mockNotifications array
 * below is reserved for unit tests that run without a DB — production and
 * dev with a real DATABASE_URL go through Postgres so users see real
 * activity, not the 15 fake "TradeFX / Apex Leads / GreenField" entries.
 *
 * Set USE_DB_NOTIFICATIONS=false to force the mock path (e.g. demo mode).
 */
function useDb(): boolean {
  if (process.env.USE_DB_NOTIFICATIONS === 'false') return false;
  return !!db;
}

export interface ListNotificationsParams {
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface ListNotificationsResult {
  items: Notification[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listNotifications(
  requester: AuthPayload,
  params: ListNotificationsParams = {},
): Promise<ListNotificationsResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.limit ?? 20));
  const offset = (page - 1) * pageSize;

  if (useDb()) {
    const filters = [];
    if (requester.userId) filters.push(eq(notifications.userId, requester.userId));
    if (params.unreadOnly) filters.push(eq(notifications.read, false));
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(whereClause)
        .orderBy(desc(notifications.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(whereClause),
    ]);
    return {
      items: rows.map(normalizeRow),
      total: countResult[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  // In-memory mock path — slice after filtering. Total before slice.
  const sorted = [...memoryStore].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bt - at;
  });
  const filtered = params.unreadOnly ? sorted.filter((n) => !n.read) : sorted;
  return {
    items: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

export async function markAsRead(id: string, requester: AuthPayload): Promise<Notification | null> {
  // Caller's userId is required so we can scope the update — without it any
  // authenticated user could mark anyone else's notifications as read.
  if (!requester.userId) return null;
  if (useDb()) {
    const [row] = await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, requester.userId)))
      .returning();
    return row ? normalizeRow(row) : null;
  }
  const row = memoryStore.find(
    (n) => n.id === id && (!n.userId || n.userId === requester.userId),
  );
  if (!row) return null;
  row.read = true;
  return row;
}

export async function markAllAsRead(requester: AuthPayload): Promise<{ updated: number }> {
  if (!requester.userId) return { updated: 0 };
  if (useDb()) {
    const rows = await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.userId, requester.userId))
      .returning();
    return { updated: rows.length };
  }
  let count = 0;
  for (const n of memoryStore) {
    if (!n.read && (!n.userId || n.userId === requester.userId)) {
      n.read = true;
      count++;
    }
  }
  return { updated: count };
}

/**
 * Create a notification and optionally send a corresponding email.
 * Email is skipped silently when Resend isn't configured.
 */
export async function createNotification(input: CreateNotificationInput): Promise<Notification> {
  let row: Notification;

  if (useDb()) {
    const [inserted] = await db
      .insert(notifications)
      .values({
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        severity: input.severity ?? 'info',
        actionUrl: input.actionUrl,
        metadata: input.metadata,
      })
      .returning();
    row = normalizeRow(inserted);
  } else {
    row = {
      id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      userId: input.userId ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
      severity: input.severity ?? 'info',
      read: false,
      actionUrl: input.actionUrl ?? null,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };
    memoryStore.unshift(row);
  }

  if (input.emailTo && input.emailTemplate) {
    try {
      await sendEmail({
        to: input.emailTo,
        subject: input.emailTemplate.subject,
        html: renderEmailHtml(input.emailTemplate),
        text: renderEmailText(input.emailTemplate),
        tags: [{ name: 'type', value: input.type }],
      });
    } catch (err) {
      logger.error({ err, type: input.type }, 'Notification email failed — notification still saved');
    }
  }

  return row;
}

function normalizeRow(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    title: row.title,
    message: row.message,
    severity: row.severity,
    read: row.read ?? false,
    actionUrl: row.actionUrl,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

// ─── Convenience helpers for common events ───

export const notify = {
  async invoiceOverdue(args: { clientName: string; invoiceNumber: string; amount: string; daysOverdue: number; invoiceUrl: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'invoice_overdue',
      title: `Invoice ${args.invoiceNumber} overdue`,
      message: `${args.clientName}'s invoice of ${args.amount} is ${args.daysOverdue} days past due.`,
      severity: 'warning',
      actionUrl: args.invoiceUrl,
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.invoiceOverdue(args),
    });
  },

  async paymentReceived(args: { clientName: string; invoiceNumber: string; amount: string; method: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'payment_received',
      title: `Payment received — ${args.clientName}`,
      message: `${args.clientName} paid ${args.invoiceNumber} (${args.amount}) via ${args.method}.`,
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.paymentReceived(args),
    });
  },

  async agreementSigned(args: { clientName: string; signedAt: string; agreementUrl: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'agreement_signed',
      title: `Agreement signed — ${args.clientName}`,
      message: `Signed ${args.signedAt}.`,
      actionUrl: args.agreementUrl,
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.agreementSigned(args),
    });
  },

  async creditAlert(args: { clientName: string; oldScore: number; newScore: number; riskRating: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'credit_alert',
      title: `Credit score change — ${args.clientName}`,
      message: `Moved from ${args.oldScore} to ${args.newScore} (${args.riskRating}).`,
      severity: args.newScore < args.oldScore ? 'warning' : 'info',
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.creditAlert(args),
    });
  },

  async workflowComplete(args: { workflowName: string; summary: string; workflowUrl: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'workflow_complete',
      title: `Workflow complete — ${args.workflowName}`,
      message: args.summary,
      actionUrl: args.workflowUrl,
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.workflowComplete(args),
    });
  },

  async vatShortfall(args: { period: string; shortfallAmount: string; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'vat_shortfall',
      title: `VAT shortfall — ${args.period}`,
      message: `Shortfall of ${args.shortfallAmount}. Review needed.`,
      severity: 'warning',
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.vatShortfall(args),
    });
  },

  async leadDeliverySpike(args: { campaignName: string; leadCount: number; pctAboveAverage: number; emailTo?: string; userId?: string }) {
    return createNotification({
      type: 'lead_delivery',
      title: `Lead spike — ${args.campaignName}`,
      message: `${args.leadCount} leads today, ${args.pctAboveAverage}% above daily average.`,
      userId: args.userId,
      emailTo: args.emailTo,
      emailTemplate: templates.leadDeliverySpike(args),
    });
  },
};

// Expose for tests
export const __resetMemoryStore = () => {
  memoryStore = [...mockNotifications];
};
