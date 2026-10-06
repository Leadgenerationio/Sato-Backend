import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** One id per request, echoed in X-Request-Id and in every error body so a
 *  bot's failure can be matched to the log and audit row. A caller's own id
 *  is kept when it is short and plain. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const given = req.get('x-request-id');
  const id = given && /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
