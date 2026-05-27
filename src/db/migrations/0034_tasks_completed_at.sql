-- Sam-Loom feedback (jam-video #7, 2026-05-27): "completed tasks will
-- just end up getting too many of them, but also we want to keep them
-- in an archive really". Adds a completed_at column so the list view can
-- hide older completed tasks behind an "Archive" toggle by default
-- (show today's completions inline, everything else in the archive view).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + safe backfill.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- Backfill: any task already at status='completed' gets its completion
-- timestamp set to updated_at (best-effort approximation). Future status
-- transitions are written by the service layer, so this one-time backfill
-- only catches the historical rows.
UPDATE tasks
SET completed_at = updated_at
WHERE status = 'completed' AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_completed_at_idx ON tasks(completed_at);
