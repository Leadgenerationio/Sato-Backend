-- L #33 (full email-thread integration) + L #38 (full activity feed).
-- Two new tables scoped to a client.
--
-- client_activity_log: append-only event stream — one row per "thing
--   that happened to this client" (document uploaded, agreement signed,
--   credit check run, etc.). The client detail Activity tab reads this
--   directly instead of unioning queries across N modules.
--
-- client_emails: per-client email thread (inbound + outbound). Outbound
--   rows are auto-logged when Resend sends; inbound rows are entered
--   manually by an internal user via the UI for now.
--
-- Idempotent — safe to re-run on every deploy.

CREATE TABLE IF NOT EXISTS client_activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type      VARCHAR(60) NOT NULL,
  payload         JSONB,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_activity_client_idx ON client_activity_log(client_id, created_at);
CREATE INDEX IF NOT EXISTS client_activity_event_idx ON client_activity_log(event_type);

CREATE TABLE IF NOT EXISTS client_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  direction       VARCHAR(10) NOT NULL,
  subject         VARCHAR(500),
  body            TEXT,
  from_address    VARCHAR(255),
  to_address      VARCHAR(255),
  message_id      VARCHAR(255),
  resend_event    VARCHAR(50),
  occurred_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  logged_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_emails_client_idx ON client_emails(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS client_emails_direction_idx ON client_emails(direction);
