import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import type { CreateRunInput } from "../schemas/runSchemas";
import { runService } from "../services/runService";
import type { Run } from "../types";

import { RUNS_QUERY_KEY } from "./useRuns";

export function useCreateRun(options?: {
  onSuccess?: (run: Run) => void;
}): {
  createRun: (input: CreateRunInput) => Promise<Run>;
  isPending: boolean;
  error: Error | null;
} {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: async (input: CreateRunInput): Promise<Run> => {
      return runService.createRun(input);
    },
    onSuccess: (newRun) => {
      void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
      options?.onSuccess?.(newRun);
      void navigate(`/runs/${newRun.id}`);
    },
  });

  return {
    createRun: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error : null,
  };
}
