CREATE TYPE "public"."billing_workflow" AS ENUM('weekly_auto', 'monthly_validated', 'custom');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('prospect', 'onboarding', 'active', 'paused', 'churned');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('pending', 'documents_received', 'agreement_signed', 'active');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'finance_admin', 'ops_manager', 'client', 'readonly');--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"colour" varchar(7),
	"status" varchar(50) DEFAULT 'active',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "businesses_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"company_number" varchar(20),
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"address" text,
	"currency" varchar(3) DEFAULT 'GBP',
	"payment_terms_days" integer DEFAULT 30,
	"vat_registered" boolean DEFAULT false,
	"add_vat_to_invoices" boolean DEFAULT false,
	"credit_score" integer,
	"credit_last_checked" timestamp,
	"status" "client_status" DEFAULT 'prospect',
	"onboarding_status" "onboarding_status" DEFAULT 'pending',
	"billing_workflow" "billing_workflow" DEFAULT 'weekly_auto',
	"lead_price" numeric(10, 2),
	"lead_price_currency" varchar(3) DEFAULT 'GBP',
	"agreement_signed" boolean DEFAULT false,
	"agreement_document_url" varchar(500),
	"xero_contact_id" varchar(100),
	"leadbyte_client_id" varchar(100),
	"endole_company_id" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'readonly' NOT NULL,
	"business_id" uuid,
	"client_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"notification_preferences" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"leadbyte_campaign_id" varchar(100),
	"name" varchar(255) NOT NULL,
	"vertical" varchar(100),
	"status" varchar(50) DEFAULT 'active',
	"lead_price" numeric(10, 2),
	"currency" varchar(3) DEFAULT 'GBP',
	"total_leads_delivered" integer DEFAULT 0,
	"total_revenue" numeric(12, 2) DEFAULT '0',
	"start_date" timestamp,
	"end_date" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lead_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"delivery_date" date NOT NULL,
	"lead_count" integer DEFAULT 0 NOT NULL,
	"valid_lead_count" integer,
	"invalid_lead_count" integer,
	"revenue" numeric(12, 2),
	"cost" numeric(12, 2),
	"leadbyte_report_id" varchar(100),
	"source" varchar(50) DEFAULT 'leadbyte',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"xero_invoice_id" varchar(100),
	"invoice_number" varchar(50),
	"status" varchar(50) DEFAULT 'draft',
	"currency" varchar(3) DEFAULT 'GBP',
	"subtotal" numeric(12, 2),
	"vat_amount" numeric(12, 2),
	"total" numeric(12, 2),
	"due_date" timestamp,
	"paid_date" timestamp,
	"days_overdue" integer DEFAULT 0,
	"chase_count" integer DEFAULT 0,
	"last_chased_at" timestamp,
	"line_items" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"status" varchar(50) DEFAULT 'running',
	"current_step" integer DEFAULT 1,
	"step_results" jsonb,
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"client_id" uuid,
	"name" varchar(255) NOT NULL,
	"trigger" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'draft',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text,
	"severity" varchar(20) DEFAULT 'info',
	"read" boolean DEFAULT false,
	"action_url" varchar(500),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "credit_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"endole_company_id" varchar(100),
	"credit_score" integer,
	"credit_limit" numeric(12, 2),
	"risk_rating" varchar(50),
	"previous_score" integer,
	"score_change" integer,
	"alert_triggered" boolean DEFAULT false,
	"checked_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "xero_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"access_token" varchar(2000) NOT NULL,
	"refresh_token" varchar(2000) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"tenant_id" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"custom_label" varchar(255),
	"bank_name" varchar(100),
	"account_number" varchar(50),
	"sort_code" varchar(20),
	"currency" varchar(3) DEFAULT 'GBP',
	"current_balance" numeric(14, 2),
	"last_synced_at" timestamp,
	"external_account_id" varchar(100),
	"source" varchar(50) DEFAULT 'manual',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "traffic_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"platform" varchar(100),
	"account_id" varchar(100),
	"campaign_id" uuid,
	"total_spend" numeric(12, 2) DEFAULT '0',
	"total_leads" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"url" varchar(500) NOT NULL,
	"screenshot_url" varchar(500),
	"status" varchar(50) DEFAULT 'active',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"file_url" varchar(500) NOT NULL,
	"type" varchar(50),
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"document_url" varchar(500),
	"signed_by_client" boolean DEFAULT false,
	"signed_by_business" boolean DEFAULT false,
	"signed_at" timestamp,
	"status" varchar(50) DEFAULT 'pending',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chase_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"chase_number" integer NOT NULL,
	"sent_at" timestamp DEFAULT now(),
	"method" varchar(50) NOT NULL,
	"response" text,
	"next_chase_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_deliveries" ADD CONSTRAINT "lead_deliveries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_deliveries" ADD CONSTRAINT "lead_deliveries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_checks" ADD CONSTRAINT "credit_checks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_tokens" ADD CONSTRAINT "xero_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traffic_sources" ADD CONSTRAINT "traffic_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chase_history" ADD CONSTRAINT "chase_history_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_business_idx" ON "clients" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_client_idx" ON "campaigns" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "lead_deliveries_campaign_idx" ON "lead_deliveries" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "lead_deliveries_client_idx" ON "lead_deliveries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "lead_deliveries_date_idx" ON "lead_deliveries" USING btree ("delivery_date");--> statement-breakpoint
CREATE INDEX "invoices_client_idx" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_due_idx" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_checks_client_idx" ON "credit_checks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_business_idx" ON "bank_accounts" USING btree ("business_id");