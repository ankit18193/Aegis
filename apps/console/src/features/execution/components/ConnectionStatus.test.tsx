import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionStatus } from "./ConnectionStatus";

describe("ConnectionStatus Component", () => {
  it("renders connected state with Live Stream label", () => {
    render(<ConnectionStatus status="connected" />);
    const badge = screen.getByTestId("connection-status-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-status", "connected");
    expect(screen.getByText("Live Stream")).toBeInTheDocument();
  });

  it("renders connecting state with Connecting... label", () => {
    render(<ConnectionStatus status="connecting" />);
    const badge = screen.getByTestId("connection-status-badge");
    expect(badge).toHaveAttribute("data-status", "connecting");
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders disconnected state with Offline label", () => {
    render(<ConnectionStatus status="disconnected" />);
    const badge = screen.getByTestId("connection-status-badge");
    expect(badge).toHaveAttribute("data-status", "disconnected");
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("renders error state with error code when provided", () => {
    render(
      <ConnectionStatus
        status="error"
        error={{ code: "SSE_TIMEOUT", message: "Connection timed out" }}
      />,
    );
    const badge = screen.getByTestId("connection-status-badge");
    expect(badge).toHaveAttribute("data-status", "error");
    expect(screen.getByText("Error: SSE_TIMEOUT")).toBeInTheDocument();
  });
});
