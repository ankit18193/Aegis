import { Shield, Plus } from "lucide-react";
import * as React from "react";
import { Outlet, Link } from "react-router-dom";

import { Button } from "../components/ui/Button";

export interface AppProps {
  onNewRunClick?: () => void;
}

export const App: React.FC<AppProps> = ({ onNewRunClick }) => {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground selection:bg-accent selection:text-white">
      {/* Top Console Navigation Bar */}
      <header className="h-12 border-b border-border px-4 flex items-center justify-between bg-surface shrink-0 z-20">
        <div className="flex items-center gap-3">
          <Link
            to="/runs"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground hover:text-white transition-colors"
          >
            <div className="w-6 h-6 rounded bg-accent/20 border border-accent/40 flex items-center justify-center text-accent">
              <Shield className="w-3.5 h-3.5" />
            </div>
            <span>Aegis</span>
          </Link>
          <span className="text-border-subtle">/</span>
          <span className="text-xs text-foreground-muted font-mono bg-surface-raised px-2 py-0.5 rounded border border-border-subtle">
            Console
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={onNewRunClick}
            data-testid="new-run-header-btn"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Run</span>
          </Button>
        </div>
      </header>

      {/* Main Workspace Slot */}
      <main className="flex-1 flex overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
};
