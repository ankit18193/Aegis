import type { Logger } from "@aegis/logger";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    requestStartTime: bigint;
  }
}

let requestCounter = 0;

export function generateRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function registerCorrelationHooks(app: FastifyInstance, logger: Logger): void {
  app.decorateRequest("requestId", "");
  app.decorateRequest("requestStartTime", BigInt(0));

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const headerId = request.headers["x-request-id"];
    const reqId = typeof headerId === "string" && headerId.trim().length > 0
      ? headerId.trim()
      : generateRequestId();

    request.requestId = reqId;
    request.requestStartTime = process.hrtime.bigint();
    void reply.header("x-request-id", reqId);
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const start = request.requestStartTime && request.requestStartTime > BigInt(0)
      ? request.requestStartTime
      : process.hrtime.bigint();
    const elapsedNs = process.hrtime.bigint() - start;
    const durationMs = Number(elapsedNs) / 1_000_000;

    logger.info("HTTP request completed", {
      requestId: request.requestId || "pre-flight",
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
}
