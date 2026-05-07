-- Asset approval audit trail (Roadmap C — solicitor compliance).
--
-- Append-only log of every approve/reject decision a client makes on a
-- creative asset. The current state of a creative is the most recent row
-- (no row = pending). Required by Sam's solicitor firm for legal evidence
-- when an ad's compliance is later disputed: IP, UA, timestamp, user-id
-- are all captured at decision time.
--
-- Idempotent: safe to re-run on every deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'creative_approval_action') THEN
    CREATE TYPE creative_approval_action AS ENUM ('approved', 'rejected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS creative_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id uuid NOT NULL REFERENCES creatives(id),
  action creative_approval_action NOT NULL,
  decided_by_user_id uuid NOT NULL REFERENCES users(id),
  ip_address varchar(45),
  user_agent varchar(500),
  feedback text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_approvals_creative_idx ON creative_approvals(creative_id);
CREATE INDEX IF NOT EXISTS creative_approvals_created_at_idx ON creative_approvals(created_at);
