import { Request, Response } from 'express';
import * as bankFeed from '../services/bank-feed.service.js';
import { classifyXeroError } from '../utils/xero-errors.js';
import { logger } from '../utils/logger.js';

export async function listTransactions(req: Request, res: Response) {
  const result = await bankFeed.listTransactions(req.user!, {
    uncategorizedOnly: req.query.uncategorized === 'true',
    categoryId: typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined,
    bucket: req.query.bucket === 'fixed' || req.query.bucket === 'one_off' ? req.query.bucket : undefined,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ status: 'success', data: result });
}

export async function categorizeTransaction(req: Request, res: Response) {
  const { categoryId, learnRule, applyRetroactively } = req.body ?? {};
  await bankFeed.categorizeTransaction(req.user!, req.params.id as string, {
    categoryId: categoryId ?? null,
    learnRule: !!learnRule,
    applyRetroactively: !!applyRetroactively,
  });
  res.json({ status: 'success', data: { ok: true } });
}

export async function listCategories(req: Request, res: Response) {
  const categories = await bankFeed.listCategories(req.user!);
  res.json({ status: 'success', data: { categories } });
}

export async function createCategory(req: Request, res: Response) {
  const { name, bucket, color } = req.body ?? {};
  if (!name || (bucket !== 'fixed' && bucket !== 'one_off')) {
    res.status(400).json({ status: 'error', message: 'name and bucket (fixed|one_off) required' });
    return;
  }
  const category = await bankFeed.createCategory(req.user!, { name, bucket, color });
  res.status(201).json({ status: 'success', data: { category } });
}

export async function deleteCategory(req: Request, res: Response) {
  await bankFeed.deleteCategory(req.user!, req.params.id as string);
  res.json({ status: 'success', data: { ok: true } });
}

export async function listRules(req: Request, res: Response) {
  const rules = await bankFeed.listRules(req.user!);
  res.json({ status: 'success', data: { rules } });
}

export async function deleteRule(req: Request, res: Response) {
  await bankFeed.deleteRule(req.user!, req.params.id as string);
  res.json({ status: 'success', data: { ok: true } });
}

export async function syncNow(req: Request, res: Response) {
  const { fromDate, toDate } = req.body ?? {};
  try {
    const result = await bankFeed.syncFromXero(req.user!, fromDate, toDate);
    bankFeed.recordBankFeedSync(new Date().toISOString());
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error({ err }, 'Bank-feed sync failed');
    const classified = classifyXeroError(err);
    res.status(classified.httpStatus).json({
      status: 'error',
      code: classified.code,
      message: classified.message,
    });
  }
}

export async function syncStatus(_req: Request, res: Response) {
  res.json({
    status: 'success',
    data: {
      lastSyncAt: bankFeed.getLastBankFeedSyncAt(),
    },
  });
}
