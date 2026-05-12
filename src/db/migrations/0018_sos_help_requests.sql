-- Slice 5 Day 6 (Sam Loom #100). SOS help button: a floating "I need help"
-- shortcut that opens WhatsApp pre-filled to Sam AND logs the request server-
-- side so Sam can see who's struggling without depending on the user
-- actually hitting "send" in WhatsApp.
--
-- Idempotent — safe to re-run on every deploy.

CREATE TABLE IF NOT EXISTS sos_help_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  page_path     VARCHAR(500),
  message       TEXT,
  resolved_at   TIMESTAMP,
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sos_help_user_idx ON sos_help_requests(user_id);
CREATE INDEX IF NOT EXISTS sos_help_created_idx ON sos_help_requests(created_at);
