import type { Logger } from "@aegis/logger";

/**
 * Configuration options for the deterministic worker selector.
 */
export interface WorkerSelectorOptions {
  readonly logger?: Logger | undefined;
}
