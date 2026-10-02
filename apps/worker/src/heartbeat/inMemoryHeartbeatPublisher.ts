import type {
  IWorkerHeartbeatPublisher,
  WorkerHeartbeat,
  WorkerHeartbeatEnvelope,
  WorkerHeartbeatError,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

/**
 * In-memory heartbeat publisher for unit testing and local offline validation.
 */
export class InMemoryWorkerHeartbeatPublisher implements IWorkerHeartbeatPublisher {
  private readonly published: WorkerHeartbeatEnvelope[] = [];
  private simulatedFailure: WorkerHeartbeatError | null = null;

  public publish(
    heartbeat: WorkerHeartbeat,
    metadata?: { readonly correlationId?: string | undefined; readonly causationId?: string | undefined },
  ): Promise<Result<WorkerHeartbeatEnvelope, WorkerHeartbeatError>> {
    if (this.simulatedFailure) {
      return Promise.resolve(err(this.simulatedFailure));
    }

    const envelope: WorkerHeartbeatEnvelope = {
      id: heartbeat.heartbeatId,
      type: "worker_heartbeat",
      source: `aegis.worker.${heartbeat.workerId}`,
      specVersion: "1.0",
      time: heartbeat.occurredAt,
      aggregateId: heartbeat.workerId,
      aggregateType: "Worker",
      correlationId: metadata?.correlationId ?? `corr-hb-${heartbeat.heartbeatId}`,
      causationId: metadata?.causationId,
      data: heartbeat,
    };

    this.published.push(envelope);
    return Promise.resolve(ok(envelope));
  }

  public getPublishedHeartbeats(): readonly WorkerHeartbeatEnvelope[] {
    return [...this.published];
  }

  public getLastHeartbeat(): WorkerHeartbeatEnvelope | undefined {
    return this.published[this.published.length - 1];
  }

  public clear(): void {
    this.published.length = 0;
    this.simulatedFailure = null;
  }

  public setSimulatedFailure(failure: WorkerHeartbeatError | null): void {
    this.simulatedFailure = failure;
  }
}
