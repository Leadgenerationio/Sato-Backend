import { Request, Response } from 'express';
import * as activityService from '../services/client-activity.service.js';

export async function listActivity(req: Request, res: Response) {
  const limit = parseInt(req.query.limit as string) || 50;
  const events = await activityService.listClientActivity(req.params.id as string, { limit });
  res.json({ status: 'success', data: { activity: events } });
}
