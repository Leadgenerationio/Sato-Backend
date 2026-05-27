-- Sam (2026-05-27 portal meeting): "Client_admin should be able to do this,
-- not Sam. Everything is in client portal." Introduces a client_admin sub-
-- role inside role=client so a client's own admin can manage their portal
-- users + mark agreements signed-externally without Sam being the bottleneck.
--
-- Idempotent. Safe to re-run.

-- 1. Extend the role enum. ADD VALUE IF NOT EXISTS keeps re-runs safe.
--    MUST commit before the UPDATE below references the new value — Postgres
--    rejects "unsafe use of new value" of an enum within the same transaction.
--    The statement-breakpoint marker tells auto-migrate to split the file into
--    two separate sql.unsafe() calls so the ALTER TYPE commits first.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'client_admin';
--> statement-breakpoint

-- 2. Auto-promote: for each existing client, mark the EARLIEST-created
--    client user as client_admin so day-1 self-service works without
--    Sam touching anything. If a client somehow has zero portal users,
--    this updates nothing for them (the first user added next gets
--    promoted by the BE service layer on insert).
--
--    A client with multiple portal users only sees the earliest one
--    promoted — Sam can then promote others manually from the admin
--    Portal Users card.
UPDATE users u
SET role = 'client_admin'
WHERE u.id IN (
  SELECT DISTINCT ON (client_id) id
  FROM users
  WHERE role = 'client'
    AND client_id IS NOT NULL
  ORDER BY client_id, created_at ASC
);
