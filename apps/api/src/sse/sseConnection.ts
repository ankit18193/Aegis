/**
 * SSE Connection Lifecycle Manager — Phase 13B (Commit 3)
 *
 * Implements server-side SSE stream connection abstraction:
 * - Deterministic connection lifecycle: initializing -> open -> closing -> closed
 * - Robust backpressure handling with bounded drain timeouts
 * - Periodic keep-alive heartbeats (comment-based or typed event envelopes)
 * - Safe writes protecting against broken pipes (EPIPE, ERR_STREAM_DESTROYED)
 * - Explicit ownership and deterministic cleanup on client disconnect or server shutdown
 */

import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import {
  createSseClosedEnvelope,
  createSseErrorEnvelope,
  createSseExecutionEnvelope,
  createSseHeartbeatEnvelope,
  formatSseComment,
  REPLAY_MAX_BUFFER_CAPACITY,
  serializeSseEnvelope,
  type RunEvent,
  type SseErrorCode,
  type SseSerializeOptions,
  type SseTransportEnvelope,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { err, eventId, ok, runId as toRunId, type Result } from "@aegis/types";

import type {
  ISseConnection,
  SseConnectionError,
  SseConnectionOptions,
  SseConnectionStats,
  SseConnectionStatus,
} from "./types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export class SseConnection implements ISseConnection {
  readonly connectionId: string;
  readonly runId?: string | undefined;

  private _status: SseConnectionStatus = "initializing";
  private readonly targetStream: Writable;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMode: "comment" | "event";
  private readonly drainTimeoutMs: number;
  private readonly logger?: Logger | undefined;

  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private heartbeatSequence = 0;
  private readonly closeListeners = new Set<(reason: string) => void>();

  private messagesCount = 0;
  private bytesCount = 0;
  private heartbeatsCount = 0;
  private errorsCount = 0;
  private readonly connectedTimestamp: string;
  private closedTimestamp?: string | undefined;

  // ── Replay Buffering State ────────────────────────────────────────────────
  private _isBuffering = false;
  private _bufferOverflowed = false;
  private maxBufferCapacity = REPLAY_MAX_BUFFER_CAPACITY;
  private readonly replayBuffer: SseTransportEnvelope[] = [];
  public replayPromise?: Promise<unknown> | undefined;

  constructor(targetStream: Writable, options: SseConnectionOptions = {}) {
    this.targetStream = targetStream;
    this.connectionId = options.connectionId ?? randomUUID();
    this.runId = options.runId;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatMode = options.heartbeatMode ?? "comment";
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.logger = options.logger;
    this.connectedTimestamp = new Date().toISOString();
  }

  get status(): SseConnectionStatus {
    return this._status;
  }

  get isOpen(): boolean {
    return (
      this._status === "open" &&
      !this.targetStream.destroyed &&
      !this.targetStream.writableEnded
    );
  }

  get isClosed(): boolean {
    return (
      this._status === "closed" ||
      this.targetStream.destroyed ||
      this.targetStream.writableEnded
    );
  }

  get stats(): SseConnectionStats {
    return {
      messagesSent: this.messagesCount,
      bytesWritten: this.bytesCount,
      heartbeatsSent: this.heartbeatsCount,
      errorsEncountered: this.errorsCount,
      connectedAt: this.connectedTimestamp,
      closedAt: this.closedTimestamp,
    };
  }

  get isBuffering(): boolean {
    return this._isBuffering;
  }

  get isBufferOverflowed(): boolean {
    return this._bufferOverflowed;
  }

  get bufferSize(): number {
    return this.replayBuffer.length;
  }

  hasBufferOverflowed(): boolean {
    return this._bufferOverflowed;
  }

  enableBuffering(maxCapacity?: number): void {
    this._isBuffering = true;
    this._bufferOverflowed = false;
    this.maxBufferCapacity = maxCapacity ?? REPLAY_MAX_BUFFER_CAPACITY;
    this.replayBuffer.length = 0;
  }

  disableBuffering(): void {
    this._isBuffering = false;
  }

  clearBuffer(): void {
    this.replayBuffer.length = 0;
  }

  async drainBuffer(
    filterPredicate?: (envelope: SseTransportEnvelope) => boolean,
  ): Promise<Result<number, SseConnectionError>> {
    if (!this.isOpen) {
      this.clearBuffer();
      return err({
        code: "CONNECTION_CLOSED",
        message: `Cannot drain buffer: SSE connection '${this.connectionId}' is closed.`,
      });
    }

    let drainedCount = 0;

    // Concurrency hardening: loop until replayBuffer is fully drained, accounting for
    // concurrent events that arrive via sendEnvelope while earlier buffered batches are written.
    while (this.replayBuffer.length > 0) {
      if (this.hasBufferOverflowed()) {
        this.clearBuffer();
        return err({
          code: "BUFFER_OVERFLOW",
          message: `SSE replay buffer overflowed during drain on connection '${this.connectionId}'.`,
        });
      }

      const itemsToDrain = [...this.replayBuffer];
      this.replayBuffer.length = 0;

      for (const envelope of itemsToDrain) {
        if (filterPredicate && !filterPredicate(envelope)) {
          continue;
        }
        const writeRes = await this.sendDirectEnvelope(envelope);
        if (!writeRes.ok) {
          return writeRes;
        }
        drainedCount += 1;
      }
    }

    return ok(drainedCount);
  }

  /**
   * Opens the SSE connection and arms the heartbeat interval timer.
   */
  open(): Result<void, SseConnectionError> {
    if (this._status !== "initializing") {
      return err({
        code: "ALREADY_INITIALIZED",
        message: `SSE connection '${this.connectionId}' is already in state '${this._status}'.`,
      });
    }

    this._status = "open";

    // Bind stream close, finish, and error listeners
    this.targetStream.once("close", () => {
      this.handleStreamTermination("client_disconnected");
    });
    this.targetStream.once("finish", () => {
      this.handleStreamTermination("stream_finished");
    });
    this.targetStream.on("error", (streamErr) => {
      this.errorsCount += 1;
      this.logger?.warn("SSE stream encountered error", {
        connectionId: this.connectionId,
        error: streamErr.message,
      });
      this.handleStreamTermination("stream_error");
    });

    // Start periodic keep-alive heartbeat if configured
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.sendHeartbeat();
      }, this.heartbeatIntervalMs);

      // Prevent heartbeat timer from hanging Node.js test runs or process termination
      if (typeof this.heartbeatTimer.unref === "function") {
        this.heartbeatTimer.unref();
      }
    }

    this.logger?.debug("SSE connection opened", {
      connectionId: this.connectionId,
      runId: this.runId,
    });

    return ok(undefined);
  }

  /**
   * Serializes and writes a canonical SseTransportEnvelope directly to the stream,
   * bypassing the replay buffer.
   */
  async sendDirectEnvelope(
    envelope: SseTransportEnvelope,
    options?: SseSerializeOptions,
  ): Promise<Result<void, SseConnectionError>> {
    if (!this.isOpen) {
      return err({
        code: "CONNECTION_CLOSED",
        message: `Cannot write to SSE connection '${this.connectionId}': connection is not open.`,
      });
    }

    // Strict stream isolation: prevent cross-run event leakage
    if (this.runId && envelope.type === "execution") {
      const eventRunId = envelope.payload.runId;
      if (eventRunId && eventRunId !== this.runId) {
        this.errorsCount += 1;
        this.logger?.warn("Rejected cross-run execution envelope on direct write", {
          connectionId: this.connectionId,
          connectionRunId: this.runId,
          eventRunId,
        });
        return err({
          code: "CROSS_RUN_ISOLATION_VIOLATION",
          message: `Cannot send event for run '${eventRunId}' to SSE connection bound to run '${this.runId}'.`,
        });
      }
    }

    const serializeRes = serializeSseEnvelope(envelope, options);
    if (!serializeRes.ok) {
      this.errorsCount += 1;
      return err({
        code: "SERIALIZATION_ERROR",
        message: serializeRes.error.message,
        cause: serializeRes.error,
      });
    }

    const writeRes = await this.writeChunk(serializeRes.value);
    if (writeRes.ok) {
      this.messagesCount += 1;
    }
    return writeRes;
  }

  /**
   * Serializes and writes a canonical SseTransportEnvelope.
   * If buffering is enabled and envelope is execution type, it is enqueued into replayBuffer.
   */
  async sendEnvelope(
    envelope: SseTransportEnvelope,
    options?: SseSerializeOptions,
  ): Promise<Result<void, SseConnectionError>> {
    if (!this.isOpen) {
      return err({
        code: "CONNECTION_CLOSED",
        message: `Cannot write to SSE connection '${this.connectionId}': connection is not open.`,
      });
    }

    // Strict stream isolation: prevent cross-run event leakage
    if (this.runId && envelope.type === "execution") {
      const eventRunId = envelope.payload.runId;
      if (eventRunId && eventRunId !== this.runId) {
        this.errorsCount += 1;
        this.logger?.warn("Rejected cross-run execution envelope on sendEnvelope", {
          connectionId: this.connectionId,
          connectionRunId: this.runId,
          eventRunId,
        });
        return err({
          code: "CROSS_RUN_ISOLATION_VIOLATION",
          message: `Cannot send event for run '${eventRunId}' to SSE connection bound to run '${this.runId}'.`,
        });
      }
    }

    if (this._isBuffering && envelope.type === "execution") {
      if (this._bufferOverflowed) {
        return err({
          code: "BUFFER_OVERFLOW",
          message: `SSE replay buffer overflowed on connection '${this.connectionId}'. Safe handoff halted.`,
        });
      }

      if (this.replayBuffer.length >= this.maxBufferCapacity) {
        this._bufferOverflowed = true;
        this.errorsCount += 1;
        this.logger?.warn("SSE connection live buffer capacity exceeded", {
          connectionId: this.connectionId,
          runId: this.runId,
          bufferSize: this.replayBuffer.length,
          maxCapacity: this.maxBufferCapacity,
        });
        return err({
          code: "BUFFER_OVERFLOW",
          message: `SSE replay buffer overflowed (capacity: ${String(this.maxBufferCapacity)}).`,
        });
      }

      this.replayBuffer.push(envelope);
      return ok(undefined);
    }

    return this.sendDirectEnvelope(envelope, options);
  }

  /**
   * Wraps a canonical RunEvent into an execution envelope and writes it directly to the stream,
   * bypassing the live buffer. Used during historical event replay.
   */
  async sendHistoricalEvent(runEvent: RunEvent): Promise<Result<void, SseConnectionError>> {
    const envelope = createSseExecutionEnvelope(runEvent);
    return this.sendDirectEnvelope(envelope);
  }

  /**
   * Wraps a canonical RunEvent into an execution envelope and writes it.
   */
  async sendEvent(runEvent: RunEvent): Promise<Result<void, SseConnectionError>> {
    const envelope = createSseExecutionEnvelope(runEvent);
    return this.sendEnvelope(envelope);
  }

  /**
   * Writes a raw SSE comment frame (e.g. for protocol-level keep-alive).
   */
  async sendComment(comment: string): Promise<Result<void, SseConnectionError>> {
    if (!this.isOpen) {
      return err({
        code: "CONNECTION_CLOSED",
        message: `Cannot write comment to SSE connection '${this.connectionId}': connection is not open.`,
      });
    }

    const formatted = formatSseComment(comment);
    return this.writeChunk(formatted);
  }

  /**
   * Sends a structured transport-level error frame directly to the stream.
   */
  async sendError(
    code: SseErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ): Promise<Result<void, SseConnectionError>> {
    const errorEnvelope = createSseErrorEnvelope({
      id: eventId(`err-${this.connectionId}-${String(Date.now())}`),
      code,
      message,
      retryable,
      runId: this.runId ? toRunId(this.runId) : undefined,
      ...(details !== undefined ? { details } : {}),
    });
    return this.sendDirectEnvelope(errorEnvelope);
  }

  /**
   * Closes the SSE connection cleanly and releases resources.
   * Deterministic and idempotent.
   */
  async close(
    reason = "normal_closure",
    terminal = false,
  ): Promise<Result<void, SseConnectionError>> {
    if (this._status === "closed") {
      return ok(undefined);
    }

    this._status = "closing";

    // Stop heartbeat timer immediately
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Immediately clear live buffer and disable buffering to reclaim memory
    this.clearBuffer();
    this.disableBuffering();

    // Attempt to write a clean closed envelope if stream is still writable
    if (!this.targetStream.destroyed && !this.targetStream.writableEnded) {
      try {
        const closedEnvelope = createSseClosedEnvelope({
          id: eventId(`close-${this.connectionId}`),
          reason,
          terminal,
          runId: this.runId ? toRunId(this.runId) : undefined,
        });
        const serialized = serializeSseEnvelope(closedEnvelope);
        if (serialized.ok) {
          await this.writeChunk(serialized.value);
        }
      } catch {
        // Best-effort closure frame; ignore write error during shutdown
      }

      try {
        this.targetStream.end();
      } catch {
        // Stream may have already ended
      }
    }

    this._status = "closed";
    this.closedTimestamp = new Date().toISOString();

    // Trigger all registered close listeners
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch (listenerErr) {
        this.logger?.warn("SSE connection onClose listener threw error", {
          connectionId: this.connectionId,
          error: listenerErr,
        });
      }
    }
    this.closeListeners.clear();

    return ok(undefined);
  }

  /**
   * Registers a callback invoked when the connection is closed or terminated.
   * Returns an unsubscribe function.
   */
  onClose(callback: (reason: string) => void): () => void {
    if (this._status === "closed") {
      // If already closed, schedule execution immediately
      queueMicrotask(() => {
        callback("already_closed");
      });
      return () => {
        /* noop for already closed connection */
      };
    }

    this.closeListeners.add(callback);
    return () => {
      this.closeListeners.delete(callback);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal Stream Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private async sendHeartbeat(): Promise<void> {
    if (!this.isOpen) {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      return;
    }

    this.heartbeatSequence += 1;
    let result: Result<void, SseConnectionError>;

    if (this.heartbeatMode === "event") {
      const hbEnvelope = createSseHeartbeatEnvelope({
        id: eventId(`hb-${this.connectionId}-${String(this.heartbeatSequence)}`),
        sequenceNumber: this.heartbeatSequence,
        runId: this.runId ? toRunId(this.runId) : undefined,
      });
      result = await this.sendEnvelope(hbEnvelope);
    } else {
      result = await this.sendComment("keep-alive");
    }

    if (result.ok) {
      this.heartbeatsCount += 1;
    }
  }

  private writeChunk(chunk: string): Promise<Result<void, SseConnectionError>> {
    return new Promise((resolve) => {
      if (this.targetStream.destroyed || this.targetStream.writableEnded) {
        resolve(
          err({
            code: "CONNECTION_CLOSED",
            message: "Target stream is destroyed or closed.",
          }),
        );
        return;
      }

      let drainTimeout: NodeJS.Timeout | undefined;

      const cleanupListeners = (): void => {
        if (drainTimeout) {
          clearTimeout(drainTimeout);
          drainTimeout = undefined;
        }
        this.targetStream.off("drain", onDrain);
        this.targetStream.off("close", onStreamClose);
        this.targetStream.off("error", onStreamError);
      };

      const onDrain = (): void => {
        cleanupListeners();
        this.bytesCount += Buffer.byteLength(chunk, "utf8");
        resolve(ok(undefined));
      };

      const onStreamClose = (): void => {
        cleanupListeners();
        resolve(
          err({
            code: "CONNECTION_CLOSED",
            message: `Stream closed while waiting for backpressure drain on connection '${this.connectionId}'.`,
          }),
        );
      };

      const onStreamError = (writeError: Error): void => {
        cleanupListeners();
        this.errorsCount += 1;
        resolve(
          err({
            code: "WRITE_FAILED",
            message: `Stream write failed: ${writeError.message}`,
            cause: writeError,
          }),
        );
      };

      const canAcceptMore = this.targetStream.write(chunk, "utf8", (cbErr) => {
        if (cbErr) {
          onStreamError(cbErr);
        }
      });

      if (canAcceptMore) {
        this.bytesCount += Buffer.byteLength(chunk, "utf8");
        resolve(ok(undefined));
        return;
      }

      // Stream applied backpressure; wait for 'drain', 'close', 'error', or timeout
      drainTimeout = setTimeout(() => {
        cleanupListeners();
        this.errorsCount += 1;
        this.logger?.warn("SSE stream backpressure drain timed out; closing unresponsive connection", {
          connectionId: this.connectionId,
          runId: this.runId,
          drainTimeoutMs: this.drainTimeoutMs,
        });

        // Evict slow consumer to protect server resources
        this.handleStreamTermination("backpressure_timeout");
        try {
          this.targetStream.destroy();
        } catch {
          // Stream may already be destroyed
        }

        resolve(
          err({
            code: "BACKPRESSURE_TIMEOUT",
            message: `Stream write backpressure drain timed out after ${String(this.drainTimeoutMs)}ms.`,
          }),
        );
      }, this.drainTimeoutMs);

      // Prevent timer from keeping Node process alive if configured
      if (typeof drainTimeout.unref === "function") {
        drainTimeout.unref();
      }

      this.targetStream.once("drain", onDrain);
      this.targetStream.once("close", onStreamClose);
      this.targetStream.once("error", onStreamError);
    });
  }

  private handleStreamTermination(reason: string): void {
    if (this._status === "closed") return;

    this._status = "closed";
    this.closedTimestamp = new Date().toISOString();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Immediately clear live buffer and disable buffering to reclaim memory
    this.clearBuffer();
    this.disableBuffering();

    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch (err) {
        this.logger?.warn("Error in SSE onClose listener during stream termination", {
          connectionId: this.connectionId,
          error: err,
        });
      }
    }
    this.closeListeners.clear();
  }
}
