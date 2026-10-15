# Real-Time Execution Event Streaming Architecture (Phase 13)

This document describes the end-to-end architecture for real-time execution updates in Aegis across **Phase 13A**, **Phase 13B**, and **Phase 13C**.

---

## 1. Architectural Mission

The goal of Phase 13 is to connect live agent execution across distributed workers to the **Aegis Console** web application with sub-second latency and zero polling overhead:

```text
Worker Execution / Domain Engine
              │
              ▼
 PostgreSQL + Transactional Outbox (Durable Authority)
              │
              ▼ (CDC / Poller)
   Kafka Event Transport (`aegis-execution-events`)
              │
              ▼
  Per-Instance Consumer Group (`${groupId}-sse-${instanceId}`)
              │
              ▼
   API Service — SseEventGateway (Observer)
              │ (mapExecutionEventToSseEnvelope)
              ▼
       SseTransportManager
              │ (broadcastToRun)
              ▼
        SseConnection
              │ (W3C text/event-stream)
              ▼
      Browser / Console UI
   (SseExecutionStreamClient → useExecutionStream → Reducer → Timeline)
```

---

## 2. Invariants & Boundary Discipline

1. **PostgreSQL Remains Authoritative**:
   - The SSE transport gateway delivers events — it does **NOT** own execution state.
   - Gateway delivery failures or connection disconnects must **NEVER** alter run state, poison Kafka consumer offsets, or abort transactions.

2. **Decoupled Framing & Transport**:
   - `@aegis/contracts` defines the typed SSE wire framing (`serializeSseEnvelope`, `deserializeSseEnvelope`) completely decoupled from Fastify and React.
   - `mapExecutionEventToSseEnvelope` polymorphically adapts `RunEvent`, `EventEnvelope`, and `TaskAssignmentEnvelope` without mutating domain identity or timestamps.

3. **Multi-Replica Fan-Out via Per-Instance Groups**:
   - Each API replica runs an independent Kafka consumer with a unique group ID (`${groupId}-sse-${instanceId}`).
   - Every replica receives all execution events and broadcasts them to its locally connected SSE clients whose `runId` matches the event's `aggregateId`.

4. **Run-Scoped Isolation & Connection Multiplexing**:
   - Multiple browser components or hooks watching the same `runId` share a single underlying `EventSource` connection managed by `SseExecutionStreamClient`.
   - Different `runId` streams remain strictly isolated; connections never receive events for other runs.

5. **Client-Side Identity Deduplication**:
   - Because Kafka provides at-least-once delivery semantics, `SseExecutionStreamClient` maintains a bounded LRU deduplication cache by canonical `EventId`.
   - Reconnected streams or duplicate Kafka deliveries will not create duplicate events on the UI timeline.

---

## 3. Subsystem Breakdown

### Phase 13A — State Model & Event Reducer
- `executionStream.types.ts`: `IExecutionStreamClient`, `ConnectionState`, `ExecutionStreamEvent`, `StreamSubscription`.
- `execution.reducer.ts`: Pure functional event reducer updating live `Run` state and maintaining chronological events.
- `MockExecutionStreamClient.ts`: In-memory deterministic mock for local development and testing.

### Phase 13B — SSE Wire Framing & Fastify Transport Foundation
- `sse.ts`: Canonical transport contracts (`SseTransportEnvelope`, `SseConnectedEnvelope`, `SseExecutionEnvelope`, `SseClosedEnvelope`, `SseErrorEnvelope`, `SseHeartbeatEnvelope`).
- `sseSerializer.ts`: Deterministic encoding/parsing adhering strictly to WHATWG/W3C SSE framing specifications.
- `sseConnection.ts`: Connection lifecycle manager with backpressure handling and keep-alive heartbeats.
- `sseTransportManager.ts`: Connection registry and run-scoped broadcast router.
- `fastifySseTransport.ts`: Route handler for `GET /api/v1/stream/transport?runId=<runId>`.

### Phase 13C — Live Event Gateway & Console Client
- `sseAdapter.ts`: Adapter translating Kafka domain envelopes into SSE transport envelopes with identity preservation.
- `sseEventGateway.ts`: API service bridge consuming Kafka execution events and invoking `transportManager.broadcastToRun()`.
- `SseExecutionStreamClient.ts`: Browser `EventSource` client implementing `IExecutionStreamClient` with multiplexing, deduplication, and error recovery.
- `streamClientService.ts`: Dynamic service providing `SseExecutionStreamClient` by default with fallback to `MockExecutionStreamClient` in test environments.

---

## 4. Verification & Test Metrics

- Monorepo test suite: **147 test files passed**, **1,227 tests passed**, 3 skipped, 0 failures.
- Unit and integration tests verify:
  1. Serialization / deserialization roundtrip determinism.
  2. Adapter validation and identity preservation.
  3. API consumer group registration and shutdown hooks.
  4. Run isolation and concurrent connection fan-out.
  5. Multi-subscriber multiplexing and deduplication.
  6. Reconnect error recovery and terminal stream closure.
