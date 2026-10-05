ALTER TABLE "tasks" ADD COLUMN "lease_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lease_expired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_lease_until_idx" ON "tasks" USING btree ("status","lease_until");
