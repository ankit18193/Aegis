import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { runService } from "../services/runService";
import type { Run } from "../types";

export const runQueryKey = (runId: string) => ["run", runId] as const;

export function useRun(runId: string | undefined): {
  run: Run | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (!runId) return;
    const unsubscribe = runService.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: runQueryKey(runId) });
    });
    return unsubscribe;
  }, [runId, queryClient]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: runQueryKey(runId ?? ""),
    queryFn: () => {
      if (!runId) return null;
      return runService.getRun(runId);
    },
    enabled: Boolean(runId),
  });

  return {
    run: data ?? null,
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
  };
}
