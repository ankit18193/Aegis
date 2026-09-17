import { ListOrdered } from "lucide-react";
import { createBrowserRouter, Navigate } from "react-router-dom";

import { EmptyState } from "../components/ui/EmptyState";
import { RunsLayout } from "../features/runs/components/RunsLayout";

import { App } from "./app";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate to="/runs" replace />,
      },
      {
        path: "runs",
        element: <RunsLayout />,
        children: [
          {
            index: true,
            element: (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon={ListOrdered}
                  title="Select a run to view workspace"
                  description="Choose a run from the sidebar to inspect workflow progression, tasks, activity, and results."
                />
              </div>
            ),
          },
          {
            path: ":runId",
            element: (
              <div
                className="flex-1 p-6 text-foreground-muted text-sm font-mono"
                data-testid="run-workspace-placeholder"
              >
                Run Workspace Loading...
              </div>
            ),
          },
        ],
      },
      {
        path: "*",
        element: <Navigate to="/runs" replace />,
      },
    ],
  },
]);
