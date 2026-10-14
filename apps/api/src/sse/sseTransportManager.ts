/**
 * SSE Transport Manager — Phase 13B (Commit 4)
 *
 * Tracks, manages, and cleans up active server-side SSE connections.
 * Provides explicit connection ownership, run-scoped connection grouping,
 * and graceful mass teardown on server shutdown.
 */

import type { Writable } from "node:stream";

import type { SseTransportEnvelope } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";

import { SseConnection } from "./sseConnection.js";
import type { ISseConnection, SseConnectionOptions } from "./types.js";

export interface SseTransportManagerOptions {
  readonly logger?: Logger | undefined;
  readonly defaultHeartbeatIntervalMs?: number | undefined;
}

export class SseTransportManager {
  private readonly connections = new Map<string, ISseConnection>();
  private readonly runConnections = new Map<string, Set<string>>();
  private readonly logger?: Logger | undefined;
  private readonly defaultHeartbeatIntervalMs?: number | undefined;

  constructor(options: SseTransportManagerOptions = {}) {
    this.logger = options.logger;
    this.defaultHeartbeatIntervalMs = options.defaultHeartbeatIntervalMs;
  }

  /**
   * Total number of currently active SSE connections.
   */
  get activeConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Creates, registers, and tracks a new SseConnection instance.
   * Automatically unregisters when the connection closes.
   */
  createConnection(
    targetStream: Writable,
    options: SseConnectionOptions = {},
  ): SseConnection {
    const mergedOptions: SseConnectionOptions = {
      heartbeatIntervalMs:
        options.heartbeatIntervalMs ?? this.defaultHeartbeatIntervalMs,
      logger: options.logger ?? this.logger,
      ...options,
    };

    const connection = new SseConnection(targetStream, mergedOptions);
    this.registerConnection(connection);
    return connection;
  }

  /**
   * Registers an existing connection into the active tracking registry.
   */
  registerConnection(connection: ISseConnection): void {
    const id = connection.connectionId;
    this.connections.set(id, connection);

    if (connection.runId) {
      let set = this.runConnections.get(connection.runId);
      if (!set) {
        set = new Set<string>();
        this.runConnections.set(connection.runId, set);
      }
      set.add(id);
    }

    // Automatically remove from registry when connection terminates
    connection.onClose(() => {
      this.unregisterConnection(id);
    });

    this.logger?.debug("Registered SSE connection in transport manager", {
      connectionId: id,
      runId: connection.runId,
      activeCount: this.connections.size,
    });
  }

  /**
   * Unregisters a connection from the tracking registry.
   */
  unregisterConnection(connectionId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;

    this.connections.delete(connectionId);

    if (conn.runId) {
      const set = this.runConnections.get(conn.runId);
      if (set) {
        set.delete(connectionId);
        if (set.size === 0) {
          this.runConnections.delete(conn.runId);
        }
      }
    }

    this.logger?.debug("Unregistered SSE connection from transport manager", {
      connectionId,
      activeCount: this.connections.size,
    });

    return true;
  }

  /**
   * Retrieves an active connection by its connectionId.
   */
  getConnection(connectionId: string): ISseConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Retrieves all active connections bound to a specific execution run.
   */
  getConnectionsByRunId(runId: string): readonly ISseConnection[] {
    const ids = this.runConnections.get(runId);
    if (!ids || ids.size === 0) return [];

    const result: ISseConnection[] = [];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn?.isOpen) {
        result.push(conn);
      }
    }
    return result;
  }

  /**
   * Broadcasts an SSE transport envelope to all active connections for a given runId.
   * Returns the count of connections to which the message was successfully dispatched.
   */
  async broadcastToRun(
    runId: string,
    envelope: SseTransportEnvelope,
  ): Promise<number> {
    const targets = this.getConnectionsByRunId(runId);
    if (targets.length === 0) return 0;

    let successful = 0;
    const writePromises = targets.map(async (conn) => {
      const res = await conn.sendEnvelope(envelope);
      if (res.ok) {
        successful += 1;
      }
    });

    await Promise.all(writePromises);
    return successful;
  }

  /**
   * Gracefully closes all active SSE connections.
   * Used during server shutdown or route teardown to prevent hanging sockets.
   */
  async closeAll(reason = "server_shutdown"): Promise<void> {
    if (this.connections.size === 0) return;

    this.logger?.info("Closing all active SSE connections", {
      count: this.connections.size,
      reason,
    });

    const closePromises: Promise<unknown>[] = [];
    for (const conn of this.connections.values()) {
      closePromises.push(conn.close(reason));
    }

    await Promise.all(closePromises);
    this.connections.clear();
    this.runConnections.clear();
  }
}
