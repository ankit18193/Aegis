import {
  createSseClosedEnvelope,
  createSseConnectedEnvelope,
  createSseErrorEnvelope,
  createSseExecutionEnvelope,
  type RunEvent,
} from "@aegis/contracts";
import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamEvent,
} from "./executionStream.types";
import {
  SseExecutionStreamClient,
  type SseExecutionStreamClientOptions,
} from "./SseExecutionStreamClient";

/**
 * Deterministic MockEventSource for testing SseExecutionStreamClient in jsdom / Node.
 */
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;

  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
  }

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockEventSource.OPEN;
    const event = new Event("open");
    for (const listener of this.listeners.get("open") ?? []) {
      listener(event);
    }
  }

  simulateNamedEvent(eventName: string, data: string): void {
    const event = new MessageEvent(eventName, { data });
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }

  simulateMessage(data: string): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  simulateError(opts: { readyState?: number; data?: string } = {}): void {
    if (opts.readyState !== undefined) {
      this.readyState = opts.readyState;
    }
    const event = opts.data
      ? new MessageEvent("error", { data: opts.data })
      : new Event("error");

    for (const listener of this.listeners.get("error") ?? []) {
      listener(event);
    }
  }

  getListenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function createSampleRunEvent(rId: string, evtId: string, message = "Task started"): RunEvent {
  return {
    id: eventId(evtId),
    runId: runId(rId),
    taskId: taskId(`task-${rId}-1`),
    type: "task_started",
    severity: "info",
    timestamp: "2026-10-15T12:00:00.000Z",
    message,
  };
}

