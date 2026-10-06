import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';

export function validate(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));
        // `errors` is what the portal reads; code/fields/requestId are the
        // public API error shape (MCP spec v1.0 §3). Field paths drop the
        // body./query./params. prefix so they name the caller's own fields.
        res.status(400).json({
          status: 'error',
          code: 'validation_failed',
          message: 'Validation failed',
          hint: errors[0] ? `${errors[0].path}: ${errors[0].message}` : null,
          fields: [...new Set(error.issues.map((e) => e.path.slice(1).join('.') || e.path.join('.')).filter(Boolean))],
          retryable: false,
          requestId: req.requestId ?? null,
          errors,
        });
        return;
      }
      next(error);
    }
  };
}
