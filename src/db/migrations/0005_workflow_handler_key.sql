-- Adds handler_key column so the workflow worker can dispatch real
-- implementations (defined in src/jobs/workflow-handlers.ts) for known
-- workflows like chase-overdue / auto-invoice / monthly-validated.
-- Workflows without a handler_key still run via the generic step loop.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "handler_key" varchar(50);
