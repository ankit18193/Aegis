ALTER TABLE "outbox_events" ADD COLUMN "topic" text;--> statement-breakpoint
CREATE INDEX "tasks_orphan_recovery_idx" ON "tasks" USING btree ("status","lease_expired_at");
