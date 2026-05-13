import { Request, Response } from 'express';
import * as importService from '../services/client-import.service.js';
import { AttioNotConfiguredError } from '../integrations/attio/attio-client.js';
import { logger } from '../utils/logger.js';

function handleAttioError(err: unknown, res: Response): boolean {
  if (err instanceof AttioNotConfiguredError) {
    res.status(503).json({
      status: 'error',
      message: 'Attio import is not configured. Add ATTIO_API_KEY to the backend environment.',
    });
    return true;
  }
  return false;
}

export async function browseAttio(req: Request, res: Response) {
  try {
    const search = (req.query.search as string) || undefined;
    const cursor = (req.query.cursor as string) || undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const result = await importService.browseAttioCompanies(
      { search, cursor, limit },
      req.user!,
    );
    res.json({ status: 'success', data: result });
  } catch (err) {
    if (handleAttioError(err, res)) return;
    logger.error({ err }, 'Attio browse failed');
    res.status(502).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'Failed to reach Attio',
    });
  }
}

export async function importFromAttio(req: Request, res: Response) {
  const { attioIds } = req.body ?? {};
  if (!Array.isArray(attioIds) || attioIds.length === 0) {
    res.status(400).json({ status: 'error', message: 'attioIds (non-empty array) is required' });
    return;
  }
  if (!attioIds.every((v) => typeof v === 'string' && v.length > 0)) {
    res.status(400).json({ status: 'error', message: 'attioIds must be a list of non-empty strings' });
    return;
  }
  try {
    const result = await importService.importAttioCompanies(attioIds, req.user!);
    res.json({ status: 'success', data: result });
  } catch (err) {
    if (handleAttioError(err, res)) return;
    if (err instanceof Error && err.message.includes('200 companies')) {
      res.status(400).json({ status: 'error', message: err.message });
      return;
    }
    logger.error({ err }, 'Attio import failed');
    res.status(502).json({
      status: 'error',
      message: err instanceof Error ? err.message : 'Failed to import from Attio',
    });
  }
}
