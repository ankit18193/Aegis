import {
  cancelRunRequestSchema,
  createRunRequestSchema,
  formatZodError,
  getRunEventsQuerySchema,
  listRunsQuerySchema,
  runIdSchema,
} from "@aegis/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { statusFromErrorCode } from "../middleware/errorHandler.js";
import type { AgentRunService } from "../services/agentRunService.js";
import type { RunApplicationService } from "../services/runService.js";

export function registerRunRoutes(
  app: FastifyInstance,
  service: RunApplicationService | AgentRunService,
): void {
  // POST /runs — Submit a new execution run
  app.post("/runs", async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.requestId;
    const parseResult = createRunRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      const envelope = formatZodError(parseResult.error, traceId);
      void reply.status(400).send(envelope);
      return;
    }

    const result = await service.createRun(parseResult.data);
    if (!result.ok) {
      const statusCode = statusFromErrorCode(result.error.error.code);
      void reply.status(statusCode).send(result.error);
      return;
    }

    void reply.status(201).send(result.value);
  });

  // GET /runs — Query paginated runs list
  app.get("/runs", async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.requestId;
    const parseResult = listRunsQuerySchema.safeParse(request.query);

    if (!parseResult.success) {
      const envelope = formatZodError(parseResult.error, traceId);
      void reply.status(400).send(envelope);
      return;
    }

    const result = await service.listRuns(parseResult.data);
    if (!result.ok) {
      const statusCode = statusFromErrorCode(result.error.error.code);
      void reply.status(statusCode).send(result.error);
      return;
    }

    void reply.status(200).send(result.value);
  });

  // GET /runs/:runId — Retrieve full details for an execution run
  app.get("/runs/:runId", async (request: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
    const traceId = request.requestId;
    const idParse = runIdSchema.safeParse(request.params.runId);

    if (!idParse.success) {
      const envelope = formatZodError(idParse.error, traceId);
      void reply.status(400).send(envelope);
      return;
    }

    const result = await service.getRun(idParse.data);
    if (!result.ok) {
      const statusCode = statusFromErrorCode(result.error.error.code);
      void reply.status(statusCode).send(result.error);
      return;
    }

    void reply.status(200).send(result.value);
  });

  // POST /runs/:runId/cancel — Cancel an in-flight run
  app.post(
    "/runs/:runId/cancel",
    async (request: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
      const traceId = request.requestId;
      const idParse = runIdSchema.safeParse(request.params.runId);

      if (!idParse.success) {
        const envelope = formatZodError(idParse.error, traceId);
        void reply.status(400).send(envelope);
        return;
      }

      const bodyParse = cancelRunRequestSchema.safeParse(request.body ?? {});
      if (!bodyParse.success) {
        const envelope = formatZodError(bodyParse.error, traceId);
        void reply.status(400).send(envelope);
        return;
      }

      const result = await service.cancelRun(idParse.data, bodyParse.data);
      if (!result.ok) {
        const statusCode = statusFromErrorCode(result.error.error.code);
        void reply.status(statusCode).send(result.error);
        return;
      }

      void reply.status(200).send(result.value);
    },
  );

  // GET /runs/:runId/events — Retrieve timeline events for a run
  app.get(
    "/runs/:runId/events",
    async (request: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
      const traceId = request.requestId;
      const idParse = runIdSchema.safeParse(request.params.runId);

      if (!idParse.success) {
        const envelope = formatZodError(idParse.error, traceId);
        void reply.status(400).send(envelope);
        return;
      }

      const queryParse = getRunEventsQuerySchema.safeParse(request.query);
      if (!queryParse.success) {
        const envelope = formatZodError(queryParse.error, traceId);
        void reply.status(400).send(envelope);
        return;
      }

      const result = await service.getRunEvents(idParse.data, queryParse.data);
      if (!result.ok) {
        const statusCode = statusFromErrorCode(result.error.error.code);
        void reply.status(statusCode).send(result.error);
        return;
      }

      void reply.status(200).send(result.value);
    },
  );
}
