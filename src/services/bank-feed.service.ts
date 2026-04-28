import { and, desc, eq, ilike, or, sql, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import {
  bankTransactions,
  costCategories,
  vendorCategoryRules,
} from '../db/schema/bank-feed.js';
import * as xeroClient from '../integrations/xero/xero-client.js';
import { logger } from '../utils/logger.js';
import type { AuthPayload } from '../types/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BankTransaction {
  id: string;
  xeroBankTransactionId: string;
  xeroAccountId: string | null;
  date: string;
  amount: string;
  currency: string;
  description: string | null;
  vendorName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryBucket: 'fixed' | 'one_off' | null;
  isAutoCategorized: boolean;
}

export interface CostCategory {
  id: string;
  name: string;
  bucket: 'fixed' | 'one_off';
  color: string | null;
}

export interface VendorRule {
  id: string;
  vendorPattern: string;
  matchType: 'exact' | 'contains';
  categoryId: string;
  categoryName: string;
}

// ─── Categories ──────────────────────────────────────────────────────────────

function requireBusinessId(requester: AuthPayload): string {
  if (!requester.businessId) throw new Error('No business context on this user');
  return requester.businessId;
}

export async function listCategories(requester: AuthPayload): Promise<CostCategory[]> {
  const businessId = requireBusinessId(requester);
  const rows = await db
    .select()
    .from(costCategories)
    .where(eq(costCategories.businessId, businessId))
    .orderBy(costCategories.name);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bucket: r.bucket as CostCategory['bucket'],
    color: r.color,
  }));
}

export async function createCategory(
  requester: AuthPayload,
  data: { name: string; bucket: 'fixed' | 'one_off'; color?: string },
): Promise<CostCategory> {
  const businessId = requireBusinessId(requester);
  const [row] = await db
    .insert(costCategories)
    .values({ businessId, name: data.name, bucket: data.bucket, color: data.color ?? null })
    .returning();
  if (!row) throw new Error('Failed to create category');
  return { id: row.id, name: row.name, bucket: row.bucket as CostCategory['bucket'], color: row.color };
}

export async function deleteCategory(requester: AuthPayload, id: string): Promise<void> {
  const businessId = requireBusinessId(requester);
  await db
    .delete(costCategories)
    .where(and(eq(costCategories.id, id), eq(costCategories.businessId, businessId)));
}

// ─── Vendor rules ────────────────────────────────────────────────────────────

export async function listRules(requester: AuthPayload): Promise<VendorRule[]> {
  const businessId = requireBusinessId(requester);
  const rows = await db
    .select({
      id: vendorCategoryRules.id,
      vendorPattern: vendorCategoryRules.vendorPattern,
      matchType: vendorCategoryRules.matchType,
      categoryId: vendorCategoryRules.categoryId,
      categoryName: costCategories.name,
    })
    .from(vendorCategoryRules)
    .leftJoin(costCategories, eq(costCategories.id, vendorCategoryRules.categoryId))
    .where(eq(vendorCategoryRules.businessId, businessId))
    .orderBy(vendorCategoryRules.vendorPattern);
  return rows.map((r) => ({
    id: r.id,
    vendorPattern: r.vendorPattern,
    matchType: r.matchType as 'exact' | 'contains',
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? '(deleted)',
  }));
}

export async function deleteRule(requester: AuthPayload, id: string): Promise<void> {
  const businessId = requireBusinessId(requester);
  await db
    .delete(vendorCategoryRules)
    .where(and(eq(vendorCategoryRules.id, id), eq(vendorCategoryRules.businessId, businessId)));
}

// ─── Transactions ────────────────────────────────────────────────────────────

export interface ListTransactionsFilters {
  uncategorizedOnly?: boolean;
  categoryId?: string;
  bucket?: 'fixed' | 'one_off';
  search?: string;
  page?: number;
  limit?: number;
}

