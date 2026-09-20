/**
 * Authorization Policy Boundary for the Aegis Tool System.
 * Defines the capability authorization interface and deterministic test implementations.
 */

import type { Tool, ToolExecutionContext } from "./tool.js";

/**
 * Minimal capability authorization interface.
 * Evaluates whether a tool execution is permitted within the provided execution context.
 */
export interface IAuthorizationPolicy {
  canExecute(tool: Tool, context: ToolExecutionContext): Promise<boolean> | boolean;
}

/**
 * Default Phase 7 authorization policy.
 * Permissively permits execution of all explicitly registered safe tools.
 */
export class AllowAllAuthorizationPolicy implements IAuthorizationPolicy {
  canExecute(): boolean {
    return true;
  }
}

export interface ConfigurablePolicyOptions {
  readonly allowedTools?: readonly string[] | undefined;
  readonly deniedTools?: readonly string[] | undefined;
  readonly defaultAllow?: boolean | undefined;
}

/**
 * Lightweight deterministic authorization policy for testing.
 * Allows explicitly allowing or denying specific tool names without complex rule engines.
 */
export class ConfigurableAuthorizationPolicy implements IAuthorizationPolicy {
  private readonly allowed: ReadonlySet<string>;
  private readonly denied: ReadonlySet<string>;
  private readonly defaultAllow: boolean;

  constructor(options: ConfigurablePolicyOptions = {}) {
    this.allowed = new Set(options.allowedTools ?? []);
    this.denied = new Set(options.deniedTools ?? []);
    this.defaultAllow = options.defaultAllow ?? true;
  }

  canExecute(tool: Tool): boolean {
    if (this.denied.has(tool.name)) {
      return false;
    }
    if (this.allowed.size > 0) {
      return this.allowed.has(tool.name);
    }
    return this.defaultAllow;
  }
}
