# @aegis/logger

**Structured logging abstraction for the Aegis platform.**

## Responsibility

This package provides the logging interface used by all platform components. All logging goes through the `Logger` interface — never directly to `console.*`.

## Current State (Phase 0)

The Phase 0 implementation provides a minimal `ConsoleLogger`:

| Export                          | Description                                   |
| ------------------------------- | --------------------------------------------- |
| `Logger`                        | The logger interface all components depend on |
| `ConsoleLogger`                 | Console-based implementation (Phase 0 only)   |
| `createLogger(level, bindings)` | Factory function for creating loggers         |
| `LogLevel`                      | `"debug" \| "info" \| "warn" \| "error"`      |

## Future State

In future phases:

- `ConsoleLogger` will be replaced with **pino** (structured JSON logging)
- Production output: JSON with trace correlation
- Development output: pretty-print
- Log sampling for high-volume paths

## Dependency Rule

```
@aegis/logger
    ↑         ↑
@aegis/config @aegis/foundation
```

## Usage

```ts
import { createLogger } from "@aegis/logger";

const logger = createLogger("info", { service: "api" });
logger.info("Server started", { port: 3000 });

const childLogger = logger.child({ requestId: "abc-123" });
```
