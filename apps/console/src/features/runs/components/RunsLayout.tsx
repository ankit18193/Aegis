import * as React from "react";
import { Outlet } from "react-router-dom";

import type { RunListItem } from "../types";

import { RunsSidebar } from "./RunsSidebar";

// Temporary initial list items to establish sidebar navigation
const INITIAL_PREVIEW_RUNS: RunListItem[] = [
  {
    id: "run-001",
    goal: "Analyze repository performance bottlenecks and optimize database queries",
    status: "running",
    progress: 60,
    totalTasks: 5,
    completedTasks: 3,
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "run-002",
    goal: "Automated vulnerability scan across package dependencies and lockfiles",
    status: "completed",
    progress: 100,
    totalTasks: 4,
    completedTasks: 4,
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 95).toISOString(),
  },
  {
    id: "run-003",
    goal: "Audit architectural invariants and package boundaries in monorepo",
    status: "failed",
    progress: 40,
    totalTasks: 5,
    completedTasks: 2,
    createdAt: new Date(Date.now() - 1000 * 60 * 360).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 340).toISOString(),
  },
];

export interface RunsLayoutProps {
  runs?: RunListItem[];
  isLoading?: boolean;
}

export const RunsLayout: React.FC<RunsLayoutProps> = ({
  runs = INITIAL_PREVIEW_RUNS,
  isLoading = false,
}) => {
  return (
    <div className="flex-1 flex overflow-hidden">
      <RunsSidebar runs={runs} isLoading={isLoading} />
      <div className="flex-1 flex flex-col overflow-y-auto bg-background">
        <Outlet />
      </div>
    </div>
  );
};
