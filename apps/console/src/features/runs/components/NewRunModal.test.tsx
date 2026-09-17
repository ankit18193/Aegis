import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { NewRunModal } from "./NewRunModal";

function renderWithProviders(ui: React.ReactElement): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("NewRunModal Component", () => {
  it("does not render when isOpen is false", () => {
    renderWithProviders(<NewRunModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-run-modal")).not.toBeInTheDocument();
  });

  it("renders when isOpen is true with accessible dialog semantics", () => {
    renderWithProviders(<NewRunModal isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByTestId("new-run-modal")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Create Execution Run")).toBeInTheDocument();
  });

  it("disables submit button when goal is too short", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewRunModal isOpen={true} onClose={vi.fn()} />);

    const submitBtn = screen.getByTestId("submit-run-btn");
    expect(submitBtn).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/Analyze this repository/);
    await user.type(textarea, "ab");
    expect(submitBtn).toBeDisabled();

    await user.type(textarea, "c"); // now length >= 3
    expect(submitBtn).not.toBeDisabled();
  });

  it("calls onClose when Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();

    renderWithProviders(<NewRunModal isOpen={true} onClose={handleClose} />);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await user.click(cancelBtn);

    expect(handleClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape key is pressed", async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();

    renderWithProviders(<NewRunModal isOpen={true} onClose={handleClose} />);

    await user.keyboard("{Escape}");
    expect(handleClose).toHaveBeenCalledOnce();
  });
});
