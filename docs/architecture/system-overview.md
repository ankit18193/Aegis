# Aegis — System Architecture Overview

> **Phase 0 — Repository & Engineering Foundation**
>
> This document describes the intended future architecture alongside the current implementation scope.
> Sections marked **CURRENT** describe what exists today.
> Sections marked **FUTURE** describe what will be built in subsequent phases.

---

## What is Aegis?

Aegis is a **distributed AI agent execution platform** designed to run long-lived, multi-step AI workflows reliably across a pool of distributed workers.

The core engineering problem Aegis solves:

> AI agents that perform meaningful real-world tasks (browsing, coding, analysis, orchestration) require long execution times, reliable state persistence, error recovery, and the ability to call external tools. Existing infrastructure primitives were not designed for this.

Aegis provides the execution infrastructure so that AI agents can run as durable, observable, distributed workflows — not just as single-shot function calls.

---

## The Problem Space

Modern AI agents face several hard engineering problems:

| Problem               | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| **Long execution**    | Agents may run for minutes to hours; HTTP request/response doesn't fit |
| **Reliability**       | Network failures, model timeouts, and node crashes must not lose work  |
| **State persistence** | Multi-step workflows require durable state between steps               |
| **Tool execution**    | Agents need controlled, auditable access to external tools             |
| **Observability**     | Understanding what an agent did and why is hard                        |
| **Scalability**       | Multiple agents must run concurrently across distributed workers       |

---

## CURRENT: Phase 0 Implementation

**What exists today:**

```
aegis/
├── apps/
│   ├── api/          # Minimal placeholder entry point
│   └── worker/       # Minimal placeholder entry point
│
├── packages/
│   ├── foundation/   # Health primitives, type utilities [IMPLEMENTED]
│   ├── types/        # Domain types, branded IDs, Result type [IMPLEMENTED]
│   ├── contracts/    # Platform interfaces (forward declarations) [IMPLEMENTED]
│   ├── config/       # Env config helpers [IMPLEMENTED]
│   └── logger/       # Console logger (Phase 0) [IMPLEMENTED]
│
├── docs/
├── .github/workflows/
└── (tooling: pnpm, TypeScript, ESLint, Prettier, Vitest)
```

**What this phase establishes:**

- TypeScript-first pnpm monorepo
- Strict TypeScript configuration
- Dependency boundary graph between packages
- ESLint + Prettier + EditorConfig
- Testing foundation (Vitest)
- CI pipeline skeleton
- Architecture documentation
- Docker build foundation

---

## FUTURE: Target Architecture

> ⚠️ **None of the following systems are implemented yet.** This section documents the intended design to guide future phases.

### High-Level Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                         Clients                             │
│               (SDKs / Web UI / CLI / API)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                    API Layer (apps/api)                      │
│         REST / GraphQL / WebSocket gateway                   │
│         Auth / Rate limiting / Request routing               │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│               Agent Orchestrator                             │
│     Schedules agents → assigns to workers                    │
│     Manages agent lifecycle state machine                    │
└──────────────┬─────────────────────┬───────────────────────┘
               │                     │
┌──────────────▼──────┐  ┌───────────▼──────────────────────┐
│   Workflow Engine    │  │        Event Bus (Kafka)          │
│   Durable execution  │  │  Task events, agent events,       │
│   Steps & retries    │  │  result streaming                 │
└──────────────┬──────┘  └───────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│              Worker Pool (apps/worker)                        │
│   Distributed execution nodes                                │
│   Task consumers from Kafka                                  │
│   Tool execution sandbox                                     │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│              AI Model Providers                               │
│   OpenAI / Gemini / Anthropic / Local                        │
│   MCP (Model Context Protocol) tool integration              │
└─────────────────────────────────────────────────────────────┘
```

### Planned Platform Components

| Component       | Package/App             | Phase  | Description                     |
| --------------- | ----------------------- | ------ | ------------------------------- |
| API Gateway     | `apps/api`              | Future | HTTP/WS entry point             |
| Orchestrator    | `packages/orchestrator` | Future | Agent lifecycle management      |
| Workflow Engine | `packages/workflow`     | Future | Durable step execution          |
| Worker          | `apps/worker`           | Future | Distributed task execution      |
| Event Bus       | `packages/events`       | Future | Kafka integration               |
| State Store     | `packages/state`        | Future | PostgreSQL persistence          |
| Cache           | `packages/cache`        | Future | Redis integration               |
| Tool System     | `packages/tools`        | Future | MCP tool execution              |
| AI Providers    | `packages/ai`           | Future | Model provider abstraction      |
| Evaluation      | `packages/eval`         | Future | Agent output quality evaluation |
| Observability   | `packages/telemetry`    | Future | OTEL tracing/metrics            |
| Auth            | `packages/auth`         | Future | Authentication/authorization    |

---

## Package Dependency Graph

### CURRENT

```
                     foundation
                    /    |    \
                types  config  logger
                  |       |      |
               contracts  +------+
                  |
             apps (api, worker)
```

**Dependency direction rule:**

- Lower packages MUST NOT import from higher packages
- `foundation` has zero `@aegis` dependencies
- Applications can import from any package
- Circular dependencies are strictly forbidden

### FUTURE additions will follow the same direction rule.

---

## FUTURE: Data Flow

```
User Request
    → API Gateway (auth, validation)
    → Orchestrator (create agent, assign to queue)
    → Kafka (publish task event)
    → Worker (consume task, execute agent steps)
    → AI Provider (model call)
    → Tool Executor (MCP tool call)
    → Result back to Kafka
    → Orchestrator (update state)
    → PostgreSQL (persist state)
    → Client notification (WebSocket / polling)
```

---

## FUTURE: Deployment Architecture

Aegis will be deployed on Kubernetes with:

- Horizontal pod autoscaling for workers
- Leader election for the orchestrator
- Kafka for event streaming
- PostgreSQL for durable state
- Redis for caching and pub/sub
- OpenTelemetry collector for observability

**None of this infrastructure is in scope for Phase 0.**

---

## Versioning and Phases

| Phase   | Description                            | Status     |
| ------- | -------------------------------------- | ---------- |
| Phase 0 | Repository & Engineering Foundation    | ✅ Current |
| Phase 1 | API layer (HTTP server, basic routing) | 🔲 Planned |
| Phase 2 | Agent data model and persistence       | 🔲 Planned |
| Phase 3 | Worker and task execution              | 🔲 Planned |
| Phase 4 | Workflow engine and event streaming    | 🔲 Planned |
| Phase 5 | AI provider integration                | 🔲 Planned |
| Phase 6 | Tool system (MCP)                      | 🔲 Planned |
| Phase 7 | Observability and evaluation           | 🔲 Planned |
| Phase 8 | Production hardening                   | 🔲 Planned |
