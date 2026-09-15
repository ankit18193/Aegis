# @aegis/contracts

**Interfaces and contracts between Aegis platform components.**

## Responsibility

This package defines the **interfaces** that major platform components must satisfy, enabling loose coupling between consumers and implementations.

Contracts serve as the API surface between:

- Applications and services
- Infrastructure implementations and domain logic
- Future plugin/extension points

## Contents

| Contract              | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `IHealthCheckable`    | Any component that exposes a health endpoint             |
| `IAgentRepository`    | Persistence contract for Agent records _(future)_        |
| `IWorkflowRepository` | Persistence contract for Workflow records _(future)_     |
| `IEventPublisher`     | Event publishing contract (Kafka abstraction) _(future)_ |

## Dependency Rule

```
@aegis/contracts
    ↑         ↑
@aegis/types  @aegis/foundation
```

This package may depend on `@aegis/foundation` and `@aegis/types`, but NOT on `@aegis/config`, `@aegis/logger`, or any application package.

## Design Principle

Contracts in this package are **interfaces only** — no implementations. This enforces dependency inversion: application code depends on contracts, not on concrete infrastructure.

## Usage

```ts
import type { IHealthCheckable, IAgentRepository } from "@aegis/contracts";
```
