ALTER TABLE "tasks" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_run_id_status_idx" ON "tasks" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "tasks_worker_id_idx" ON "tasks" USING btree ("worker_id");