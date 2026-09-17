import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { runService } from "../services/runService";
import type { RunListItem } from "../types";

export const RUNS_QUERY_KEY = ["runs"] as const;

export function useRuns(): {
  runs: RunListItem[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  // Listen to mock repository events to immediately invalidate cache
  React.useEffect(() => {
    const unsubscribe = runService.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
    });
    return unsubscribe;
  }, [queryClient]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: RUNS_QUERY_KEY,
    queryFn: () => runService.getRuns(),
  });

  return {
    runs: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
  };
}
