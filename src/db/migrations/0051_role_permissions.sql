-- Sam feedback round 1 (29 Sep 2026, S7): the Role Access Matrix lived in an
-- in-memory array — every edit reset on restart, nothing on the server read
-- it, and the menu ignored it. This table persists it per business, keyed by
-- menu section (see src/config/sections.ts).
--
-- Only explicit choices are stored. No row = allowed, so on deploy every role
-- keeps exactly the access it has today (the route guards). The matrix can
-- only switch a role OFF within a section's floor; it can never grant beyond
-- the requireRole() guard, and Owner is never stored (always allowed).
CREATE TABLE IF NOT EXISTS role_permissions (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  section varchar(50) NOT NULL,
  role user_role NOT NULL,
  allowed boolean NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, section, role)
);
--> statement-breakpoint
-- Append-only audit of every matrix change (who, when, before → after).
CREATE TABLE IF NOT EXISTS role_permission_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  section varchar(50) NOT NULL,
  role user_role NOT NULL,
  allowed_before boolean NOT NULL,
  allowed_after boolean NOT NULL,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS role_permission_changes_business_idx ON role_permission_changes (business_id, changed_at DESC);
