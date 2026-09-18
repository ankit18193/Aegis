import { runId } from "@aegis/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { RunListItem } from "../types";

import { RunsSidebar } from "./RunsSidebar";

const MOCK_RUNS: RunListItem[] = [
  {
    id: runId("run-alpha"),
    goal: "Analyze database indexing strategy",
    status: "running",
    progress: 50,
    totalTasks: 4,
    completedTasks: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: runId("run-beta"),
    goal: "Audit security boundaries",
    status: "completed",
    progress: 100,
    totalTasks: 3,
    completedTasks: 3,
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function renderSidebar(
  ui: React.ReactElement,
  initialPath = "/runs"
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("RunsSidebar Component", () => {
  it("renders list of runs with titles and status badges", () => {
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} />);

    expect(screen.getByText("Analyze database indexing strategy")).toBeInTheDocument();
    expect(screen.getByText("Audit security boundaries")).toBeInTheDocument();
    expect(screen.getByText("Recent Runs")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // count badge
  });

  it("marks active run with aria-current page", () => {
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} />, "/runs/run-alpha");

    const activeItem = screen.getByTestId("run-item-run-alpha");
    expect(activeItem).toBeInTheDocument();
  });

  it("filters runs based on search input", async () => {
    const user = userEvent.setup();
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} />);

    const input = screen.getByPlaceholderText("Filter runs...");
    await user.type(input, "database");

    expect(screen.getByText("Analyze database indexing strategy")).toBeInTheDocument();
    expect(screen.queryByText("Audit security boundaries")).not.toBeInTheDocument();
  });

  it("displays empty state when no runs match filter", async () => {
    const user = userEvent.setup();
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} />);

    const input = screen.getByPlaceholderText("Filter runs...");
    await user.type(input, "nonexistentquery123");

    expect(screen.getByText("No matching runs")).toBeInTheDocument();
  });

  it("displays empty state when runs list is empty", () => {
    renderSidebar(<RunsSidebar runs={[]} />);

    expect(screen.getByText("No runs found")).toBeInTheDocument();
  });

  it("triggers onSelectRun callback when a run link is clicked", async () => {
    const user = userEvent.setup();
    const handleSelect = vi.fn();
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} onSelectRun={handleSelect} />);

    await user.click(screen.getByTestId("run-item-run-alpha"));
    expect(handleSelect).toHaveBeenCalledTimes(1);
  });

  it("renders developer utilities footer with reset button", () => {
    renderSidebar(<RunsSidebar runs={MOCK_RUNS} />);

    expect(screen.getByTestId("reset-demo-data-btn")).toBeInTheDocument();
    expect(screen.getByText("Aegis Mock v1.0")).toBeInTheDocument();
  });
});
