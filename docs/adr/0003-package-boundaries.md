# ADR 0003 — Package Boundary Design

| Field        | Value            |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2025-01-01       |
| **Deciders** | Engineering Team |

---

## Context

A monorepo with multiple packages requires clear rules about which packages may depend on which others. Without explicit boundaries, codebases tend to accumulate circular dependencies and become hard to reason about.

---

## Decision

We establish the following **dependency layering** with a strict direction rule:

```
                 foundation          ← No @aegis dependencies
                /    |    \
            types  config  logger
               |       |       |
           contracts   +-------+
               |
          apps (api, worker)
```

**The rules are:**

1. **`@aegis/foundation`** — Zero dependencies on other `@aegis` packages. It is the root of the dependency tree. Contains: raw primitives, utilities, and health types.

2. **`@aegis/types`** — May depend on `foundation` only. Contains: domain types, branded IDs, lifecycle enums, `Result<T,E>`.

3. **`@aegis/contracts`** — May depend on `foundation` and `types`. Contains: pure TypeScript interfaces that components must implement.

4. **`@aegis/config`** — May depend on `foundation` and `types`. Contains: environment parsing, typed config objects.

5. **`@aegis/logger`** — May depend on `foundation` and `config`. Contains: `Logger` interface and implementations.

6. **`apps/*`** — May depend on any package. Applications are always leaves in the dependency graph.

**Circular dependencies are forbidden.** TypeScript project references enforce this at compile time.

---

## Consequences

**Positive:**

- Dependency graph is a DAG (directed acyclic graph) — easy to reason about
- TypeScript project references enforce the boundaries automatically
- Individual packages can be tested and built in isolation
- Clear separation prevents business logic from leaking into primitives
- Future packages (orchestrator, workflow engine) can be added without changing existing packages

**Negative:**

- Requires discipline to maintain boundaries as the codebase grows
- Moving a type to a lower layer requires more thought than ad-hoc placement
- Some utilities may seem like they belong in multiple packages

**Future consideration:**
As the platform grows, additional packages will be inserted at appropriate layers:

- `@aegis/events` → above `foundation`, consumed by `orchestrator` and `worker`
- `@aegis/state` → above `types`, implements `IAgentRepository` from `contracts`
- `@aegis/tools` → above `contracts`, implements tool execution
