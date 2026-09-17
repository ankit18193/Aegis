import { createBrowserRouter, Navigate } from "react-router-dom";

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
        element: (
          <div className="flex-1 flex items-center justify-center p-8 text-foreground-muted text-sm font-mono" data-testid="runs-index">
            Select a run or create a new one to get started.
          </div>
        ),
      },
      {
        path: "runs/:runId",
        element: (
          <div className="flex-1 p-6 text-foreground-muted text-sm font-mono" data-testid="run-workspace-placeholder">
            Run Workspace Loading...
          </div>
        ),
      },
      {
        path: "*",
        element: <Navigate to="/runs" replace />,
      },
    ],
  },
]);
