/**
 * Platform health status enumeration.
 *
 * Used to report the liveness and readiness of platform components.
 */
export enum HealthStatus {
  /** Component is fully operational. */
  Healthy = "healthy",
  /** Component is degraded but still functional. */
  Degraded = "degraded",
  /** Component has failed and is not operational. */
  Unhealthy = "unhealthy",
}

/**
 * Describes the health of a named platform component.
 */
export interface ComponentHealth {
  /** The name of the component being checked. */
  readonly name: string;
  /** Current health status. */
  readonly status: HealthStatus;
  /** Optional human-readable message providing context. */
  readonly message?: string;
  /** ISO 8601 timestamp of when this check was performed. */
  readonly checkedAt: string;
}

/**
 * Aggregated platform health result.
 */
export interface PlatformHealth {
  /** Overall platform status (worst of all component statuses). */
  readonly status: HealthStatus;
  /** ISO 8601 timestamp of the platform-level check. */
  readonly timestamp: string;
  /** Individual component health results. */
  readonly components: readonly ComponentHealth[];
}

/**
 * Creates a ComponentHealth record for the given name and status.
 *
 * @param name - Human-readable component name.
 * @param status - The current HealthStatus.
 * @param message - Optional detail message.
 * @returns A fully populated ComponentHealth object.
 */
export function createComponentHealth(
  name: string,
  status: HealthStatus,
  message?: string,
): ComponentHealth {
  return {
    name,
    status,
    ...(message !== undefined ? { message } : {}),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Computes the aggregate platform health from a list of component results.
 *
 * The overall status is determined by the worst individual status:
 * unhealthy > degraded > healthy.
 *
 * @param components - Array of component health results.
 * @returns Aggregated PlatformHealth.
 */
export function aggregatePlatformHealth(components: readonly ComponentHealth[]): PlatformHealth {
  const STATUS_SEVERITY: Record<HealthStatus, number> = {
    [HealthStatus.Healthy]: 0,
    [HealthStatus.Degraded]: 1,
    [HealthStatus.Unhealthy]: 2,
  };

  let worstStatus = HealthStatus.Healthy;

  for (const component of components) {
    const componentSeverity = STATUS_SEVERITY[component.status];
    const currentWorstSeverity = STATUS_SEVERITY[worstStatus];

    if (componentSeverity > currentWorstSeverity) {
      worstStatus = component.status;
    }
  }

  return {
    status: worstStatus,
    timestamp: new Date().toISOString(),
    components,
  };
}
