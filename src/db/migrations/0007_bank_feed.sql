-- Bank-feed categorization (Sam 2026-04-28 product direction).
-- Replaces the static subscriptions concept with bank transactions
-- pulled from Xero, categorised once per vendor.

CREATE TABLE IF NOT EXISTS "cost_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id"),
  "name" varchar(100) NOT NULL,
  "bucket" varchar(20) NOT NULL,
  "color" varchar(20),
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "cost_categories_business_name_unique" UNIQUE ("business_id", "name")
);
CREATE INDEX IF NOT EXISTS "cost_categories_business_idx" ON "cost_categories" ("business_id");

CREATE TABLE IF NOT EXISTS "vendor_category_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id"),
  "vendor_pattern" varchar(255) NOT NULL,
  "match_type" varchar(20) NOT NULL DEFAULT 'contains',
  "category_id" uuid NOT NULL REFERENCES "cost_categories"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vendor_rules_business_idx" ON "vendor_category_rules" ("business_id");
CREATE INDEX IF NOT EXISTS "vendor_rules_pattern_idx" ON "vendor_category_rules" ("vendor_pattern");

CREATE TABLE IF NOT EXISTS "bank_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id"),
  "xero_bank_transaction_id" varchar(50) NOT NULL,
  "xero_account_id" varchar(50),
  "date" date NOT NULL,
  "amount" numeric(14, 2) NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'GBP',
  "description" text,
  "vendor_name" varchar(255),
  "category_id" uuid REFERENCES "cost_categories"("id") ON DELETE SET NULL,
  "rule_id" uuid REFERENCES "vendor_category_rules"("id") ON DELETE SET NULL,
  "is_auto_categorized" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "bank_tx_business_xero_unique" UNIQUE ("business_id", "xero_bank_transaction_id")
);
CREATE INDEX IF NOT EXISTS "bank_tx_business_idx" ON "bank_transactions" ("business_id");
CREATE INDEX IF NOT EXISTS "bank_tx_date_idx" ON "bank_transactions" ("date");
CREATE INDEX IF NOT EXISTS "bank_tx_category_idx" ON "bank_transactions" ("category_id");
