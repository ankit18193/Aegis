/**
 * Process lifecycle management and containment for Aegis MCP stdio servers.
 * Enforces shell-free process spawning, tracking, crash containment,
 * and graceful process termination on SIGINT/SIGTERM.
 */

import { McpError } from "./errors.js";
import type { IMcpClient } from "./types.js";

const DANGEROUS_SHELL_PATTERNS = /[;&|`$<>]/;

/**
 * Validates that an executable command does not contain dangerous shell metacharacters.
 */
export function assertSafeCommand(command: string, serverId = "security"): void {
  if (DANGEROUS_SHELL_PATTERNS.test(command)) {
    throw McpError.invalidConfig(
      serverId,
      `Command contains forbidden shell metacharacters: '${command}'. Shell execution is prohibited.`,
    );
  }
}

/**
 * Registry tracking active MCP clients for deterministic lifecycle management and cleanup.
 */
export class McpProcessRegistry {
  private static instance: McpProcessRegistry | null = null;
  private readonly activeClients = new Set<IMcpClient>();
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  static getInstance(): McpProcessRegistry {
    McpProcessRegistry.instance ??= new McpProcessRegistry();
    return McpProcessRegistry.instance;
  }

  /**
   * Resets the singleton instance (primarily for testing).
   */
  static resetInstance(): void {
    if (McpProcessRegistry.instance) {
      McpProcessRegistry.instance.detachSignalHandlers();
      McpProcessRegistry.instance = null;
    }
  }

  register(client: IMcpClient): () => void {
    this.activeClients.add(client);
    return () => {
      this.activeClients.delete(client);
    };
  }

  unregister(client: IMcpClient): void {
    this.activeClients.delete(client);
  }

  get trackedCount(): number {
    return this.activeClients.size;
  }

  /**
   * Gracefully terminates all tracked active MCP client processes.
   */
  async terminateAll(): Promise<void> {
    const clients = Array.from(this.activeClients);
    this.activeClients.clear();

    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.disconnect();
        } catch {
          // Ignore errors during emergency termination
        }
      }),
    );
  }

  /**
   * Attaches graceful termination handlers to SIGINT and SIGTERM.
   */
  attachSignalHandlers(): void {
    if (this.sigintHandler || this.sigtermHandler) {
      return;
    }

    this.sigintHandler = () => {
      void this.terminateAll();
    };
    this.sigtermHandler = () => {
      void this.terminateAll();
    };

    process.once("SIGINT", this.sigintHandler);
    process.once("SIGTERM", this.sigtermHandler);
  }

  /**
   * Detaches registered signal handlers (useful for hermetic test execution).
   */
  detachSignalHandlers(): void {
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }
  }
}
