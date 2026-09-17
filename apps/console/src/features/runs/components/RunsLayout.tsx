import { Menu, X } from "lucide-react";
import * as React from "react";
import { Outlet, useParams } from "react-router-dom";

import { useRuns } from "../hooks/useRuns";

import { RunsSidebar } from "./RunsSidebar";

export const RunsLayout: React.FC = () => {
  const { runs, isLoading } = useRuns();
  const { runId } = useParams<{ runId: string }>();
  const [mobileDrawerOpen, setMobileDrawerOpen] = React.useState(false);

  const closeMobileDrawer = React.useCallback(() => {
    setMobileDrawerOpen(false);
  }, []);

  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
      {/* Mobile Top Navigation Sub-bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-2 border-b border-border bg-surface shrink-0 z-10 select-none">
        <button
          type="button"
          onClick={() => { setMobileDrawerOpen(true); }}
          className="flex items-center gap-2 text-xs font-mono text-foreground hover:text-white px-2 py-1 rounded bg-surface-raised border border-border-subtle"
          data-testid="mobile-sidebar-toggle"
          aria-label="Open runs list"
        >
          <Menu className="w-3.5 h-3.5 text-accent" />
          <span>Runs ({runs.length.toString()})</span>
        </button>

        {runId ? (
          <span className="text-xs font-mono text-foreground-muted truncate max-w-[200px]">
            {runId}
          </span>
        ) : null}
      </div>

      {/* Desktop Permanent Sidebar */}
      <div className="hidden md:flex shrink-0 h-full">
        <RunsSidebar runs={runs} isLoading={isLoading} />
      </div>

      {/* Mobile Drawer Backdrop & Sidebar */}
      {mobileDrawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-sm"
            onClick={closeMobileDrawer}
            aria-hidden="true"
          />
          <div className="relative z-50 flex flex-col h-full shadow-2xl">
            <div className="absolute top-2 right-2 z-50">
              <button
                type="button"
                onClick={closeMobileDrawer}
                className="p-1.5 rounded bg-surface border border-border text-foreground-muted hover:text-foreground"
                aria-label="Close runs drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <RunsSidebar
              runs={runs}
              isLoading={isLoading}
              onSelectRun={closeMobileDrawer}
            />
          </div>
        </div>
      ) : null}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-y-auto bg-background min-w-0">
        <Outlet />
      </div>
    </div>
  );
};

