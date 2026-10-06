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
        // `errors` is what the portal reads. code / fields / requestId are the
        // shared API error shape (spec section 3); field paths drop the
        // body. / query. / params. prefix so they name the caller's own fields.
        const seen = new Set<string>();
        const fields = error.issues.flatMap((e) => {
          const field = (e.path.length > 1 ? e.path.slice(1) : e.path).join('.');
          if (!field || seen.has(field)) return [];
          seen.add(field);
          return [{ field, message: e.message }];
        });
        res.status(400).json({
          status: 'error',
          code: 'validation_failed',
          message: 'Validation failed',
          hint: errors[0] ? `${fields[0]?.field ?? errors[0].path}: ${errors[0].message}` : undefined,
          fields,
          retryable: false,
          ...(res.locals.requestId ? { requestId: res.locals.requestId } : {}),
          errors,
        });
        return;
      }
      next(error);
    }
  };
}
