-- Move SOPs, tasks, staff (+ HR), workflows, and traffic-sources from
-- in-memory mock arrays to real Postgres tables. Workflows + traffic_sources
-- already had a placeholder schema (migration 0001) but weren't used by their
-- services; this adds the missing columns the services need.

-- ─── SOPs ─────────────────────────────────────────────────────────────
CREATE TABLE "sops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"title" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"category" varchar(50) DEFAULT 'Operations' NOT NULL,
	"version" varchar(20) DEFAULT '1.0' NOT NULL,
	"author" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "sops" ADD CONSTRAINT "sops_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sops_business_idx" ON "sops" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sops_category_idx" ON "sops" USING btree ("category");--> statement-breakpoint

-- ─── Tasks ────────────────────────────────────────────────────────────
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"title" varchar(255) NOT NULL,
	"description" text DEFAULT '',
	"assignee" varchar(255) DEFAULT '',
	"priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"status" varchar(20) DEFAULT 'todo' NOT NULL,
	"category" varchar(50) DEFAULT 'general',
	"created_by" varchar(255) NOT NULL,
	"due_date" timestamp,
	"audit_log" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_business_idx" ON "tasks" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee");--> statement-breakpoint

CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author" varchar(255) NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint

CREATE TABLE "task_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '',
	"default_priority" varchar(20) DEFAULT 'medium' NOT NULL,
	"default_category" varchar(50) DEFAULT 'general',
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── Staff & HR ───────────────────────────────────────────────────────
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(100) DEFAULT 'Employee' NOT NULL,
	"department" varchar(100) DEFAULT 'Operations' NOT NULL,
	"start_date" date DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"holidays_remaining" integer DEFAULT 25 NOT NULL,
	"holidays_taken" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_business_idx" ON "staff" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "staff_status_idx" ON "staff" USING btree ("status");--> statement-breakpoint

CREATE TABLE "job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"title" varchar(255) NOT NULL,
	"department" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"posted_date" date DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_postings_business_idx" ON "job_postings" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "job_postings_status_idx" ON "job_postings" USING btree ("status");--> statement-breakpoint

CREATE TABLE "applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"stage" varchar(20) DEFAULT 'applied' NOT NULL,
	"applied_date" date DEFAULT now() NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_job_id_job_postings_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applicants_job_idx" ON "applicants" USING btree ("job_id");--> statement-breakpoint

CREATE TABLE "holiday_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"type" varchar(20) DEFAULT 'annual' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"approved_by" varchar(255),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "holiday_requests" ADD CONSTRAINT "holiday_requests_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holiday_requests_staff_idx" ON "holiday_requests" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "holiday_requests_status_idx" ON "holiday_requests" USING btree ("status");--> statement-breakpoint

-- ─── Workflows: extra columns the service needs ───────────────────────
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "description" text DEFAULT '';--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "type" varchar(30) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "schedule" varchar(100);--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "next_run_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "total_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "success_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Make trigger nullable + steps default to empty array so workflows can be drafts
ALTER TABLE "workflows" ALTER COLUMN "trigger" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "steps" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_business_idx" ON "workflows" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflows_status_idx" ON "workflows" USING btree ("status");--> statement-breakpoint

-- ─── Workflow executions: extra columns ───────────────────────────────
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "steps_completed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "steps_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "result" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_executions_workflow_idx" ON "workflow_executions" USING btree ("workflow_id");--> statement-breakpoint

-- ─── Traffic sources: tighten existing schema ─────────────────────────
ALTER TABLE "traffic_sources" ALTER COLUMN "is_active" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "traffic_sources" ALTER COLUMN "total_spend" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "traffic_sources" ALTER COLUMN "total_leads" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "traffic_sources_active_idx" ON "traffic_sources" USING btree ("is_active");
