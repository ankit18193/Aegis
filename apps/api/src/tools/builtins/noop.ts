/**
 * Built-in No-Operation Tool for the Aegis Tool System.
 * Performs no side effects and returns confirmation.
 */

import { ok } from "@aegis/types";
import { z } from "zod";

import type { Tool } from "../tool.js";

export const noopInputSchema = z.record(z.unknown()).optional();
export type NoopInput = z.infer<typeof noopInputSchema>;

export const noopOutputSchema = z.object({
  noop: z.literal(true),
});
export type NoopOutput = z.infer<typeof noopOutputSchema>;

export const noopTool: Tool<NoopInput, NoopOutput> = {
  name: "noop",
  description: "No-operation tool that performs no side effects.",
  inputSchema: noopInputSchema,
  outputSchema: noopOutputSchema,
  execute: async () => {
    await Promise.resolve();
    return ok({ noop: true });
  },
};
