/**
 * @aegis/logger
 *
 * Structured logging abstraction for the Aegis platform.
 *
 * NOTE: This is a Phase 0 placeholder implementation.
 * In future phases, this will be replaced with a production-grade
 * structured logger (e.g., pino) with:
 * - JSON output in production
 * - Pretty-print in development
 * - Request/trace correlation
 * - Log sampling
 * - Remote log shipping
 */

// ─────────────────────────────────────────────────────────────────────────────
// Log levels
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported log levels in ascending severity order.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Logger interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Logger interface. All platform components should depend on this
 * interface rather than a concrete implementation.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Creates a child logger with additional bound context. */
  child(bindings: Record<string, unknown>): Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console logger (Phase 0 implementation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal console-based Logger implementation for Phase 0.
 * Not suitable for production use — replace with pino in a future phase.
 */
export class ConsoleLogger implements Logger {
  private readonly minLevel: number;
  private readonly bindings: Record<string, unknown>;

  constructor(level: LogLevel = "info", bindings: Record<string, unknown> = {}) {
    this.minLevel = LOG_LEVEL_SEVERITY[level];
    this.bindings = bindings;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= this.minLevel;
  }

  private format(level: LogLevel, message: string, context?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const merged = { ...this.bindings, ...context };
    const ctxStr = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : "";
    return `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${ctxStr}`;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      console.debug(this.format("debug", message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      console.info(this.format("info", message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", message, context));
    }
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", message, context));
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    const currentLevel = Object.entries(LOG_LEVEL_SEVERITY).find(
      ([, severity]) => severity === this.minLevel,
    )?.[0] as LogLevel | undefined;

    return new ConsoleLogger(currentLevel ?? "info", {
      ...this.bindings,
      ...bindings,
    });
  }
}

/**
 * Creates a ConsoleLogger with the given level.
 * Use this factory instead of instantiating ConsoleLogger directly.
 */
export function createLogger(
  level: LogLevel = "info",
  bindings: Record<string, unknown> = {},
): Logger {
  return new ConsoleLogger(level, bindings);
}
