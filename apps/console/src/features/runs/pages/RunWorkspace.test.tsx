import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RunWorkspace } from "./RunWorkspace";

function renderWorkspace(initialPath: string): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/runs/:runId" element={<RunWorkspace />} />
          <Route path="/runs" element={<div>Runs List</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("RunWorkspace Page Component", () => {
  it("renders 404 empty state when runId does not exist", async () => {
    renderWorkspace("/runs/non-existent-run-999");

    expect(await screen.findByTestId("run-not-found")).toBeInTheDocument();
    expect(screen.getByText("Run Not Found")).toBeInTheDocument();
    expect(screen.getByText(/non-existent-run-999/)).toBeInTheDocument();
  });

  it("renders run workspace header, progress, tasks, and activity timeline for valid run", async () => {
    renderWorkspace("/runs/run-001");

    // Check Run Header
    expect(await screen.findByTestId("run-header")).toBeInTheDocument();
    expect(screen.getByTestId("run-goal-title")).toHaveTextContent(
      "Analyze repository performance bottlenecks"
    );

    // Check Progress
    expect(screen.getByTestId("run-progress-container")).toBeInTheDocument();
    expect(screen.getByTestId("run-progress-percentage")).toHaveTextContent("60%");

    // Check Workflow and Tasks
    expect(screen.getByTestId("workflow-progress")).toBeInTheDocument();
    const tasksSection = screen.getByTestId("tasks-section");
    expect(within(tasksSection).getByText("Planning & Workspace Scope")).toBeInTheDocument();

    // Check Activity Timeline
    expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();

    // Check Simulation Controls
    expect(screen.getByTestId("simulation-controls")).toBeInTheDocument();
  });

  it("opens TaskDetailDrawer on task card click and closes on dismiss", async () => {
    const user = userEvent.setup();
    renderWorkspace("/runs/run-001");

    expect(await screen.findByTestId("task-card-task-101")).toBeInTheDocument();

    // Click task card
    await user.click(screen.getByTestId("task-card-task-101"));

    // Verify Drawer is open
    const drawer = await screen.findByTestId("task-detail-drawer");
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByText("Assigned Worker")).toBeInTheDocument();
    expect(within(drawer).getByText("worker-node-alpha")).toBeInTheDocument();
    expect(within(drawer).getByText(/Successfully mapped workspace/)).toBeInTheDocument();

    // Close drawer
    const closeBtn = screen.getByTestId("close-task-drawer");
    await user.click(closeBtn);

    expect(screen.queryByTestId("task-detail-drawer")).not.toBeInTheDocument();
  });

  it("displays execution result section when run is completed", async () => {
    renderWorkspace("/runs/run-002"); // run-002 is completed in seed data

    expect(await screen.findByTestId("run-result-view")).toBeInTheDocument();
    expect(screen.getByText("Execution Result")).toBeInTheDocument();
    expect(screen.getByText(/Dependency audit completed successfully/)).toBeInTheDocument();
  });
});
