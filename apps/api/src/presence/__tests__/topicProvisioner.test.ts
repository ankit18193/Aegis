import type { Admin } from "kafkajs";
import { describe, expect, it, vi } from "vitest";

import { InMemoryTopicProvisioner, KafkaTopicProvisioner } from "../topicProvisioner.js";

describe("Topic Provisioners (Phase 11E)", () => {
  describe("InMemoryTopicProvisioner", () => {
    it("provisions new topics and idempotent on existing", async () => {
      const provisioner = new InMemoryTopicProvisioner(["initial.topic"]);

      expect(provisioner.hasTopic("initial.topic")).toBe(true);
      expect(provisioner.hasTopic("aegis.tasks.assign.worker-1")).toBe(false);

      const res1 = await provisioner.ensureTopic("aegis.tasks.assign.worker-1");
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.value).toBe(true); // Newly created
      }

      const res2 = await provisioner.ensureTopic("aegis.tasks.assign.worker-1");
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.value).toBe(false); // Already existed
      }
    });
  });

  describe("KafkaTopicProvisioner", () => {
    it("calls admin.createTopics if topic does not exist in cluster", async () => {
      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue(["existing.topic"]),
        createTopics: vi.fn().mockResolvedValue(true),
      };

      const provisioner = new KafkaTopicProvisioner({
        admin: mockAdmin as unknown as Admin,
      });

      const result = await provisioner.ensureTopic("aegis.tasks.assign.w-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
      expect(mockAdmin.createTopics).toHaveBeenCalledWith({
        topics: [
          {
            topic: "aegis.tasks.assign.w-1",
            numPartitions: 1,
            replicationFactor: 1,
          },
        ],
      });
    });

    it("returns false without calling createTopics if topic already exists", async () => {
      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockResolvedValue(["aegis.tasks.assign.w-2"]),
        createTopics: vi.fn().mockResolvedValue(true),
      };

      const provisioner = new KafkaTopicProvisioner({
        admin: mockAdmin as unknown as Admin,
      });

      const result = await provisioner.ensureTopic("aegis.tasks.assign.w-2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
      expect(mockAdmin.createTopics).not.toHaveBeenCalled();
    });

    it("captures admin errors as structured TOPIC_PROVISION_FAILED error", async () => {
      const mockAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        listTopics: vi.fn().mockRejectedValue(new Error("Kafka connection lost")),
        createTopics: vi.fn(),
      };

      const provisioner = new KafkaTopicProvisioner({
        admin: mockAdmin as unknown as Admin,
      });

      const result = await provisioner.ensureTopic("aegis.tasks.assign.w-3");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TOPIC_PROVISION_FAILED");
        expect(result.error.message).toContain("Kafka connection lost");
      }
    });
  });
});
