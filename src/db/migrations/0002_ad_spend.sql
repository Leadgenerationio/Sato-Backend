CREATE TABLE "ad_spend" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(50) NOT NULL,
	"authorization_id" integer NOT NULL,
	"account_id" varchar(100) NOT NULL,
	"account_name" varchar(255),
	"campaign_id" varchar(100) DEFAULT '' NOT NULL,
	"campaign_name" varchar(500),
	"date" date NOT NULL,
	"spend" numeric(14, 6) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'GBP' NOT NULL,
	"client_id" uuid,
	"stato_campaign_id" uuid,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_stato_campaign_id_campaigns_id_fk" FOREIGN KEY ("stato_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_unique_idx" ON "ad_spend" USING btree ("platform","authorization_id","account_id","campaign_id","date");--> statement-breakpoint
CREATE INDEX "ad_spend_date_idx" ON "ad_spend" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ad_spend_client_idx" ON "ad_spend" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ad_spend_platform_idx" ON "ad_spend" USING btree ("platform");
