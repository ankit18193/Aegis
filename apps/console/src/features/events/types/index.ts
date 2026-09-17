export type EventType =
  | "run_created"
  | "workflow_started"
  | "task_scheduled"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "tool_invoked"
  | "run_completed"
  | "run_failed"
  | "run_cancelled";

export type EventSeverity = "info" | "warn" | "error" | "success";

export interface RunEvent {
  id: string;
  runId: string;
  type: EventType;
  severity: EventSeverity;
  timestamp: string;
  message: string;
  taskId?: string;
  taskName?: string;
  worker?: string;
  metadata?: Record<string, unknown>;
}
