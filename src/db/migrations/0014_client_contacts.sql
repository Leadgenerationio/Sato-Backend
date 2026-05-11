-- Slice 1 Day 2: client_contacts table — Sam's Loom #17 ask for multiple
-- contacts per client (primary, billing, compliance + free-form "other"
-- like the National Sales Director he showed in Attio).
--
-- The legacy contact_name / contact_email / contact_phone columns on clients
-- stay populated for back-compat: on create we mirror the primary contact
-- into both places. Old code that reads client.contact_name keeps working
-- while new code reads client_contacts.
--
-- Idempotent: safe to re-run on every deploy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'client_contact_type') THEN
    CREATE TYPE client_contact_type AS ENUM ('primary', 'billing', 'compliance', 'other');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS client_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_type client_contact_type NOT NULL DEFAULT 'other',
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  role VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_contacts_client_idx ON client_contacts(client_id);
CREATE INDEX IF NOT EXISTS client_contacts_type_idx ON client_contacts(client_id, contact_type);
