# Real-Time Execution Event Streaming Architecture (Phase 13)

This document describes the end-to-end architecture for real-time execution updates in Aegis across **Phase 13A**, **Phase 13B**, **Phase 13C**, and **Phase 13D**.

---

## 1. Architectural Mission

The goal of Phase 13 is to connect live agent execution across distributed workers to the **Aegis Console** web application with sub-second latency, zero polling overhead, and durable replay recovery across network disconnects:

```text
Worker Execution / Domain Engine
              │
              ▼
 PostgreSQL + Transactional Outbox (Durable Authority & Run Events)
              │
              ├───► PostgresRunEventReplayRepository (Durable Keyset Pagination)
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
   SseReplayCoordinator (Replay Loop + Live Buffer Coordination)
              │
              ▼
        SseTransportManager
              │ (broadcastToRun)
              ▼
         SseConnection
              │ (W3C text/event-stream + Last-Event-ID / Replay Framing)
              ▼
      Browser / Console UI
   (SseExecutionStreamClient → useExecutionStream → Reducer → Timeline)
```

---

## 2. Invariants & Boundary Discipline

1. **PostgreSQL Remains Authoritative**:
   - The SSE transport gateway delivers events — it does **NOT** own execution state.
   - Gateway delivery failures or connection disconnects must **NEVER** alter run state, poison Kafka consumer offsets, or abort transactions.

2. **Durable Keyset Replay with Strict Run Isolation**:
   - Replay positions are indexed via compound `(timestamp, id)` cursors. Random UUID commit ordering is never assumed.
   - Any unknown cursor or gap detection immediately halts handoff and triggers authoritative state reconciliation (`REPLAY_GAP_DETECTED`).
   - Cross-run cursors are strictly forbidden and rejected at the repository boundary.

3. **Multi-Page Replay Loop**:
   - Connections reconnecting with `Last-Event-ID` iteratively paginate through all missed historical events across page boundaries until `hasMore === false`.

4. **Buffer Overflow Safety Barrier**:
   - Concurrent live events during historical catch-up are buffered up to 500 events. Exceeding this capacity halts handoff and triggers authoritative reconciliation (`BUFFER_OVERFLOW`), preventing unbounded memory growth or silent dropped events.

5. **Decoupled Framing & Transport**:
   - `@aegis/contracts` defines the typed SSE wire framing (`serializeSseEnvelope`, `deserializeSseEnvelope`) completely decoupled from Fastify and React.
   - `mapExecutionEventToSseEnvelope` polymorphically adapts `RunEvent`, `EventEnvelope`, and `TaskAssignmentEnvelope` without mutating domain identity or timestamps.

6. **Multi-Replica Fan-Out via Per-Instance Groups**:
   - Each API replica runs an independent Kafka consumer with a unique group ID (`${groupId}-sse-${instanceId}`).
   - Every replica receives all execution events and broadcasts them to its locally connected SSE clients whose `runId` matches the event's `aggregateId`.

7. **Run-Scoped Isolation & Connection Multiplexing**:
   - Multiple browser components or hooks watching the same `runId` share a single underlying `EventSource` connection managed by `SseExecutionStreamClient`.
   - Different `runId` streams remain strictly isolated; connections never receive events for other runs.

8. **Client-Side Deduplication & Terminal State Protection**:
   - `SseExecutionStreamClient` tracks latest event IDs and maintains an LRU seen-events cache.
   - The Console execution reducer deduplicates replayed events chronologically and strictly locks terminal run/task statuses (`completed`, `failed`, `cancelled`) against regression from stale snapshots.

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

### Phase 13D — Durable Replay & Console Integration
- `replay.ts`: Replay request/result schemas, compound `(timestamp, id)` cursor codecs, error contracts, and repository interfaces.
- `PostgresRunEventReplayRepository.ts`: Production PostgreSQL replay repository with compound keyset pagination, limit + 1 boundary detection, and cross-run cursor rejection.
- `InMemoryRunEventReplayRepository.ts`: In-memory implementation of replay repository for deterministic testing and local offline runs.
- `sseReplayCoordinator.ts`: Multi-page historical replay coordinator, buffer draining, duplicate filtering, and overflow handling.
- `SseExecutionStreamClient.ts`: Tracked latest event IDs per run, automatic `lastEventId` query param injection, and `reconcileRequired` error detection.
- `useExecutionStream.ts`: Automatic invocation of `onReconcile` on gap/overflow errors, with `reconcileState` dispatch.
- `execution.reducer.ts`: `RECONCILE_STATE` action supporting authoritative snapshot merging with event deduplication and terminal state protection.

---

## 4. Verification & Test Metrics

- Monorepo test suite: **153 test files passed**, **1,300 tests passed**, 3 skipped, 0 failures.
- Unit and integration tests verify:
  1. Serialization / deserialization roundtrip determinism.
  2. Adapter validation and identity preservation.
  3. API consumer group registration and shutdown hooks.
  4. Run isolation and concurrent connection fan-out.
  5. Multi-subscriber multiplexing and deduplication.
  6. Replay cursor encoding/decoding and deterministic compound ordering.
  7. Multi-page loop pagination across historical database events.
  8. Concurrent live buffering and deduplicated handoff.
  9. Buffer overflow halt (>500 events) and gap detection error framing.
  10. Client-side reconnection cursor propagation, automatic state reconciliation, and terminal state regression protection.
