/**
 * Event Payload Hygiene & Redaction for Aegis Tool System.
 *
 * IMPORTANT INVARIANT:
 * Sanitization is applied STRICTLY to the copy of payloads used for
 * event persistence, audit logs, and timelines.
 * Raw tool input arguments are NEVER mutated prior to tool execution.
 */

const SENSITIVE_KEY_PATTERN = /password|token|secret|authorization|api[_-]?key|credential/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Creates a sanitized copy of a payload by recursively redacting sensitive keys.
 * Protected against circular references via WeakSet.
 */
export function sanitizePayload<T>(payload: T, seen = new WeakSet()): T {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return payload;
  }

  if (seen.has(payload)) {
    return "[CIRCULAR]" as unknown as T;
  }
  seen.add(payload);

  if (Array.isArray(payload)) {
    const list = payload as readonly unknown[];
    const sanitizedArray: unknown[] = list.map((item) => sanitizePayload(item, seen));
    return sanitizedArray as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizePayload(value, seen);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
