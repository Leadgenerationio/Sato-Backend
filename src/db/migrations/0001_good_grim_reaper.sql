ALTER TABLE "campaigns" ADD COLUMN "campaign_type" varchar(30) DEFAULT 'pay_per_lead';--> statement-breakpoint
ALTER TABLE "traffic_sources" ADD COLUMN "catchr_url" text;--> statement-breakpoint
ALTER TABLE "traffic_sources" ADD COLUMN "is_active" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "docusign_envelope_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "signer_email" varchar(255);--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "signer_name" varchar(255);--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "declined_at" timestamp;--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "declined_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "pdf_r2_key" varchar(500);--> statement-breakpoint
CREATE INDEX "traffic_sources_campaign_idx" ON "traffic_sources" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "agreements_client_idx" ON "agreements" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "agreements_envelope_idx" ON "agreements" USING btree ("docusign_envelope_id");