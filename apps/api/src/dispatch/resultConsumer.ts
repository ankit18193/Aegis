import type { TaskResultEnvelope } from "@aegis/contracts";
import { taskResultEnvelopeSchema } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Consumer } from "kafkajs";

import type { IRunRepository } from "../repositories/runRepository.js";

export interface TaskResultConsumerOptions {
  readonly consumer?: Consumer | undefined;
  readonly runRepository: IRunRepository;
  readonly topic?: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * TaskResultConsumer — Control-plane consumer for worker task results on aegis.tasks.results.
 *
 * Implements Phase 12A durable execution result persistence:
 * 1. Dedicated result topic: aegis.tasks.results
 * 2. Parses and validates CloudEvents TaskResultEnvelope
 * 3. Ingests execution result (SUCCEEDED / FAILED) into PostgreSQL via IRunRepository.updateTaskState()
 * 4. Optimistic concurrency guarded: uses current task.version to prevent stale overwrites
 * 5. Terminal state protection: gracefully logs and ignores duplicate completions
 */
export class TaskResultConsumer {
  private readonly consumer?: Consumer | undefined;
  private readonly runRepository: IRunRepository;
  readonly topic: string;
  private readonly logger?: Logger | undefined;
  private isConnected = false;
  private _messagesProcessed = 0;

  constructor(options: TaskResultConsumerOptions) {
    this.consumer = options.consumer;
    this.runRepository = options.runRepository;
    this.topic = options.topic ?? "aegis.tasks.results";
    this.logger = options.logger;
  }

  public get messagesProcessed(): number {
    return this._messagesProcessed;
  }

  public get running(): boolean {
    return this.isConnected;
  }

  public async start(): Promise<void> {
    if (this.isConnected || !this.consumer) {
      return;
    }

    this.logger?.info("Starting control-plane TaskResultConsumer", { topic: this.topic });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ message, partition }) => {
        try {
          await this.handleMessage(message.value);
        } catch (err) {
          this.logger?.error("Unexpected error handling task result message", {
            topic: this.topic,
            partition,
            offset: message.offset,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    this.isConnected = true;
  }

  public async stop(): Promise<void> {
    if (!this.isConnected || !this.consumer) {
      return;
    }
    await this.consumer.disconnect();
    this.isConnected = false;
  }

  /**
   * Processes a single raw task result message value (or pre-parsed envelope).
   * Atomically updates task state in PostgreSQL via IRunRepository.updateTaskState().
   */
  public async handleMessage(
    raw: Buffer | string | null | undefined | TaskResultEnvelope,
  ): Promise<boolean> {
    this._messagesProcessed++;

    let envelope: TaskResultEnvelope;
    if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
      envelope = raw;
    } else {
      try {
        if (!raw) {
          this.logger?.warn("Ignoring empty task result message", { topic: this.topic });
          return false;
        }
        const str = typeof raw === "string" ? raw : raw.toString("utf-8");
        if (str.trim().length === 0) {
          this.logger?.warn("Ignoring empty task result message", { topic: this.topic });
          return false;
        }
        const json: unknown = JSON.parse(str);
        const parsed = taskResultEnvelopeSchema.safeParse(json);
        if (!parsed.success) {
          this.logger?.warn("Invalid TaskResultEnvelope schema", {
            topic: this.topic,
            issues: parsed.error.issues,
          });
          return false;
        }
        envelope = parsed.data;
      } catch (err) {
        this.logger?.warn("Failed to parse task result JSON", {
          topic: this.topic,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }

    const { taskId, runId, status, output, error, completedAt, workerId } = envelope.data;

    // 1. Fetch current run to find task and current version
    const run = await this.runRepository.findById(runId);
    if (!run) {
      this.logger?.warn("Run not found for task result", { runId, taskId });
      return false;
    }

    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.logger?.warn("Task not found in run for task result", { runId, taskId });
      return false;
    }

    const targetStatus = status === "SUCCEEDED" ? "completed" : "failed";
    const serializedOutput =
      output !== undefined
        ? typeof output === "string"
          ? output
          : JSON.stringify(output)
        : undefined;

    // 2. Perform atomic update with optimistic concurrency
    const updateRes = await this.runRepository.updateTaskState(
      taskId,
      {
        status: targetStatus,
        workerId,
        completedAt,
        output: serializedOutput,
        error: error?.message,
      },
      task.version,
    );

    if (!updateRes.ok) {
      this.logger?.warn("Failed to update durable task state from result", {
        taskId,
        code: updateRes.error.code,
        message: updateRes.error.message,
      });
      return false;
    }

    this.logger?.info("Durable task execution state updated successfully", {
      taskId,
      runId,
      status: targetStatus,
      newVersion: updateRes.value.newVersion,
    });

    return true;
  }
}
