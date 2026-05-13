-- 0025_sms_alerts.sql
-- Adds SMS-alert tracking columns to notifications so the alert-sms worker
-- can identify which system_error rows still need to be paged out to Sam
-- without re-sending ones already delivered.
--
-- Idempotent: every statement uses IF NOT EXISTS so this is safe to re-run
-- after partial failures.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS sms_notified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS sms_attempts SMALLINT NOT NULL DEFAULT 0;

-- Partial index: only rows that are still candidates for an alert. At scale,
-- almost every row is already notified, so this index is tiny and the
-- worker's SELECT can use an index scan instead of a seq scan.
CREATE INDEX IF NOT EXISTS notifications_sms_pending_idx
  ON notifications (created_at)
  WHERE type = 'system_error'
    AND sms_notified_at IS NULL
    AND sms_attempts < 5;
