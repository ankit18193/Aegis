import type { Run, RunEvent } from "@aegis/contracts";
import * as React from "react";

import {
  initialExecutionState,
  reduceExecutionState,
} from "../state/execution.reducer";
import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamEvent,
} from "../stream/executionStream.types";
import type { IExecutionStreamClient } from "../stream/IExecutionStreamClient";
import { getExecutionStreamClient } from "../stream/streamClientService";

export interface UseExecutionStreamOptions {
  /**
   * The identifier of the active execution run to stream.
   */
  readonly runId: string | undefined;

  /**
   * Initial run snapshot loaded from REST/mock repository.
   */
  readonly initialRun?: Run | null;

  /**
   * Initial timeline events loaded from REST/mock repository.
   */
  readonly initialEvents?: RunEvent[];

  /**
   * Optional custom client override (defaults to getExecutionStreamClient()).
   */
  readonly client?: IExecutionStreamClient;

  /**
   * Optional authoritative state reconciliation callback (e.g. refetch from REST API).
   * Automatically triggered when stream errors indicate reconcileRequired.
   */
  readonly onReconcile?: ((runId: string) => Promise<void>) | undefined;
}

export interface UseExecutionStreamResult {
  /**
   * Live execution run state, continuously updated as stream events arrive.
   */
  readonly run: Run | null;

  /**
   * Chronological list of execution events for the active run.
   */
  readonly events: readonly RunEvent[];

  /**
   * Current transport connection state.
   */
  readonly connectionState: ConnectionState;

  /**
   * Latest stream error, if any.
   */
  readonly error: ExecutionStreamError | null;

  /**
   * The active stream client instance.
   */
  readonly client: IExecutionStreamClient;

  /**
   * Manually triggers the authoritative state reconciliation callback.
   */
  readonly reconcile: () => Promise<void>;

  /**
   * Directly reconciles the internal state with an authoritative snapshot.
   */
  readonly reconcileState: (run: Run, events?: RunEvent[]) => void;
}

const EMPTY_EVENTS: readonly RunEvent[] = [];

/**
 * React hook connecting an execution run to the stream client abstraction.
 * Dispatches incoming stream events to the reducer, provides connection status,
 * triggers authoritative state reconciliation on gap/overflow, and deterministically
 * cleans up subscriptions when navigating or unmounting.
 */
export function useExecutionStream(
  options: UseExecutionStreamOptions,
): UseExecutionStreamResult {
  const {
    runId,
    initialRun = null,
    initialEvents = EMPTY_EVENTS,
    client = getExecutionStreamClient(),
    onReconcile,
  } = options;

  const [state, dispatch] = React.useReducer(reduceExecutionState, initialExecutionState);
  const [connectionState, setConnectionState] = React.useState<ConnectionState>(
    client.getConnectionState(),
  );
  const [error, setError] = React.useState<ExecutionStreamError | null>(null);

  const lastInitializedRunIdRef = React.useRef<string | null>(null);

  // Initialize or re-sync state when initialRun arrives or changes
  React.useEffect(() => {
    if (runId && initialRun?.id === runId) {
      if (lastInitializedRunIdRef.current !== runId) {
        lastInitializedRunIdRef.current = runId;
        dispatch({
          type: "INIT_RUN",
          payload: {
            run: initialRun,
            initialEvents: initialEvents as RunEvent[],
          },
        });
      }
    } else if (!runId) {
      lastInitializedRunIdRef.current = null;
      dispatch({ type: "RESET" });
    }
  }, [runId, initialRun, initialEvents]);

  const handleReconcile = React.useCallback(async () => {
    if (!runId || !onReconcile) return;
    try {
      await onReconcile(runId);
    } catch {
      // Authoritative reconciliation failure is handled by caller
    }
  }, [runId, onReconcile]);

  const reconcileState = React.useCallback((run: Run, events?: RunEvent[]) => {
    dispatch({
      type: "RECONCILE_STATE",
      payload: {
        run,
        reconciledEvents: events,
      },
    });
  }, []);

  // Manage run-scoped subscription lifecycle
  React.useEffect(() => {
    if (!runId) {
      setConnectionState("disconnected");
      return;
    }

    // Set initial connection state from client
    setConnectionState(client.getConnectionState());
    setError(null);

    const subscription = client.subscribe(runId, {
      onEvent: (event: ExecutionStreamEvent) => {
        dispatch({ type: "STREAM_EVENT", payload: event });
      },
      onStateChange: (newState: ConnectionState) => {
        setConnectionState(newState);
      },
      onError: (streamErr: ExecutionStreamError) => {
        setError(streamErr);
        if (streamErr.reconcileRequired) {
          void handleReconcile();
        }
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runId, client, handleReconcile]);

  // Fall back to initialRun if reducer has not yet processed an INIT_RUN
  const effectiveRun = state.run ?? initialRun;
  const effectiveEvents = state.events.length > 0 ? state.events : initialEvents;

  return {
    run: effectiveRun,
    events: effectiveEvents,
    connectionState,
    error,
    client,
    reconcile: handleReconcile,
    reconcileState,
  };
}
