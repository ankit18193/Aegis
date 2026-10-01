import type { WorkerConfig } from "@aegis/config";
import type { Logger } from "@aegis/logger";
import { Kafka, type Consumer } from "kafkajs";

export interface CreateWorkerConsumerOptions {
  readonly config: WorkerConfig;
  readonly logger?: Logger | undefined;
}

/**
 * Creates and configures a KafkaJS Consumer instance for the worker.
 */
export function createWorkerKafkaConsumer(
  options: CreateWorkerConsumerOptions,
): Consumer {
  const { config } = options;

  const kafka = new Kafka({
    clientId: config.workerName,
    brokers: [...config.kafkaBrokers],
  });

  return kafka.consumer({
    groupId: config.workerConsumerGroupId,
  });
}
