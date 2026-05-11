-- Slice 1 Day 3: client_documents table — Sam's Loom #36 ask. The Documents
-- tab on the client page was using browser localStorage, which means files
-- only show on the browser/account that uploaded them and disappear when
-- cache is cleared. This table persists metadata centrally; the actual file
-- bytes stay in R2.
--
-- Idempotent: safe to re-run on every deploy.

CREATE TABLE IF NOT EXISTS client_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  r2_key VARCHAR(500) NOT NULL,
  folder VARCHAR(50) NOT NULL DEFAULT 'misc',
  name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes INTEGER,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_documents_client_idx ON client_documents(client_id);
