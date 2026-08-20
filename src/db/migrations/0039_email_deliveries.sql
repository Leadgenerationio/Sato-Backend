-- Sam (2026-08-20): "Barry at media-active.org.uk hasn't received his welcome
-- email" — but the Railway logs showed Resend ACCEPTED the send twice and
-- returned message ids. We had no way to tell "Resend took it" from "it
-- reached the inbox", so a silently quarantined invite looked identical to a
-- successful one in the UI.
--
-- This table is the delivery ledger: one row per outbound Resend message,
-- keyed on the Resend message id, updated in place by the
-- POST /api/v1/webhooks/resend handler as delivery events arrive.
CREATE TABLE IF NOT EXISTS email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Resend's message id. Unique so webhook replays are idempotent.
  message_id varchar(255) NOT NULL,
  to_address varchar(255) NOT NULL,
  from_address varchar(255),
  subject varchar(500),
  -- Coarse label for what produced this send ('portal_welcome',
  -- 'password_reset', 'notification', …) so we can filter invite failures
  -- without string-matching subjects.
  kind varchar(50),
  -- Highest-ranked state seen so far (see EVENT_RANK in the service).
  -- Never moves backwards, so a late 'email.sent' webhook cannot clobber a
  -- 'delivered' we already recorded.
  status varchar(30) NOT NULL DEFAULT 'sent',
  last_event varchar(50),
  -- Populated on bounce/complaint so the UI can explain WHY, not just fail.
  failure_type varchar(50),
  failure_reason text,
  sent_at timestamp NOT NULL DEFAULT now(),
  last_event_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS email_deliveries_message_id_idx ON email_deliveries (message_id);
--> statement-breakpoint
-- Lookup path for "what happened to this user's invite?" — newest first.
CREATE INDEX IF NOT EXISTS email_deliveries_to_address_idx ON email_deliveries (to_address, sent_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_deliveries_status_idx ON email_deliveries (status);
