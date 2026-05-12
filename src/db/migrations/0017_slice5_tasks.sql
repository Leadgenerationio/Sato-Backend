-- Slice 5 Day 1 (Sam Loom #86-100). Tasks gain:
--   - subtasks (nested checkbox items)
--   - attachments (R2-backed, metadata in DB)
--   - real activity log (audit feed distinct from the legacy jsonb)
--   - time-block prioritisation (1hr / 2hr buckets)
--   - linked SOP
--   - parent task reference (until a dedicated projects entity arrives)
--   - recurring task config (cron + next-run timestamp watched by worker)
--
-- Idempotent — safe to re-run on every deploy. Non-destructive against
-- existing tasks rows.

-- 1) New columns on tasks
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS time_block_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS linked_sop_id UUID REFERENCES sops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recurrence_cron VARCHAR(100),
  ADD COLUMN IF NOT EXISTS recurrence_next_run TIMESTAMP;

CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS tasks_recurrence_next_idx ON tasks(recurrence_next_run);

-- 2) task_subtasks
CREATE TABLE IF NOT EXISTS task_subtasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_subtasks_task_idx ON task_subtasks(task_id);

-- 3) task_attachments — same shape as client_documents
CREATE TABLE IF NOT EXISTS task_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  r2_key VARCHAR(500) NOT NULL,
  folder VARCHAR(50) NOT NULL DEFAULT 'misc',
  name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes INTEGER,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments(task_id);

-- 4) task_activity_log — append-only event stream for the activity feed
CREATE TABLE IF NOT EXISTS task_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_activity_log_task_idx ON task_activity_log(task_id);
CREATE INDEX IF NOT EXISTS task_activity_log_created_idx ON task_activity_log(task_id, created_at);
