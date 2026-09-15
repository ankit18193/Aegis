# Project Structure

This document describes the layout of the Aegis repository and explains the purpose of each directory.

---

## Repository Layout

```
aegis/
│
├── apps/                           # Deployable applications
│   ├── api/                        # HTTP API gateway (Phase 0: placeholder)
│   │   ├── src/
│   │   │   └── main.ts             # Entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── worker/                     # Distributed execution worker (Phase 0: placeholder)
│       ├── src/
│       │   └── main.ts             # Entry point
│       ├── package.json
│       └── tsconfig.json
│
├── packages/                       # Internal shared packages
│   ├── foundation/                 # Low-level primitives (no @aegis deps)
│   │   └── src/
│   │       ├── health.ts           # Platform health types and aggregation
│   │       ├── utils.ts            # Type utilities (invariant, assertNever, etc.)
│   │       └── index.ts            # Public API barrel export
│   │
│   ├── types/                      # Domain types (depends: foundation)
│   │   └── src/
│   │       └── index.ts            # Branded IDs, enums, Result<T>
│   │
│   ├── contracts/                  # Platform interfaces (depends: foundation, types)
│   │   └── src/
│   │       └── index.ts            # IHealthCheckable, IAgentRepository, etc.
│   │
│   ├── config/                     # Config handling (depends: foundation, types)
│   │   └── src/
│   │       └── index.ts            # Env helpers, BaseConfig
│   │
│   └── logger/                     # Logging abstraction (depends: foundation, config)
│       └── src/
│           └── index.ts            # Logger interface, ConsoleLogger
│
├── docs/                           # Documentation
│   ├── architecture/               # System architecture documents
│   │   └── system-overview.md      # Primary architecture reference
│   ├── adr/                        # Architecture Decision Records
│   │   ├── 0001-monorepo-architecture.md
│   │   ├── 0002-typescript-first.md
│   │   ├── 0003-package-boundaries.md
│   │   └── 0004-infrastructure-intentionally-deferred.md
│   └── development/                # Developer guides
│       ├── setup.md                # Local development setup
│       ├── project-structure.md    # This file
│       └── contributing.md         # Contribution guidelines
│
├── tests/                          # Cross-package integration tests (future)
│
├── scripts/                        # Repository automation scripts (future)
│
├── .github/
│   └── workflows/
│       └── ci.yml                  # CI pipeline
│
├── package.json                    # Root workspace package
├── pnpm-workspace.yaml             # pnpm workspace configuration
├── tsconfig.json                   # Root TypeScript config with project references
├── tsconfig.base.json              # Shared base TypeScript configuration
├── eslint.config.mjs               # ESLint flat config (monorepo-wide)
├── vitest.config.ts                # Vitest test configuration
├── .prettierrc                     # Prettier formatting config
├── .prettierignore                 # Prettier ignore patterns
├── .editorconfig                   # Editor whitespace/encoding config
├── .gitignore                      # Git ignore patterns
├── .env.example                    # Environment variable template
├── Dockerfile                      # Container image for the platform
├── .dockerignore                   # Docker build context exclusions
├── LICENSE                         # MIT License
└── README.md                       # Project overview
```

---

## Directory Conventions

### `apps/`

Deployable applications — things that run as processes. Each app:

- Has its own `package.json` with `name: "@aegis/<name>"`
- Has its own `tsconfig.json` that references all packages it depends on
- May only import from `packages/`, never from other `apps/`
- Contains a `src/main.ts` entry point

### `packages/`

Reusable internal packages. Each package:

- Has its own `package.json` with `name: "@aegis/<name>"`
- Has its own `tsconfig.json` with `"composite": true` (required for project references)
- Exports its public API through `src/index.ts`
- MUST NOT have circular dependencies with other packages
- Is published as `workspace:*` dependency within the monorepo

### `docs/`

All human-readable documentation:

- `architecture/` — Long-lived reference documents about system design
- `adr/` — Architecture Decision Records; never deleted, only superseded
- `development/` — Developer guides for contributing and operating the project

### `tests/`

Reserved for cross-package integration tests that span multiple packages. Unit tests live alongside their source files in `packages/*/src/*.test.ts`.

### `scripts/`

Repository automation scripts (e.g., release scripts, code generation). Not yet populated in Phase 0.

---

## Package Naming Convention

All internal packages follow the `@aegis/<name>` scope:

| Package             | Scope              |
| ------------------- | ------------------ |
| `@aegis/foundation` | Primitives         |
| `@aegis/types`      | Domain types       |
| `@aegis/contracts`  | Interfaces         |
| `@aegis/config`     | Configuration      |
| `@aegis/logger`     | Logging            |
| `@aegis/api`        | API application    |
| `@aegis/worker`     | Worker application |

---

## File Naming Conventions

| Convention    | Description                              |
| ------------- | ---------------------------------------- |
| `*.ts`        | TypeScript source files                  |
| `*.test.ts`   | Unit test files (co-located with source) |
| `index.ts`    | Public barrel export for each package    |
| `main.ts`     | Application entry point                  |
| `*.config.ts` | Configuration files                      |
