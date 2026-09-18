import {
  createRunRequestSchema,
  runResultArtifactSchema,
  runResultSchema,
  runSchema,
  runStatusSchema,
  taskSchema,
  taskStatusSchema,
  workflowSchema,
} from "@aegis/contracts";
import type { CreateRunRequest } from "@aegis/contracts";

export {
  runStatusSchema,
  taskStatusSchema,
  taskSchema as taskSummarySchema,
  workflowSchema as workflowSummarySchema,
  runResultArtifactSchema,
  runResultSchema,
  runSchema,
};

export const createRunInputSchema = createRunRequestSchema;
export type CreateRunInput = CreateRunRequest;
