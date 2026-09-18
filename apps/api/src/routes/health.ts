import {
  aggregatePlatformHealth,
  createComponentHealth,
  HealthStatus,
  type PlatformHealth,
} from "@aegis/foundation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", (_request: FastifyRequest, reply: FastifyReply) => {
    const health: PlatformHealth = aggregatePlatformHealth([
      createComponentHealth("api", HealthStatus.Healthy, "API service operational"),
    ]);

    void reply.status(200).send(health);
  });

  app.get("/ready", (_request: FastifyRequest, reply: FastifyReply) => {
    const health: PlatformHealth = aggregatePlatformHealth([
      createComponentHealth("api", HealthStatus.Healthy, "API service ready to accept traffic"),
    ]);

    const statusCode = health.status === HealthStatus.Healthy ? 200 : 503;
    void reply.status(statusCode).send(health);
  });
}
