/**
 * Built-in Tools for Aegis Tool System.
 */

import type { IToolRegistry } from "../registry.js";
import type { Tool } from "../tool.js";

import { calculateTool } from "./calculate.js";
import { echoTool } from "./echo.js";
import { noopTool } from "./noop.js";

export * from "./echo.js";
export * from "./calculate.js";
export * from "./noop.js";

/**
 * Deterministically registers all standard built-in safe tools into the provided registry.
 */
export function registerBuiltinTools(registry: IToolRegistry): void {
  registry.register(echoTool as unknown as Tool);
  registry.register(calculateTool as unknown as Tool);
  registry.register(noopTool as unknown as Tool);
}
