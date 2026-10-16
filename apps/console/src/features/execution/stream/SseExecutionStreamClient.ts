/**
 * SseExecutionStreamClient — Phase 13C (Commit 3)
 *
 * Browser-side Server-Sent Events client implementing IExecutionStreamClient.
 * Connects the Aegis Console UI to the Fastify SSE gateway endpoint
 * (`/api/v1/stream/transport?runId=<runId>`) using the standard EventSource API.
 *
 * Architectural Invariants:
 * 1. Interface conformance: implements `IExecutionStreamClient` identically to MockExecutionStreamClient.
 * 2. Run isolation: manages distinct EventSource connections per `runId`.
 * 3. Connection multiplexing: multiple subscribers to the same `runId` share a single EventSource stream.
 * 4. Idempotency & deduplication: deduplicates events by canonical `EventId` within an active session.
 * 5. Lifecycle safety: deterministic cleanup on unsubscribe and disposal with zero leaked listeners.
 * 6. Resilient protocol handling: handles standard SSE named frames (`execution`, `connected`, `closed`, `error`, `heartbeat`)
 *    as well as generic `message` events and native network error transitions.
 */

import {
  deserializeSseEnvelope,
} from "@aegis/contracts";

import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamEvent,
  ExecutionStreamListener,
  StreamSubscribeOptions,
  StreamSubscription,
} from "./executionStream.types";
import type { IExecutionStreamClient } from "./IExecutionStreamClient";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Options
// ─────────────────────────────────────────────────────────────────────────────

export interface SseExecutionStreamClientOptions {
  /**
   * Base URL of the Aegis API service (e.g. "http://localhost:3001").
   * Defaults to import.meta.env.VITE_API_URL ?? "http://localhost:3001".
   */
  readonly baseUrl?: string;

  /**
   * SSE endpoint path. Defaults to "/api/v1/stream/transport".
   */
  readonly endpointPath?: string;

  /**
   * Factory function to create an EventSource instance.
   * Enables injecting mocks or custom EventSource implementations for tests.
   */
  readonly eventSourceFactory?: (url: string, init?: EventSourceInit) => EventSource;

  /**
   * Whether to send credentials (cookies, authorization) with SSE requests.
   * Defaults to false.
   */
  readonly withCredentials?: boolean;

  /**
   * Initial connection state reported before any active subscriptions exist.
   * Defaults to "disconnected".
   */
  readonly initialConnectionState?: ConnectionState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Session Representation
// ─────────────────────────────────────────────────────────────────────────────

interface RunStreamSession {
  readonly runId: string;
  readonly eventSource: EventSource;
  readonly subscribers: Set<ExecutionStreamListener>;
  readonly seenEventIds: Set<string>;
  connectionState: ConnectionState;
  lastError: ExecutionStreamError | null;
  cleanup: () => void;
}

const DEFAULT_ENDPOINT_PATH = "/api/v1/stream/transport";
const MAX_SEEN_CACHE_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// SseExecutionStreamClient
// ─────────────────────────────────────────────────────────────────────────────

export class SseExecutionStreamClient implements IExecutionStreamClient {
  private readonly baseUrl: string;
  private readonly endpointPath: string;
  private readonly eventSourceFactory: (url: string, init?: EventSourceInit) => EventSource;
  private readonly withCredentials: boolean;
  private readonly initialConnectionState: ConnectionState;

  private readonly sessions = new Map<string, RunStreamSession>();
  private readonly latestEventIds = new Map<string, string>();
  private disposed = false;

