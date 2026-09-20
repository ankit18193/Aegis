import { describe, expect, it } from "vitest";

import {
  DEFAULT_MCP_TIMEOUT_MS,
  validateMcpServerConfig,
  validateMcpServerConfigs,
} from "./config.js";

describe("MCP Server Configuration Validation", () => {
  it("validates a complete stdio server configuration", () => {
    const raw = {
      id: "fs_server",
      name: "Filesystem Provider",
      transport: "stdio",
      command: "node",
      args: ["./dist/index.js", "--readonly"],
      env: { STORAGE_DIR: "/data" },
      cwd: "/data",
      timeoutMs: 15000,
      disabled: false,
    };

    const res = validateMcpServerConfig(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.id).toBe("fs_server");
    expect(res.value.name).toBe("Filesystem Provider");
    expect(res.value.transport).toBe("stdio");
    expect(res.value.command).toBe("node");
    expect(res.value.args).toEqual(["./dist/index.js", "--readonly"]);
    expect(res.value.env).toEqual({ STORAGE_DIR: "/data" });
    expect(res.value.cwd).toBe("/data");
    expect(res.value.timeoutMs).toBe(15000);
    expect(res.value.disabled).toBe(false);
  });

  it("applies default timeout when timeoutMs is omitted", () => {
    const raw = {
      id: "git",
      name: "Git Server",
      transport: "stdio",
      command: "git-mcp",
    };

    const res = validateMcpServerConfig(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.timeoutMs).toBe(DEFAULT_MCP_TIMEOUT_MS);
    expect(res.value.disabled).toBe(false);
  });

  it("validates a minimal in-memory server configuration", () => {
    const raw = {
      id: "mock_mem",
      name: "In-Memory Test Server",
      transport: "memory",
      timeoutMs: 5000,
    };

    const res = validateMcpServerConfig(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.id).toBe("mock_mem");
    expect(res.value.transport).toBe("memory");
    expect(res.value.command).toBeUndefined();
    expect(res.value.args).toBeUndefined();
  });

  it("rejects stdio server configuration when command is missing or empty", () => {
    const noCmd = {
      id: "fs",
      name: "FS",
      transport: "stdio",
    };
    const res1 = validateMcpServerConfig(noCmd);
    expect(res1.ok).toBe(false);
    if (res1.ok) return;
    expect(res1.error.code).toBe("MCP_INVALID_CONFIG");
    expect(res1.error.message).toContain("Command is required");

    const emptyCmd = {
      id: "fs",
      name: "FS",
      transport: "stdio",
      command: "",
    };
    const res2 = validateMcpServerConfig(emptyCmd);
    expect(res2.ok).toBe(false);
  });

  it("rejects memory server configuration when command or args are specified", () => {
    const badMemory = {
      id: "mem",
      name: "Memory",
      transport: "memory",
      command: "node",
    };
    const res = validateMcpServerConfig(badMemory);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_INVALID_CONFIG");
  });

  it("rejects invalid server IDs", () => {
    const invalidIds = [
      "Uppercase",
      "1startswithnumber",
      "has space",
      "has:colon",
      "-startswithdash",
      "this_id_is_way_too_long_and_exceeds_the_thirty_two_char_limit",
      "",
    ];

    for (const id of invalidIds) {
      const res = validateMcpServerConfig({
        id,
        name: "Test",
        transport: "memory",
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("MCP_INVALID_CONFIG");
    }
  });

  it("rejects out-of-bounds timeouts", () => {
    const tooLow = validateMcpServerConfig({
      id: "srv",
      name: "Test",
      transport: "memory",
      timeoutMs: 10,
    });
    expect(tooLow.ok).toBe(false);

    const tooHigh = validateMcpServerConfig({
      id: "srv",
      name: "Test",
      transport: "memory",
      timeoutMs: 500_000,
    });
    expect(tooHigh.ok).toBe(false);
  });

  it("validates a batch of server configs and detects duplicate IDs", () => {
    const configs = [
      { id: "srv1", name: "S1", transport: "memory" },
      { id: "srv2", name: "S2", transport: "stdio", command: "test" },
    ];
    const okBatch = validateMcpServerConfigs(configs);
    expect(okBatch.ok).toBe(true);
    if (!okBatch.ok) return;
    expect(okBatch.value.length).toBe(2);

    const dupConfigs = [
      { id: "srv1", name: "S1", transport: "memory" },
      { id: "srv1", name: "S1 Duplicate", transport: "memory" },
    ];
    const dupBatch = validateMcpServerConfigs(dupConfigs);
    expect(dupBatch.ok).toBe(false);
    if (dupBatch.ok) return;
    expect(dupBatch.error.message).toContain("Duplicate MCP server ID 'srv1'");
  });
});
