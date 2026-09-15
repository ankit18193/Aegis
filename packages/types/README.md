# @aegis/types

**Shared TypeScript domain types for the Aegis platform.**

## Responsibility

This package defines the core domain model types shared across all platform components. Types here represent fundamental platform concepts: agents, workflows, tasks, and their lifecycle states.

## Contents

| Export                                        | Description                              |
| --------------------------------------------- | ---------------------------------------- |
| `AgentId`, `WorkflowId`, `TaskId`, `WorkerId` | Branded ID types for nominal type safety |
| `agentId()`, `workflowId()` etc.              | Constructor functions for branded IDs    |
| `AgentStatus`, `WorkflowStatus`               | Lifecycle state enumerations             |
| `Result<T, E>`, `ok()`, `err()`               | Discriminated union result type          |

## Dependency Rule

```
@aegis/types
    ↑
@aegis/foundation
```

This package depends only on `@aegis/foundation`.

## Design Notes

**Branded types** are used for ID types to prevent accidentally passing a `WorkflowId` where an `AgentId` is expected. They have zero runtime overhead.

**`Result<T, E>`** is preferred over throwing exceptions for domain-level error handling. The caller is forced to handle both success and failure paths.

## Usage

```ts
import { agentId, AgentStatus, ok, err, type Result } from "@aegis/types";
```
