import * as React from "react";
import { Outlet } from "react-router-dom";

import { useRuns } from "../hooks/useRuns";

import { RunsSidebar } from "./RunsSidebar";

export const RunsLayout: React.FC = () => {
  const { runs, isLoading } = useRuns();

  return (
    <div className="flex-1 flex overflow-hidden">
      <RunsSidebar runs={runs} isLoading={isLoading} />
      <div className="flex-1 flex flex-col overflow-y-auto bg-background">
        <Outlet />
      </div>
    </div>
  );
};
