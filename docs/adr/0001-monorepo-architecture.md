# ADR 0001 — Monorepo Architecture

| Field        | Value            |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2025-01-01       |
| **Deciders** | Engineering Team |

---

## Context

Aegis will grow into a platform with multiple deployable services (API, Workers), shared business logic, and internal tooling packages. We need to decide how to organize the codebase.

The primary options considered were:

1. **Polyrepo** — separate Git repositories per service/package
2. **Monorepo with pnpm workspaces** — single repository, multiple packages
3. **Monorepo with Nx or Turborepo** — monorepo with build orchestration tooling

---

## Decision

We will use a **TypeScript-first pnpm monorepo** with pnpm workspaces for package management.

**We will NOT use Nx or Turborepo initially.** These tools add complexity and have opinionated constraints. We will revisit this decision when build times become a real problem (anticipated at 10+ packages). TypeScript project references provide sufficient incremental build support for our current scale.

The repository is organized as:

```
apps/     — Deployable applications (API, Worker)
packages/ — Internal shared packages
docs/     — Architecture and developer documentation
scripts/  — Repository automation scripts
tests/    — Integration and cross-package tests
.github/  — CI/CD workflows
```

---

## Consequences

**Positive:**

- Atomic cross-package changes — no cross-repo coordination
- Unified TypeScript configuration with project references
- Shared tooling (ESLint, Prettier, Vitest) with single configuration
- Simplified onboarding — one `git clone`, one `pnpm install`
- Clear dependency visibility within a single repository

**Negative:**

- All packages share a single pnpm lockfile — version conflicts require careful management
- Repository grows larger over time — may eventually require sparse checkout strategies
- CI pipelines must be careful to only rebuild/test affected packages

**Trade-offs accepted:**

- We accept the single-lockfile complexity in exchange for unified dependency management
- We accept the potential need for Turborepo/Nx in a future phase when build times become significant
