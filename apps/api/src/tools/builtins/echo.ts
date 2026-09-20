/**
 * Built-in Echo Tool for the Aegis Tool System.
 * Echoes back the provided text message deterministically.
 */

import { ok } from "@aegis/types";
import { z } from "zod";

import type { Tool } from "../tool.js";

export const echoInputSchema = z.object({
  text: z.string({ required_error: "Property 'text' is required." }),
});
export type EchoInput = z.infer<typeof echoInputSchema>;

export const echoOutputSchema = z.object({
  text: z.string(),
});
export type EchoOutput = z.infer<typeof echoOutputSchema>;

export const echoTool: Tool<EchoInput, EchoOutput> = {
  name: "echo",
  description: "Echoes back the provided text message deterministically.",
  inputSchema: echoInputSchema,
  outputSchema: echoOutputSchema,
  execute: async (input) => {
    await Promise.resolve();
    return ok({ text: input.text });
  },
};