  constructor(options: SseExecutionStreamClientOptions = {}) {
    const envBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

    this.baseUrl = options.baseUrl ?? envBaseUrl;
    this.endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
    this.withCredentials = options.withCredentials ?? false;
    this.initialConnectionState = options.initialConnectionState ?? "disconnected";

    this.eventSourceFactory =
      options.eventSourceFactory ??
      ((url: string, init?: EventSourceInit) => {
        if (typeof EventSource === "undefined") {
          throw new Error(
            "EventSource is not supported in this environment. Provide an eventSourceFactory option or ensure a polyfill is present.",
          );
        }
        return new EventSource(url, init);
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IExecutionStreamClient Implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns current aggregate connection state across active run stream sessions.
   */
  public getConnectionState(): ConnectionState {
    if (this.disposed) {
      return "disconnected";
    }

    if (this.sessions.size === 0) {
      return this.initialConnectionState;
    }

    let hasConnecting = false;
    let hasError = false;

    for (const session of this.sessions.values()) {
      if (session.connectionState === "connected") {
        return "connected";
      }
      if (session.connectionState === "connecting") {
        hasConnecting = true;
      }
      if (session.connectionState === "error") {
        hasError = true;
      }
    }

    if (hasConnecting) return "connecting";
    if (hasError) return "error";
    return "disconnected";
  }

  /**
   * Subscribes to real-time execution events for a specific run ID.
   * Multiple subscriptions to the same runId share a single EventSource stream.
   */
  public subscribe(
    runIdStr: string,
    listener: ExecutionStreamListener,
    options?: StreamSubscribeOptions,
  ): StreamSubscription {
    if (this.disposed) {
      throw new Error("Cannot subscribe to a disposed SseExecutionStreamClient");
    }

    if (!runIdStr || typeof runIdStr !== "string" || runIdStr.trim().length === 0) {
      throw new Error("runId must be a non-empty string");
    }

    if (options?.fromEventId) {
      this.latestEventIds.set(runIdStr, options.fromEventId);
    }

    let session = this.sessions.get(runIdStr);

    if (session) {
      session.subscribers.add(listener);
      // Immediately notify listener of the session's active connection state
      listener.onStateChange?.(session.connectionState);
      if (session.lastError && session.connectionState === "error") {
        listener.onError?.(session.lastError);
      }
    } else {
      session = this.createSession(runIdStr, options?.fromEventId);
      this.sessions.set(runIdStr, session);
      session.subscribers.add(listener);
      // Notify initial connecting state
      listener.onStateChange?.(session.connectionState);
    }

    let closed = false;

    return {
      runId: runIdStr,
      unsubscribe: () => {
        if (closed) return;
        closed = true;

        session.subscribers.delete(listener);

        if (session.subscribers.size === 0) {
          this.closeSession(runIdStr);
        }
      },
      isClosed: () => closed,
    };
  }

  /**
   * Disposes the client, closing all active EventSource streams and releasing resources.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const session of this.sessions.values()) {
      session.cleanup();
      for (const subscriber of session.subscribers) {
        subscriber.onStateChange?.("disconnected");
      }
    }
    this.sessions.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Diagnostic and Inspection APIs (Useful for testing)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the count of active run streaming sessions.
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Returns the subscriber count for a given run ID.
   */
  public getSubscriberCount(runIdStr: string): number {
    return this.sessions.get(runIdStr)?.subscribers.size ?? 0;
  }

  /**
   * Returns the connection state for a specific run ID session, if active.
   */
  public getSessionConnectionState(runIdStr: string): ConnectionState | undefined {
    return this.sessions.get(runIdStr)?.connectionState;
  }

  /**
   * Returns the latest seen event ID for a given run ID.
   */
  public getLastEventId(runIdStr: string): string | undefined {
    return this.latestEventIds.get(runIdStr);
  }

  /**
   * Sets the latest known event ID for a run ID (e.g. from initial REST payload).
   */
  public setLastEventId(runIdStr: string, evtId: string): void {
    this.latestEventIds.set(runIdStr, evtId);
  }

  /**
   * Clears the recorded latest event ID for a run ID.
   */
  public clearLastEventId(runIdStr: string): void {
    this.latestEventIds.delete(runIdStr);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Session & EventSource Management
  // ─────────────────────────────────────────────────────────────────────────

  private buildStreamUrl(runIdStr: string, cursor?: string): string {
    const normalizedBase = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = this.endpointPath.startsWith("/")
      ? this.endpointPath
      : `/${this.endpointPath}`;
    const url = new URL(`${normalizedBase}${normalizedPath}`);
    url.searchParams.set("runId", runIdStr);
    const cursorToUse = cursor ?? this.latestEventIds.get(runIdStr);
    if (cursorToUse) {
      url.searchParams.set("lastEventId", cursorToUse);
    }
    return url.toString();
  }

  private createSession(runIdStr: string, cursor?: string): RunStreamSession {
    const streamUrl = this.buildStreamUrl(runIdStr, cursor);
    const eventSource = this.eventSourceFactory(streamUrl, {
      withCredentials: this.withCredentials,
    });

    const session: RunStreamSession = {
      runId: runIdStr,
      eventSource,
      subscribers: new Set(),
      seenEventIds: new Set(),
      connectionState: "connecting",
      lastError: null,
      cleanup: () => {
        // Will be populated with event listener removal logic
      },
    };

    // 1. Native open handler
    const onOpen = (): void => {
      session.connectionState = "connected";
      session.lastError = null;
      for (const sub of session.subscribers) {
        sub.onStateChange?.("connected");
      }
    };

    // 2. Execution event handler
    const onExecution = (event: MessageEvent): void => {
      this.handleIncomingExecution(session, event.data as string);
    };

    // 3. Connected event handler
    const onConnected = (_event: MessageEvent): void => {
      session.connectionState = "connected";
      session.lastError = null;
      for (const sub of session.subscribers) {
        sub.onStateChange?.("connected");
      }
    };

    // 4. Closed event handler
    const onClosed = (event: MessageEvent): void => {
      this.handleIncomingClosed(session, event.data as string);
    };

    // 5. Error event handler (both custom SSE error frames and native network errors)
    const onError = (event: Event): void => {
      this.handleIncomingError(session, event);
    };

    // 6. Generic message fallback handler
    const onMessage = (event: MessageEvent): void => {
      this.handleIncomingMessageFallback(session, event.data as string);
    };

    // Attach event listeners
    eventSource.addEventListener("open", onOpen);
    eventSource.addEventListener("execution", onExecution as EventListener);
    eventSource.addEventListener("connected", onConnected as EventListener);
    eventSource.addEventListener("closed", onClosed as EventListener);
    eventSource.addEventListener("error", onError);
    eventSource.addEventListener("message", onMessage as EventListener);

    session.cleanup = () => {
      eventSource.removeEventListener("open", onOpen);
      eventSource.removeEventListener("execution", onExecution as EventListener);
      eventSource.removeEventListener("connected", onConnected as EventListener);
      eventSource.removeEventListener("closed", onClosed as EventListener);
      eventSource.removeEventListener("error", onError);
      eventSource.removeEventListener("message", onMessage as EventListener);

      try {
        eventSource.close();
      } catch {
        // Guard against close errors if already terminated
      }
    };

    return session;
  }

  private closeSession(runIdStr: string): void {
    const session = this.sessions.get(runIdStr);
    if (!session) return;

    session.cleanup();
    session.connectionState = "disconnected";
    for (const sub of session.subscribers) {
      sub.onStateChange?.("disconnected");
    }
    this.sessions.delete(runIdStr);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Incoming Message Decoders & Fan-out
  // ─────────────────────────────────────────────────────────────────────────

  private handleIncomingExecution(session: RunStreamSession, rawData: string): void {
    if (typeof rawData !== "string" || rawData.trim().length === 0) return;

    const parseRes = deserializeSseEnvelope({ data: rawData });
    if (!parseRes.ok) {
      this.notifySessionError(session, {
        code: "DESERIALIZATION_ERROR",
        message: parseRes.error.message,
        retryable: true,
        cause: parseRes.error,
      });
      return;
    }

    const envelope = parseRes.value;
    if (envelope.type !== "execution") return;

    // Deduplication check: prevent duplicate dispatch if re-streamed or reconnected
    if (session.seenEventIds.has(envelope.id)) {
      return;
    }

    const runEvent: ExecutionStreamEvent = envelope.payload;

    // Enforce stream isolation: drop event if it explicitly belongs to another run
    if (runEvent.runId && runEvent.runId !== session.runId) {
      return;
    }

    session.seenEventIds.add(envelope.id);
    this.latestEventIds.set(session.runId, envelope.id);

    if (session.seenEventIds.size > MAX_SEEN_CACHE_SIZE) {
      const oldestId = session.seenEventIds.values().next().value;
      if (oldestId) {
        session.seenEventIds.delete(oldestId);
      }
    }

    for (const sub of session.subscribers) {
      try {
        sub.onEvent(runEvent);
      } catch {
        // Prevent faulty subscriber callbacks from breaking execution stream loop
      }
    }
  }

  private handleIncomingClosed(session: RunStreamSession, rawData: string): void {
    let terminal = false;

    if (typeof rawData === "string" && rawData.trim().length > 0) {
      const parseRes = deserializeSseEnvelope({ data: rawData });
      if (parseRes.ok && parseRes.value.type === "closed") {
        terminal = parseRes.value.payload.terminal;
      }
    }

    session.connectionState = "disconnected";
    for (const sub of session.subscribers) {
      sub.onStateChange?.("disconnected");
    }

    if (terminal) {
      this.closeSession(session.runId);
    }
  }

  private handleIncomingError(session: RunStreamSession, event: Event): void {
    const messageEvent = event as MessageEvent;

    // Check if this error event carried an SSE error frame payload in data
    if (typeof messageEvent.data === "string" && messageEvent.data.trim().length > 0) {
      const parseRes = deserializeSseEnvelope({ data: messageEvent.data });
      if (parseRes.ok && parseRes.value.type === "error") {
        const payload = parseRes.value.payload;
        const detailsObj = payload.details;
        const isReconcileRequired =
          payload.code === "BUFFER_OVERFLOW" ||
          payload.code === "REPLAY_GAP_DETECTED" ||
          Boolean(detailsObj?.reconcileRequired);

        const streamErr: ExecutionStreamError = {
          code: payload.code,
          message: payload.message,
          retryable: payload.retryable,
          details: payload.details,
          reconcileRequired: isReconcileRequired,
        };

        session.connectionState = "error";
        session.lastError = streamErr;
        for (const sub of session.subscribers) {
          sub.onStateChange?.("error");
          sub.onError?.(streamErr);
        }
        return;
      }
    }

    // Native browser EventSource network error
    // In WHATWG EventSource: readyState 0 = CONNECTING (reconnecting), readyState 2 = CLOSED
    const isClosed = session.eventSource.readyState === 2;
    const newState: ConnectionState = isClosed ? "error" : "connecting";

    const streamErr: ExecutionStreamError = {
      code: isClosed ? "CONNECTION_CLOSED" : "CONNECTION_ERROR",
      message: isClosed
        ? "SSE connection closed unexpectedly"
        : "SSE transport disconnected; attempting to reconnect...",
      retryable: !isClosed,
      cause: event,
    };

    session.connectionState = newState;
    session.lastError = streamErr;

    for (const sub of session.subscribers) {
      sub.onStateChange?.(newState);
      sub.onError?.(streamErr);
    }
  }

  private handleIncomingMessageFallback(session: RunStreamSession, rawData: string): void {
    if (typeof rawData !== "string" || rawData.trim().length === 0) return;

    const parseRes = deserializeSseEnvelope({ data: rawData });
    if (!parseRes.ok) return;

    const envelope = parseRes.value;
    switch (envelope.type) {
      case "execution":
        this.handleIncomingExecution(session, rawData);
        break;
      case "connected":
        session.connectionState = "connected";
        session.lastError = null;
        for (const sub of session.subscribers) {
          sub.onStateChange?.("connected");
        }
        break;
      case "closed":
        this.handleIncomingClosed(session, rawData);
        break;
      case "error":
        this.notifySessionError(session, {
          code: envelope.payload.code,
          message: envelope.payload.message,
          retryable: envelope.payload.retryable,
        });
        break;
      case "heartbeat":
        // Keep-alive frame — connection confirmed alive
        break;
    }
  }

  private notifySessionError(session: RunStreamSession, streamErr: ExecutionStreamError): void {
    session.lastError = streamErr;
    for (const sub of session.subscribers) {
      sub.onError?.(streamErr);
    }
  }
}
