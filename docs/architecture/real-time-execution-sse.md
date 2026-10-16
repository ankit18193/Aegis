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

### Phase 13E — End-to-End Streaming Hardening
- `sseConnection.ts`: Connection lifecycle safety, slow-consumer backpressure timeout (5,000ms) with proactive socket eviction, event listener cleanup on stream abort, and immediate buffer memory reclamation (`clearBuffer()`, `disableBuffering()`).
- `sseReplayCoordinator.ts`: Continuous while-loop buffer draining to capture concurrent in-flight arrivals, boundary deduplication across multi-page replay windows, prevention of silent success on drain/overflow failures, and strict cross-run replay lockout.
- `sseTransportManager.ts`: Robust multi-connection teardown using `Promise.allSettled`, cross-run broadcast leakage prevention.
- `useExecutionStream.ts`: Atomic run switching resetting state and preventing event ID bleeding, in-flight reconciliation request deduplication guard, and non-blocking manual retry resilience.
- `execution.reducer.ts`: Strict run status and task status terminal monotonicity (`completed`, `failed`, `cancelled`), preventing state regression from delayed stream events or stale reconciliation snapshots.
- `SseExecutionStreamClient.ts`: Stream-level run isolation dropping foreign events before recording cursor updates, preventing cursor pollution.
- `streamingHardeningMatrix.test.ts`: Deterministic failure matrix for mid-stream disconnects, broker deduplication, cross-run cursor rejection, retention gap detection, buffer overflow threshold, persistence fault injection, and Fastify transport routes.
- `concurrentClientsRecovery.test.ts`: Concurrent clients on same run with independent replay cursors, slow consumer isolation without fast consumer degradation, mass server close recovery, and gateway fanout.
- `streamingPerformanceLimits.test.ts`: 1,000-message burst throughput benchmark (<70ms), 64KB+ large structured payload fidelity roundtrip, 500-event buffer threshold boundary enforcement, and 50-client simultaneous broadcast fanout.

---

## 4. Operational Guarantees & Known Limitations

### Core Operational Guarantees
1. **Durable Authority**: PostgreSQL is the single source of truth for execution state. Transport failures or dropped SSE connections never alter run status, fail worker tasks, or corrupt event streams.
2. **Terminal State Monotonicity**: Once a run or task transitions to a terminal state (`completed`, `failed`, `cancelled`), neither delayed out-of-order events nor stale database replica reconciliation snapshots can revert it back to an active state.
3. **Lossless Replay Catch-Up**: Clients reconnecting with a valid `Last-Event-ID` compound cursor `(timestamp, id)` receive all intervening historical events followed by all buffered live events in strict chronological order without duplicates.
4. **Fast Consumer Protection**: If an individual client experiences network degradation or backpressure exceeding the 5,000ms drain timeout, that specific socket is evicted and destroyed (`backpressure_timeout`), while other concurrent consumers on the same run continue receiving real-time updates without latency penalty.
5. **Strict Stream Isolation**: All transport layers (API endpoint, Replay Coordinator, Transport Manager, Connection, and Console Client) enforce run isolation. Cross-run events or cursors are rejected before serialization or timeline entry.
6. **Graceful Teardown**: Server shutdown cleanly terminates all active SSE connections using `Promise.allSettled`, ensuring all streams emit closed frames and release memory without hanging sockets or unhandled rejections.

### Explicit Operational Limitations
1. **Node-Local In-Memory Replay Buffer**:
   - The live event buffer during replay catch-up is stored in process memory on the specific API server instance holding the client connection.
   - Buffer size is strictly capped at **500 events**. If a client's historical replay catch-up takes long enough that more than 500 live events arrive, the coordinator intentionally halts handoff and emits a `BUFFER_OVERFLOW` error with `reconcileRequired: true`.
2. **Reconnection Target Node Independence**:
   - Because the live buffer is node-local, if a client reconnects to a different API replica behind a load balancer, it must supply its latest compound `Last-Event-ID` cursor to perform keyset pagination against PostgreSQL. Cross-replica session stickiness is neither assumed nor required.
3. **Single Envelope Maximum Payload Size**:
   - SSE packets are optimized for execution events and tool outputs under 1MB. Massive tool execution outputs (e.g. multi-gigabyte files or binary blobs) must be written to artifact storage with URI references passed in `RunEvent.metadata`.
4. **Client Connection Concurrency**:
   - Browser HTTP/1.1 limits (typically 6 concurrent SSE connections per domain) apply unless HTTP/2 is enabled at the ingress proxy or API gateway.

---

## 5. Verification & Test Metrics

- Monorepo test suite: **157 test files passed**, **1,330+ tests passed**, 3 skipped, 0 failures.
- Zero TypeScript diagnostics (`tsc --build` exits with code 0).
- Zero ESLint warnings (`eslint . --max-warnings 0` exits with code 0).
- Monorepo package build: 9/9 packages built cleanly for production.
- Full real-time execution streaming verification covers:
  1. Serialization / deserialization roundtrip determinism and SSE spec adherence.
  2. Adapter validation and polymorphic identity preservation.
  3. API consumer group registration and shutdown hooks.
  4. Run isolation and concurrent connection fan-out.
  5. Multi-subscriber multiplexing and deduplication.
  6. Replay cursor encoding/decoding and deterministic compound ordering.
  7. Multi-page loop pagination across historical database events.
  8. Concurrent live buffering and deduplicated handoff.
  9. Buffer overflow halt (>500 events) and gap detection error framing.
  10. Client-side reconnection cursor propagation, automatic state reconciliation, and terminal state regression protection.
  11. High-throughput burst streaming (1,000 events in <70ms) and large payload (>60KB) integrity.
  12. Slow consumer eviction and concurrent client isolation.

---

## 6. Phase 13 Sign-off & Roadmap Handoff

Phase 13 (Real-Time Execution Event Streaming) is **officially complete and signed off** across all 5 sub-phases:
- **Phase 13A**: State Model & Event Reducer (Console state foundation).
- **Phase 13B**: SSE Wire Framing & Fastify Transport Foundation (W3C text/event-stream).
- **Phase 13C**: Live Event Gateway & Console Client (Kafka bridge & EventSource client).
- **Phase 13D**: Durable Replay & Console Integration (Keyset replay & state reconciliation).
- **Phase 13E**: End-to-End Streaming Hardening (Production-grade concurrency, isolation, and limits).

Aegis is now ready to proceed to **Phase 14 (Authentication, Authorization & Multi-Tenancy)**.