describe("SseExecutionStreamClient", () => {
  function createTestClient(opts: Partial<SseExecutionStreamClientOptions> = {}) {
    const instances: MockEventSource[] = [];
    const eventSourceFactory = vi.fn((url: string, init?: EventSourceInit) => {
      const es = new MockEventSource(url, init);
      instances.push(es);
      return es as unknown as EventSource;
    });

    const client = new SseExecutionStreamClient({
      baseUrl: "http://localhost:3001",
      endpointPath: "/api/v1/stream/transport",
      eventSourceFactory,
      ...opts,
    });

    return { client, instances, eventSourceFactory };
  }

  describe("Initialization & URL Formation", () => {
    it("initializes with default or custom initial connection state", () => {
      const { client: defaultClient } = createTestClient();
      expect(defaultClient.getConnectionState()).toBe("disconnected");
      expect(defaultClient.getActiveSessionCount()).toBe(0);

      const { client: customClient } = createTestClient({
        initialConnectionState: "connecting",
      });
      expect(customClient.getConnectionState()).toBe("connecting");
    });

    it("constructs proper stream URL with query parameters", () => {
      const { client, instances } = createTestClient();
      client.subscribe("run-abc-123", { onEvent: vi.fn() });

      expect(instances).toHaveLength(1);
      expect(instances[0]?.url).toBe("http://localhost:3001/api/v1/stream/transport?runId=run-abc-123");
    });

    it("passes withCredentials option to eventSourceFactory", () => {
      const { client, instances } = createTestClient({ withCredentials: true });
      client.subscribe("run-1", { onEvent: vi.fn() });

      expect(instances[0]?.withCredentials).toBe(true);
    });

    it("rejects empty or whitespace runId", () => {
      const { client } = createTestClient();
      expect(() => client.subscribe("", { onEvent: vi.fn() })).toThrow(/runId must be a non-empty string/);
      expect(() => client.subscribe("   ", { onEvent: vi.fn() })).toThrow(/runId must be a non-empty string/);
    });

    it("rejects subscription after client is disposed", () => {
      const { client } = createTestClient();
      client.dispose();
      expect(() => client.subscribe("run-1", { onEvent: vi.fn() })).toThrow(
        /Cannot subscribe to a disposed SseExecutionStreamClient/,
      );
    });
  });

  describe("Connection Lifecycle & State Transitions", () => {
    it("notifies subscriber of initial connecting state upon subscribe()", () => {
      const { client } = createTestClient();
      const stateHistory: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (state) => stateHistory.push(state),
      });

      expect(stateHistory).toEqual(["connecting"]);
      expect(client.getConnectionState()).toBe("connecting");
    });

    it("transitions to connected when EventSource open event fires", () => {
      const { client, instances } = createTestClient();
      const stateHistory: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (state) => stateHistory.push(state),
      });

      instances[0]?.simulateOpen();

      expect(stateHistory).toEqual(["connecting", "connected"]);
      expect(client.getConnectionState()).toBe("connected");
      expect(client.getSessionConnectionState("run-1")).toBe("connected");
    });

    it("transitions to connected when SSE connected envelope is received", () => {
      const { client, instances } = createTestClient();
      const stateHistory: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (state) => stateHistory.push(state),
      });

      const connectedEnv = createSseConnectedEnvelope({
        id: eventId("conn-1"),
        streamId: "stream-1",
        heartbeatIntervalMs: 15000,
        runId: runId("run-1"),
      });

      instances[0]?.simulateNamedEvent("connected", JSON.stringify(connectedEnv));

      expect(stateHistory).toEqual(["connecting", "connected"]);
    });

    it("aggregates connection state correctly across multiple sessions", () => {
      const { client, instances } = createTestClient();

      client.subscribe("run-1", { onEvent: vi.fn() });
      client.subscribe("run-2", { onEvent: vi.fn() });

      expect(client.getConnectionState()).toBe("connecting");

      instances[0]?.simulateOpen();
      // One connected, one connecting -> aggregate is connected
      expect(client.getConnectionState()).toBe("connected");

      instances[1]?.simulateOpen();
      expect(client.getConnectionState()).toBe("connected");
    });
  });

  describe("Event Delivery & Deduplication", () => {
    it("delivers execution events to subscriber via named execution event", () => {
      const { client, instances } = createTestClient();
      const delivered: ExecutionStreamEvent[] = [];

      client.subscribe("run-1", {
        onEvent: (event) => delivered.push(event),
      });

      const domainEvent = createSampleRunEvent("run-1", "evt-1", "Starting task");
      const envelope = createSseExecutionEnvelope(domainEvent);

      instances[0]?.simulateNamedEvent("execution", JSON.stringify(envelope));

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.id).toBe("evt-1");
      expect(delivered[0]?.message).toBe("Starting task");
    });

    it("delivers execution events arriving via generic message fallback", () => {
      const { client, instances } = createTestClient();
      const delivered: ExecutionStreamEvent[] = [];

      client.subscribe("run-1", {
        onEvent: (event) => delivered.push(event),
      });

      const domainEvent = createSampleRunEvent("run-1", "evt-fallback", "Fallback message");
      const envelope = createSseExecutionEnvelope(domainEvent);

      instances[0]?.simulateMessage(JSON.stringify(envelope));

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.id).toBe("evt-fallback");
    });

    it("deduplicates identical events within the same session", () => {
      const { client, instances } = createTestClient();
      const delivered: ExecutionStreamEvent[] = [];

      client.subscribe("run-1", {
        onEvent: (event) => delivered.push(event),
      });

      const domainEvent = createSampleRunEvent("run-1", "evt-dup", "Duplicate message");
      const envelope = createSseExecutionEnvelope(domainEvent);
      const envelopeJson = JSON.stringify(envelope);

      instances[0]?.simulateNamedEvent("execution", envelopeJson);
      instances[0]?.simulateNamedEvent("execution", envelopeJson);
      instances[0]?.simulateMessage(envelopeJson);

      expect(delivered).toHaveLength(1);
    });

    it("handles malformed JSON payloads gracefully by reporting error", () => {
      const { client, instances } = createTestClient();
      const errors: ExecutionStreamError[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onError: (err) => errors.push(err),
      });

      instances[0]?.simulateNamedEvent("execution", "{ malformed json");

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("DESERIALIZATION_ERROR");
      expect(errors[0]?.retryable).toBe(true);
    });
  });

  describe("Multiplexing & Multi-Subscriber Lifecycle", () => {
    it("shares a single EventSource connection across multiple subscribers to the same runId", () => {
      const { client, instances, eventSourceFactory } = createTestClient();
      const run1EventsA: ExecutionStreamEvent[] = [];
      const run1EventsB: ExecutionStreamEvent[] = [];

      const subA = client.subscribe("run-1", { onEvent: (e) => run1EventsA.push(e) });
      const subB = client.subscribe("run-1", { onEvent: (e) => run1EventsB.push(e) });

      expect(eventSourceFactory).toHaveBeenCalledTimes(1);
      expect(client.getActiveSessionCount()).toBe(1);
      expect(client.getSubscriberCount("run-1")).toBe(2);

      const domainEvent = createSampleRunEvent("run-1", "evt-shared");
      const envelope = createSseExecutionEnvelope(domainEvent);

      instances[0]?.simulateNamedEvent("execution", JSON.stringify(envelope));

      expect(run1EventsA).toHaveLength(1);
      expect(run1EventsB).toHaveLength(1);

      // Unsubscribe subscriber A
      subA.unsubscribe();
      expect(subA.isClosed()).toBe(true);
      expect(client.getSubscriberCount("run-1")).toBe(1);
      expect(instances[0]?.readyState).toBe(MockEventSource.CONNECTING); // Not closed yet

      // Subscriber B still receives subsequent events
      const secondEvent = createSampleRunEvent("run-1", "evt-shared-2");
      instances[0]?.simulateNamedEvent("execution", JSON.stringify(createSseExecutionEnvelope(secondEvent)));

      expect(run1EventsA).toHaveLength(1);
      expect(run1EventsB).toHaveLength(2);

      // Unsubscribe subscriber B — session closes
      subB.unsubscribe();
      expect(subB.isClosed()).toBe(true);
      expect(client.getActiveSessionCount()).toBe(0);
      expect(instances[0]?.readyState).toBe(MockEventSource.CLOSED);
    });

    it("maintains strict run isolation across distinct run IDs", () => {
      const { client, instances, eventSourceFactory } = createTestClient();
      const run1Events: ExecutionStreamEvent[] = [];
      const run2Events: ExecutionStreamEvent[] = [];

      client.subscribe("run-1", { onEvent: (e) => run1Events.push(e) });
      client.subscribe("run-2", { onEvent: (e) => run2Events.push(e) });

      expect(eventSourceFactory).toHaveBeenCalledTimes(2);
      expect(client.getActiveSessionCount()).toBe(2);

      const evtRun1 = createSampleRunEvent("run-1", "evt-r1");
      instances[0]?.simulateNamedEvent("execution", JSON.stringify(createSseExecutionEnvelope(evtRun1)));

      expect(run1Events).toHaveLength(1);
      expect(run2Events).toHaveLength(0);

      const evtRun2 = createSampleRunEvent("run-2", "evt-r2");
      instances[1]?.simulateNamedEvent("execution", JSON.stringify(createSseExecutionEnvelope(evtRun2)));

      expect(run1Events).toHaveLength(1);
      expect(run2Events).toHaveLength(1);
    });
  });

  describe("Error and Closure Protocols", () => {
    it("handles custom SSE error envelopes from the server", () => {
      const { client, instances } = createTestClient();
      const errors: ExecutionStreamError[] = [];
      const states: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (s) => states.push(s),
        onError: (err) => errors.push(err),
      });

      const errorEnv = createSseErrorEnvelope({
        id: eventId("err-1"),
        code: "RUN_NOT_FOUND",
        message: "Execution run 'run-1' does not exist",
        retryable: false,
        runId: runId("run-1"),
      });

      instances[0]?.simulateError({ data: JSON.stringify(errorEnv) });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("RUN_NOT_FOUND");
      expect(errors[0]?.retryable).toBe(false);
      expect(states).toContain("error");
    });

    it("handles native browser EventSource reconnecting error (readyState 0)", () => {
      const { client, instances } = createTestClient();
      const errors: ExecutionStreamError[] = [];
      const states: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (s) => states.push(s),
        onError: (err) => errors.push(err),
      });

      instances[0]?.simulateOpen();
      instances[0]?.simulateError({ readyState: MockEventSource.CONNECTING });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("CONNECTION_ERROR");
      expect(errors[0]?.retryable).toBe(true);
      expect(states[states.length - 1]).toBe("connecting");
    });

    it("handles native browser EventSource terminal close (readyState 2)", () => {
      const { client, instances } = createTestClient();
      const errors: ExecutionStreamError[] = [];
      const states: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (s) => states.push(s),
        onError: (err) => errors.push(err),
      });

      instances[0]?.simulateOpen();
      instances[0]?.simulateError({ readyState: MockEventSource.CLOSED });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("CONNECTION_CLOSED");
      expect(errors[0]?.retryable).toBe(false);
      expect(states[states.length - 1]).toBe("error");
    });

    it("handles terminal closed envelope and closes session cleanly", () => {
      const { client, instances } = createTestClient();
      const states: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (s) => states.push(s),
      });

      instances[0]?.simulateOpen();

      const closedEnv = createSseClosedEnvelope({
        id: eventId("close-1"),
        reason: "run_completed",
        terminal: true,
        runId: runId("run-1"),
      });

      instances[0]?.simulateNamedEvent("closed", JSON.stringify(closedEnv));

      expect(states[states.length - 1]).toBe("disconnected");
      expect(instances[0]?.readyState).toBe(MockEventSource.CLOSED);
      expect(client.getActiveSessionCount()).toBe(0);
    });
  });

  describe("Disposal & Cleanup", () => {
    it("disposes all active sessions and removes event listeners", () => {
      const { client, instances } = createTestClient();
      const statesA: ConnectionState[] = [];
      const statesB: ConnectionState[] = [];

      client.subscribe("run-1", {
        onEvent: vi.fn(),
        onStateChange: (s) => statesA.push(s),
      });
      client.subscribe("run-2", {
        onEvent: vi.fn(),
        onStateChange: (s) => statesB.push(s),
      });

      expect(client.getActiveSessionCount()).toBe(2);

      client.dispose();

      expect(client.getActiveSessionCount()).toBe(0);
      expect(client.getConnectionState()).toBe("disconnected");
      expect(instances[0]?.readyState).toBe(MockEventSource.CLOSED);
      expect(instances[1]?.readyState).toBe(MockEventSource.CLOSED);
      expect(statesA[statesA.length - 1]).toBe("disconnected");
      expect(statesB[statesB.length - 1]).toBe("disconnected");

      // Idempotent dispose
      expect(() => client.dispose()).not.toThrow();
    });
  });
});
