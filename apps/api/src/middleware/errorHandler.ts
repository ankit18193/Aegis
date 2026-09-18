import {
  createApiError,
  formatZodError,
  type ApiErrorCode,
  type ApiErrorResponse,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Maps an ApiErrorCode to an appropriate HTTP status code.
 */
export function statusFromErrorCode(code: ApiErrorCode): number {
  switch (code) {
    case "BAD_REQUEST":
    case "VALIDATION_ERROR":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "UNPROCESSABLE_ENTITY":
      return 422;
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "INTERNAL_SERVER_ERROR":
    default:
      return 500;
  }
}

export function registerErrorHandlers(app: FastifyInstance, logger?: Logger): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.requestId || undefined;

    // Handle Zod validation errors (duck-typed to avoid direct zod dependency in api)
    if (error.name === "ZodError" || ("issues" in error && Array.isArray((error as { issues?: unknown }).issues))) {
      const envelope = formatZodError(error as Parameters<typeof formatZodError>[0], traceId);
      void reply.status(400).send(envelope);
      return;
    }

    // Handle Fastify schema validation errors
    if ("validation" in error && Array.isArray(error.validation)) {
      const details = error.validation.map((v) => ({
        field: v.instancePath ? v.instancePath : ((v.params as { missingProperty?: string }).missingProperty ?? "root"),
        message: v.message ?? "Validation failed",
        code: v.keyword,
      }));
      const envelope: ApiErrorResponse = createApiError(
        "VALIDATION_ERROR",
        error.message,
        details,
        traceId,
      );
      void reply.status(400).send(envelope);
      return;
    }

    // Handle standard Fastify 4xx status codes (e.g. payload too large)
    if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const code: ApiErrorCode = error.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST";
      const envelope = createApiError(code, error.message, undefined, traceId);
      void reply.status(error.statusCode).send(envelope);
      return;
    }

    // Unhandled / 500 internal server errors
    logger?.error("Unhandled server exception", {
      requestId: traceId,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    });

    const envelope = createApiError(
      "INTERNAL_SERVER_ERROR",
      "An unexpected internal error occurred on the server.",
      undefined,
      traceId,
    );
    void reply.status(500).send(envelope);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.requestId || undefined;
    const envelope = createApiError(
      "NOT_FOUND",
      `Cannot ${request.method} ${request.url} — route not found`,
      undefined,
      traceId,
    );
    void reply.status(404).send(envelope);
  });
}
