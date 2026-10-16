/**
 * Fastify SSE Transport Foundation — Phase 13B (Commit 4)
 *
 * Implements Fastify route and lifecycle integration for Server-Sent Events:
 * - Proper SSE HTTP response headers (Content-Type, Cache-Control, X-Accel-Buffering)
 * - Safe response hijacking preventing default payload completion
 * - Initial connection handshake via canonical SseConnectedEnvelope
 * - Request cancellation and disconnect listeners
 * - Clean server shutdown hook ensuring no dangling sockets
 */

import type { IRunEventReplayRepository } from "@aegis/contracts";
import { createSseConnectedEnvelope } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { eventId, runId as toRunId } from "@aegis/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SseConnection } from "./sseConnection.js";
import { SseReplayCoordinator } from "./sseReplayCoordinator.js";
import type { SseTransportManager } from "./sseTransportManager.js";
import type { SseConnectionOptions } from "./types.js";

/**
 * Sets standard HTTP headers required for Server-Sent Events.
 */
export function setSseHeaders(reply: FastifyReply): void {
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.setHeader("Content-Encoding", "none");
  reply.raw.flushHeaders();
}

export interface FastifySseStreamOptions extends SseConnectionOptions {
  /**
   * Replay cursor from client (W3C Last-Event-ID header or query param).
   */
  readonly cursor?: string | undefined;

  /**
   * Replay coordinator to handle historical event replay and buffer draining.
   */
  readonly replayCoordinator?: SseReplayCoordinator | undefined;
}

/**
 * Establishes an SSE stream over a Fastify request/reply lifecycle.
 * Hijacks the raw response stream, applies headers, registers in the transport manager,
 * arms replay buffering if reconnecting, sends initial connected handshake, and initiates replay.
 */
export function establishSseStream(
  reply: FastifyReply,
  manager: SseTransportManager,
  options: FastifySseStreamOptions = {},
): SseConnection {
  reply.hijack();
  setSseHeaders(reply);

  const connection = manager.createConnection(reply.raw, options);

  // If a cursor and replay coordinator are present for this run, arm buffering immediately
  // so concurrent live broadcast events are not dispatched out-of-order ahead of history.
  const hasReplay = Boolean(options.cursor && options.replayCoordinator && options.runId);
  if (hasReplay) {
    connection.enableBuffering();
  }

  const openRes = connection.open();
  if (!openRes.ok) {
    reply.raw.end();
    return connection;
  }

  // Send initial canonical connected envelope
  const connectedEnvelope = createSseConnectedEnvelope({
    id: eventId(`conn-${connection.connectionId}`),
    streamId: connection.connectionId,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
    runId: options.runId ? toRunId(options.runId) : undefined,
  });
  void connection.sendEnvelope(connectedEnvelope);

  // Kick off asynchronous replay coordination if reconnecting
  if (hasReplay && options.replayCoordinator && options.runId) {
    const coordPromise = options.replayCoordinator.coordinateReplay(connection, {
      runId: options.runId,
      cursor: options.cursor,
    });
    connection.replayPromise = coordPromise;
    coordPromise.catch((coordErr: unknown) => {
      options.logger?.error("Replay coordination unhandled exception", {
        connectionId: connection.connectionId,
        runId: options.runId,
        error: coordErr,
      });
    });
  }

  // Bind request socket termination listener
  reply.request.raw.once("close", () => {
    void connection.close("client_aborted");
  });

  return connection;
}

export interface SseProbeQuery {
  readonly runId?: string | undefined;
  readonly heartbeatMs?: string | undefined;
  readonly closeImmediately?: string | undefined;
  readonly cursor?: string | undefined;
  readonly lastEventId?: string | undefined;
}

export interface RegisterSseTransportRoutesOptions {
  readonly replayRepository?: IRunEventReplayRepository | undefined;
  readonly replayCoordinator?: SseReplayCoordinator | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Registers transport-level SSE routes and lifecycle shutdown hooks on a Fastify instance.
 */
export function registerSseTransportRoutes(
  app: FastifyInstance,
  manager: SseTransportManager,
  optionsOrRepo?: RegisterSseTransportRoutesOptions | IRunEventReplayRepository,
): void {
  let coordinator: SseReplayCoordinator | undefined;
  let logger: Logger | undefined;

  if (optionsOrRepo) {
    if ("replayEvents" in optionsOrRepo) {
      // Passed as IRunEventReplayRepository directly
      coordinator = new SseReplayCoordinator({ replayRepository: optionsOrRepo });
    } else {
      logger = optionsOrRepo.logger;
      if (optionsOrRepo.replayCoordinator) {
        coordinator = optionsOrRepo.replayCoordinator;
      } else if (optionsOrRepo.replayRepository) {
        coordinator = new SseReplayCoordinator({
          replayRepository: optionsOrRepo.replayRepository,
          logger: optionsOrRepo.logger,
        });
      }
    }
  }

  // GET /api/v1/stream/transport — Transport verification probe and execution stream endpoint
  app.get<{ Querystring: SseProbeQuery }>(
    "/api/v1/stream/transport",
    (request: FastifyRequest<{ Querystring: SseProbeQuery }>, reply: FastifyReply) => {
      const runId = request.query.runId;
      const heartbeatMsRaw = request.query.heartbeatMs;
      const heartbeatIntervalMs = heartbeatMsRaw
        ? Number.parseInt(heartbeatMsRaw, 10)
        : undefined;

      // Extract cursor from W3C Last-Event-ID header (case-insensitive) or query params
      const rawHeader = request.headers["last-event-id"];
      const headerCursor = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      const cursor =
        (headerCursor && headerCursor.trim().length > 0 ? headerCursor.trim() : undefined) ??
        request.query.lastEventId ??
        request.query.cursor;

      const conn = establishSseStream(reply, manager, {
        runId,
        heartbeatIntervalMs,
        cursor,
        replayCoordinator: coordinator,
        logger,
      });

      if (request.query.closeImmediately === "true") {
        queueMicrotask(() => {
          if (conn.replayPromise) {
            void conn.replayPromise.finally(() => {
              void conn.close("probe_complete");
            });
          } else {
            void conn.close("probe_complete");
          }
        });
      }
    },
  );

  // GET /api/v1/stream/transport/stats — Transport metrics and active connection count
  app.get(
    "/api/v1/stream/transport/stats",
    (_request: FastifyRequest, reply: FastifyReply) => {
      void reply.status(200).send({
        activeConnections: manager.activeConnectionCount,
      });
    },
  );

  // Ensure graceful shutdown of all SSE streams when Fastify stops
  app.addHook("onClose", async () => {
    await manager.closeAll("server_shutdown");
  });
}
