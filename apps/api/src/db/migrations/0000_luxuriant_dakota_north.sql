CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"task_id" text,
	"task_name" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"goal" text NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"output" text,
	"error" text,
	"dependencies" jsonb
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run_id_timestamp_idx" ON "run_events" USING btree ("run_id","timestamp");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_created_at_idx" ON "runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_run_id_idx" ON "tasks" USING btree ("run_id");