-- Sam (2026-06-17): "Add option to remove the user as well" on the Portal
-- Users card. Permanently deleting a portal-user login must NOT destroy the
-- creative-approval audit records (a solicitor may need to prove who approved
-- an advert) or hit an FK RESTRICT. So:
--   - creative_approvals.decided_by_user_id becomes nullable + ON DELETE SET
--     NULL — the approval ROW survives (and creatives.status, the current-state
--     source of truth, is untouched); only the "who" pointer is nulled.
--   - notifications are personal to the user, so they cascade-delete.
-- Idempotent / safe to re-run.

ALTER TABLE creative_approvals ALTER COLUMN decided_by_user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE creative_approvals DROP CONSTRAINT IF EXISTS creative_approvals_decided_by_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE creative_approvals ADD CONSTRAINT creative_approvals_decided_by_user_id_users_id_fk FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
