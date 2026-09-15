# ADR 0004 — Infrastructure Intentionally Deferred

| Field        | Value            |
| ------------ | ---------------- |
| **Status**   | Accepted         |
| **Date**     | 2025-01-01       |
| **Deciders** | Engineering Team |

---

## Context

When building a platform that will eventually use Kafka, PostgreSQL, Redis, Kubernetes, and AI SDK integrations, there is a temptation to install and configure all these dependencies at the beginning.

This creates several problems:

1. Speculative dependencies add noise and maintenance burden before their value is demonstrated
2. Infrastructure decisions made without requirements tend to be wrong
3. Early lockfile pollution makes it harder to understand what dependencies are actually needed
4. Developers waste time configuring infrastructure they don't yet need

---

## Decision

**All non-essential infrastructure dependencies are intentionally deferred to the phase when they are first needed.**

The following are explicitly excluded from Phase 0:

| Category        | Specific Libraries           | Deferred To                 |
| --------------- | ---------------------------- | --------------------------- |
| Database ORM    | Prisma, Drizzle              | Phase 2 (state persistence) |
| Event streaming | kafkajs, rhea                | Phase 4 (workflow engine)   |
| Cache client    | ioredis                      | Phase 2/3                   |
| HTTP framework  | Hono, Fastify, Express       | Phase 1 (API layer)         |
| AI SDKs         | OpenAI, Anthropic, Google AI | Phase 5 (AI provider)       |
| Tool protocol   | MCP SDK                      | Phase 6 (tool system)       |
| Observability   | OTEL SDK, pino               | Phase 7 (observability)     |
| Validation      | Zod                          | Phase 1 (API validation)    |
| Auth            | JWT, sessions                | Phase 3/4                   |
| Kubernetes      | helm charts, operators       | Phase 8 (production)        |
| Terraform       | infrastructure-as-code       | Phase 8 (production)        |

**The logger package is an exception:** `ConsoleLogger` is a Phase 0 placeholder. It will be replaced with `pino` in Phase 1 or Phase 7, but the `Logger` interface defined now will not change.

---

## Consequences

**Positive:**

- Phase 0 lockfile is minimal and understandable
- No speculative dependencies that never get used
- Infrastructure choices can be made with real requirements context
- Developers can run the full project without installing Kafka, Postgres, etc.

**Negative:**

- Some future phases will require significant package additions at once
- The forward-declared interfaces in `@aegis/contracts` may not perfectly match final implementations

**When to revisit this ADR:**
When beginning a new implementation phase, update this ADR to document which infrastructure was introduced and why, and confirm the interface decisions from `@aegis/contracts` were correct.
