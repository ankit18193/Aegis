/**
 * Kafka Client Manager.
 * Manages KafkaJS instance lifecycle and producer creation.
 */

import type { KafkaConfig } from "@aegis/config";
import type { Logger } from "@aegis/logger";
import { Kafka, Partitioners, type Producer } from "kafkajs";

export interface KafkaClientManagerOptions {
  readonly config: KafkaConfig;
  readonly logger?: Logger | undefined;
}

export class KafkaClientManager {
  private readonly kafka: Kafka;
  private readonly config: KafkaConfig;
  private readonly logger?: Logger | undefined;
  private producer: Producer | null = null;

  constructor(options: KafkaClientManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;

    this.kafka = new Kafka({
      clientId: this.config.clientId,
      brokers: [...this.config.brokers],
      connectionTimeout: this.config.connectionTimeoutMs,
      requestTimeout: this.config.requestTimeoutMs,
      retry: {
        maxRetryTime: this.config.retryMaxDelayMs,
        initialRetryTime: this.config.retryInitialDelayMs,
        retries: this.config.maxRetries,
      },
    });
  }

  getProducer(): Producer {
    this.producer ??= this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });
    return this.producer;
  }

  getKafka(): Kafka {
    return this.kafka;
  }

  getConfig(): KafkaConfig {
    return this.config;
  }
}
