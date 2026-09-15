# @aegis/foundation

**Shared low-level primitives for the Aegis platform.**

## Responsibility

This package provides the foundational building blocks shared across all other `@aegis/*` packages and applications. It has **no dependencies** on other `@aegis` packages — it sits at the bottom of the dependency graph.

## Contents

| Module   | Description                                                                     |
| -------- | ------------------------------------------------------------------------------- |
| `health` | Platform health status types and aggregation utilities                          |
| `utils`  | Type-safe low-level utilities: `invariant`, `assertNever`, `semver`, `isRecord` |

## Dependency Rule

```
@aegis/foundation
   (no @aegis dependencies)
```

This package MUST NOT import from any other `@aegis/*` package.

## Usage

```ts
import { HealthStatus, createComponentHealth, invariant } from "@aegis/foundation";
```

## Development

```bash
pnpm build     # Compile TypeScript
pnpm typecheck # Type-check without emitting
pnpm test      # Run tests (from repo root)
```
