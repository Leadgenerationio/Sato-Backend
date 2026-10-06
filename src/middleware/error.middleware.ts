import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { buildErrorBody } from '../utils/error-body.js';
import { logger } from '../utils/logger.js';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const requestId = res.locals.requestId as string | undefined;
  if (!(err instanceof AppError)) logger.error({ err, requestId }, 'Unhandled error');
  const { status, body } = buildErrorBody(err, requestId);
  res.status(status).json(body);
}
