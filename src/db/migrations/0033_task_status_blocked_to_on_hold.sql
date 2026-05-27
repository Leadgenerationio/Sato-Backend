-- Sam-Loom feedback (jam-video #9, 2026-05-27): rename task status
-- "blocked" to "on_hold" so the Kanban column matches the language Sam
-- uses ("I think we blocked there, but it was called on hold").
--
-- tasks.status is a varchar (not a Postgres enum), so the column itself
-- needs no schema change — only a data update so existing rows display
-- the new label. Idempotent: re-running on an already-migrated DB
-- updates 0 rows.

UPDATE tasks
SET status = 'on_hold'
WHERE status = 'blocked';
