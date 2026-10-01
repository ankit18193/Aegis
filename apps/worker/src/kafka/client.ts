import type { WorkerConfig } from "@aegis/config";
import type { Logger } from "@aegis/logger";
import { Kafka, type Consumer, type Producer } from "kafkajs";

export interface CreateWorkerConsumerOptions {
  readonly config: WorkerConfig;
  readonly logger?: Logger | undefined;
}

export interface CreateWorkerProducerOptions {
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

/**
 * Creates and configures a KafkaJS Producer instance for the worker result reporting.
 */
export function createWorkerKafkaProducer(
  options: CreateWorkerProducerOptions,
): Producer {
  const { config } = options;

  const kafka = new Kafka({
    clientId: `${config.workerName}-results`,
    brokers: [...config.kafkaBrokers],
  });

  return kafka.producer();
}
