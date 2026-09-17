import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { eventService } from "../services/eventService";
import type { RunEvent } from "../types";

export const runEventsQueryKey = (runId: string) => ["events", runId] as const;

export function useRunEvents(runId: string | undefined): {
  events: RunEvent[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
} {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (!runId) return;
    const unsubscribe = eventService.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: runEventsQueryKey(runId) });
    });
    return unsubscribe;
  }, [runId, queryClient]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: runEventsQueryKey(runId ?? ""),
    queryFn: () => {
      if (!runId) return [];
      return eventService.getEvents(runId);
    },
    enabled: Boolean(runId),
  });

  return {
    events: data ?? [],
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
  };
}