export async function listTransactions(
  requester: AuthPayload,
  filters: ListTransactionsFilters = {},
): Promise<{ transactions: BankTransaction[]; total: number; page: number; pageSize: number }> {
  const businessId = requireBusinessId(requester);
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;

  const conditions = [eq(bankTransactions.businessId, businessId)];
  if (filters.uncategorizedOnly) conditions.push(isNull(bankTransactions.categoryId));
  if (filters.categoryId) conditions.push(eq(bankTransactions.categoryId, filters.categoryId));
  if (filters.bucket) conditions.push(eq(costCategories.bucket, filters.bucket));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(bankTransactions.vendorName, q),
        ilike(bankTransactions.description, q),
      )!,
    );
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select({
      id: bankTransactions.id,
      xeroBankTransactionId: bankTransactions.xeroBankTransactionId,
      xeroAccountId: bankTransactions.xeroAccountId,
      date: bankTransactions.date,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      description: bankTransactions.description,
      vendorName: bankTransactions.vendorName,
      categoryId: bankTransactions.categoryId,
      categoryName: costCategories.name,
      categoryBucket: costCategories.bucket,
      isAutoCategorized: bankTransactions.isAutoCategorized,
    })
    .from(bankTransactions)
    .leftJoin(costCategories, eq(costCategories.id, bankTransactions.categoryId))
    .where(whereClause)
    .orderBy(desc(bankTransactions.date), desc(bankTransactions.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .leftJoin(costCategories, eq(costCategories.id, bankTransactions.categoryId))
    .where(whereClause);

  return {
    transactions: rows.map((r) => ({
      id: r.id,
      xeroBankTransactionId: r.xeroBankTransactionId,
      xeroAccountId: r.xeroAccountId,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      description: r.description,
      vendorName: r.vendorName,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      categoryBucket: (r.categoryBucket as 'fixed' | 'one_off' | null) ?? null,
      isAutoCategorized: r.isAutoCategorized,
    })),
    total: count ?? 0,
    page,
    pageSize: limit,
  };
}

/**
 * Set the category on a transaction. Optionally:
 *   - learnRule: store a vendor → category rule for future syncs
 *   - applyRetroactively: also categorise existing uncategorised transactions
 *     whose vendorName matches the same rule
 */
export async function categorizeTransaction(
  requester: AuthPayload,
  transactionId: string,
  data: {
    categoryId: string | null; // null = uncategorise
    learnRule?: boolean;
    applyRetroactively?: boolean;
  },
): Promise<void> {
  const businessId = requireBusinessId(requester);

  const [tx] = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.id, transactionId), eq(bankTransactions.businessId, businessId)))
    .limit(1);
  if (!tx) throw new Error('Transaction not found');

  await db
    .update(bankTransactions)
    .set({
      categoryId: data.categoryId,
      isAutoCategorized: false,
      ruleId: null,
      updatedAt: new Date(),
    })
    .where(eq(bankTransactions.id, transactionId));

  if (data.categoryId && data.learnRule && tx.vendorName) {
    const [rule] = await db
      .insert(vendorCategoryRules)
      .values({
        businessId,
        vendorPattern: tx.vendorName,
        matchType: 'contains',
        categoryId: data.categoryId,
        createdBy: requester.userId ?? null,
      })
      .returning();

    if (data.applyRetroactively && rule) {
      await db
        .update(bankTransactions)
        .set({
          categoryId: data.categoryId,
          ruleId: rule.id,
          isAutoCategorized: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankTransactions.businessId, businessId),
            isNull(bankTransactions.categoryId),
            ilike(bankTransactions.vendorName, `%${tx.vendorName}%`),
          ),
        );
    }
  }
}

// ─── Sync from Xero ──────────────────────────────────────────────────────────

interface SyncResult {
  fetched: number;
  inserted: number;
  autoCategorized: number;
  fromDate: string;
  toDate: string;
}

/**
 * Pull bank transactions from Xero for the given date range, upsert by
 * (businessId, xeroBankTransactionId), then auto-apply existing vendor
 * rules to newly-inserted rows.
 *
 * Idempotent: re-running the same range is a no-op (ON CONFLICT DO NOTHING).
 */
export async function syncFromXero(
  requester: AuthPayload,
  fromDate?: string,
  toDate?: string,
): Promise<SyncResult> {
  const businessId = requireBusinessId(requester);
  if (!xeroClient.isXeroConfigured()) {
    throw new Error('Xero not configured');
  }

  // Default range: last 90 days
  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(defaultFrom.getDate() - 90);
  const from = fromDate ?? defaultFrom.toISOString().slice(0, 10);
  const to = toDate ?? today.toISOString().slice(0, 10);

  const xeroTxs = await xeroClient.getBankTransactions(from, to);
  logger.info({ from, to, count: xeroTxs.length }, 'Fetched bank transactions from Xero');

  let inserted = 0;
  for (const t of xeroTxs) {
    const result = await db
      .insert(bankTransactions)
      .values({
        businessId,
        xeroBankTransactionId: t.xeroBankTransactionId,
        xeroAccountId: t.xeroAccountId,
        date: t.date,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        vendorName: t.vendorName,
      })
      .onConflictDoNothing({
        target: [bankTransactions.businessId, bankTransactions.xeroBankTransactionId],
      })
      .returning({ id: bankTransactions.id });
    if (result.length > 0) inserted++;
  }

  // Auto-apply existing vendor rules to newly-inserted (still uncategorised) transactions
  const rules = await db
    .select()
    .from(vendorCategoryRules)
    .where(eq(vendorCategoryRules.businessId, businessId));

  let autoCategorized = 0;
  for (const rule of rules) {
    const pattern = rule.matchType === 'exact'
      ? rule.vendorPattern
      : `%${rule.vendorPattern}%`;
    const updated = await db
      .update(bankTransactions)
      .set({
        categoryId: rule.categoryId,
        ruleId: rule.id,
        isAutoCategorized: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bankTransactions.businessId, businessId),
          isNull(bankTransactions.categoryId),
          rule.matchType === 'exact'
            ? eq(bankTransactions.vendorName, rule.vendorPattern)
            : ilike(bankTransactions.vendorName, pattern),
        ),
      )
      .returning({ id: bankTransactions.id });
    autoCategorized += updated.length;
  }

  return { fetched: xeroTxs.length, inserted, autoCategorized, fromDate: from, toDate: to };
}
