CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_status_created_at_idx" ON "outbox_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_status_locked_until_idx" ON "outbox_events" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");
