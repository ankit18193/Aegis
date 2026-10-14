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

import { createSseConnectedEnvelope } from "@aegis/contracts";
import { eventId, runId as toRunId } from "@aegis/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SseConnection } from "./sseConnection.js";
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

/**
 * Establishes an SSE stream over a Fastify request/reply lifecycle.
 * Hijacks the raw response stream, applies headers, registers in the transport manager,
 * sends initial connected handshake, and wires request abort listeners.
 */
export function establishSseStream(
  reply: FastifyReply,
  manager: SseTransportManager,
  options: SseConnectionOptions = {},
): SseConnection {
  reply.hijack();
  setSseHeaders(reply);

  const connection = manager.createConnection(reply.raw, options);
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

  // Bind request socket termination listener
  reply.request.raw.once("close", () => {
    void connection.close("client_aborted");
  });

  return connection;
}

interface SseProbeQuery {
  readonly runId?: string | undefined;
  readonly heartbeatMs?: string | undefined;
  readonly closeImmediately?: string | undefined;
}

/**
 * Registers transport-level SSE routes and lifecycle shutdown hooks on a Fastify instance.
 */
export function registerSseTransportRoutes(
  app: FastifyInstance,
  manager: SseTransportManager,
): void {
  // GET /api/v1/stream/transport — Transport verification probe endpoint
  app.get<{ Querystring: SseProbeQuery }>(
    "/api/v1/stream/transport",
    (request: FastifyRequest<{ Querystring: SseProbeQuery }>, reply: FastifyReply) => {
      const runId = request.query.runId;
      const heartbeatMsRaw = request.query.heartbeatMs;
      const heartbeatIntervalMs = heartbeatMsRaw
        ? Number.parseInt(heartbeatMsRaw, 10)
        : undefined;

      const conn = establishSseStream(reply, manager, {
        runId,
        heartbeatIntervalMs,
      });

      if (request.query.closeImmediately === "true") {
        queueMicrotask(() => {
          void conn.close("probe_complete");
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
