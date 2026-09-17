export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "cancelled";

export interface TaskSummary {
  id: string;
  name: string;
  status: TaskStatus;
  description: string;
  worker?: string;
  startedAt?: string;
  completedAt?: string;
  attemptCount: number;
  output?: string;
  error?: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  tasks: TaskSummary[];
}

export interface RunResultArtifact {
  name: string;
  type: string;
  path: string;
  sizeBytes?: number;
}

export interface RunResult {
  summary: string;
  reportMarkdown?: string;
  metrics?: {
    durationMs: number;
    tasksTotal: number;
    tasksCompleted: number;
    toolInvocations: number;
  };
  artifacts?: RunResultArtifact[];
}

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  progress: number; // 0 to 100
  workflow: WorkflowSummary;
  tasks: TaskSummary[];
  result?: RunResult;
}

export interface RunListItem {
  id: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  totalTasks: number;
  completedTasks: number;
}
