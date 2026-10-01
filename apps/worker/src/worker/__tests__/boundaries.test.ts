import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VALID_WORKER_TRANSITIONS,
  workerCapabilitiesSchema,
  workerStateSchema,
} from "@aegis/contracts";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerSrcDir = path.resolve(__dirname, "../../");
const workerPackageJsonPath = path.resolve(workerSrcDir, "../package.json");

describe("Worker Architectural Boundary Isolation (Phase 11A — Commit 5)", () => {
  it("apps/worker package.json does not declare database, redis, or workflow-engine dependencies", () => {
    const raw = fs.readFileSync(workerPackageJsonPath, "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const allDeps = [...deps, ...devDeps];

    expect(allDeps).not.toContain("@aegis/db");
    expect(allDeps).not.toContain("@prisma/client");
    expect(allDeps).not.toContain("prisma");
    expect(allDeps).not.toContain("ioredis");
    expect(allDeps).toContain("@aegis/agent-runtime");
    expect(allDeps).toContain("kafkajs");
  });

  it("apps/worker source code never imports forbidden platform layers", () => {
    const forbiddenImports = [
      "@aegis/db",
      "@prisma/client",
      "prisma",
      "ioredis",
      "WorkflowEngine",
      "ExecutionRun",
    ];

    function getAllSourceFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "dist") {
            files.push(...getAllSourceFiles(fullPath));
          }
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const sourceFiles = getAllSourceFiles(workerSrcDir);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const forbidden of forbiddenImports) {
        expect(content).not.toContain(forbidden);
      }
    }
  });

  it("worker lifecycle states and transition matrix remain strictly sealed", () => {
    const states = workerStateSchema.options;
    expect(states).toEqual(["starting", "ready", "draining", "stopped", "failed"]);

    // Terminal state stopped has zero outgoing transitions
    expect(VALID_WORKER_TRANSITIONS.stopped).toHaveLength(0);

    // Starting can transition to ready, failed, or stopped
    expect(VALID_WORKER_TRANSITIONS.starting).toEqual(["ready", "failed", "stopped"]);

    // Ready can only transition to draining or failed
    expect(VALID_WORKER_TRANSITIONS.ready).toEqual(["draining", "failed"]);

    // Draining can only transition to stopped
    expect(VALID_WORKER_TRANSITIONS.draining).toEqual(["stopped"]);
  });

  it("worker capabilities schema strictly defines taskTypes, tools, and maxConcurrency", () => {
    const parsed = workerCapabilitiesSchema.safeParse({
      taskTypes: ["compute"],
      tools: ["echo"],
      maxConcurrency: 2,
    });

    expect(parsed.success).toBe(true);

    const invalid = workerCapabilitiesSchema.safeParse({
      taskTypes: [], // must have at least 1
      tools: [],
      maxConcurrency: 0, // must be positive
    });

    expect(invalid.success).toBe(false);
  });
});
