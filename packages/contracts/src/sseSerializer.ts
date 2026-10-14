/**
 * Deterministic Server-Sent Events (SSE) Frame Serialization — Phase 13B (Commit 2)
 *
 * Implements deterministic encoding and parsing for standard SSE frames:
 * - `id: <eventId>\n`
 * - `event: <eventType>\n`
 * - `retry: <reconnectMs>\n`
 * - `data: <jsonPayload>\n` (with proper multiline handling)
 * - `: <comment>\n\n` (comment-based keep-alive heartbeats)
 *
 * Guarantees:
 * 1. Standards Compliance: follows W3C/WHATWG SSE wire framing specification.
 * 2. Determinism: consistent field ordering (id -> event -> retry -> data).
 * 3. Multiline Correctness: splits multiline payloads and prefixes each with `data: `.
 * 4. Injection Safety: rejects newlines in `id` and `event` field values.
 * 5. Unicode Integrity: preserves full UTF-8 Unicode characters and emojis.
 * 6. Decoupled Architecture: zero dependencies on HTTP frameworks (Fastify) or DOM (EventSource).
 */

import { err, ok, type Result } from "@aegis/types";

import {
  validateSseEnvelope,
  type SseTransportEnvelope,
  type SseValidationError,
} from "./sse.js";

// ─────────────────────────────────────────────────────────────────────────────
// Raw Frame and Serialization Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Representation of a low-level SSE frame.
 */
export interface SseRawFrame {
  readonly id?: string | undefined;
  readonly event?: string | undefined;
  readonly retry?: number | undefined;
  readonly data?: string | undefined;
  readonly comment?: string | undefined;
}

/**
 * Configuration options for SSE envelope serialization.
 */
export interface SseSerializeOptions {
  /**
   * If true, validates envelope against canonical schema before serialization.
   * Defaults to true.
   */
  readonly validate?: boolean;

  /**
   * Optional client reconnect delay in milliseconds (SSE `retry:` field).
   */
  readonly retryMs?: number;

  /**
   * Optional event name override. If omitted, uses `envelope.type`.
   */
  readonly eventName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization & Deserialization Errors
// ─────────────────────────────────────────────────────────────────────────────

export type SseSerializationErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_FIELD_NEWLINE"
  | "INVALID_RETRY_VALUE"
  | "JSON_SERIALIZATION_FAILED"
  | "EMPTY_FRAME";

export interface SseSerializationError {
  readonly code: SseSerializationErrorCode;
  readonly message: string;
  readonly validationIssues?: readonly string[];
  readonly cause?: unknown;
}

export type SseDeserializationErrorCode =
  | "INVALID_FRAME_STRUCTURE"
  | "INVALID_JSON_PAYLOAD"
  | "VALIDATION_FAILED";

export interface SseDeserializationError {
  readonly code: SseDeserializationErrorCode;
  readonly message: string;
  readonly validationIssues?: readonly string[];
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Framing Helpers
// ─────────────────────────────────────────────────────────────────────────────

const NEWLINE_REGEX = /\r\n|\r|\n/;

/**
 * Validates that a header field value (id or event) does NOT contain newlines.
 * The SSE specification forbids CRLF or LF within field identifiers.
 */
function containsNewline(value: string): boolean {
  return NEWLINE_REGEX.test(value);
}

/**
 * Splits arbitrary multiline text into individual lines normalizing CRLF, CR, and LF.
 */
function splitLines(text: string): string[] {
  return text.split(NEWLINE_REGEX);
}

/**
 * Formats a comment-based SSE frame (e.g. `: keep-alive\n\n`).
 * Used for protocol-level keep-alive heartbeats without triggering DOM message events.
 */
export function formatSseComment(commentText: string): string {
  const lines = splitLines(commentText);
  const formatted = lines.map((line) => (line.length > 0 ? `: ${line}` : ":")).join("\n");
  return `${formatted}\n\n`;
}

/**
 * Formats a default keep-alive comment frame.
 */
export function formatSseHeartbeatComment(message = "keep-alive"): string {
  return formatSseComment(message);
}

/**
 * Low-level deterministic formatter converting an `SseRawFrame` into a standards-compliant SSE chunk.
 * Returns a `Result<string, SseSerializationError>`.
 */
export function formatSseFrame(frame: SseRawFrame): Result<string, SseSerializationError> {
  // If frame is purely a comment frame
  if (frame.comment !== undefined && frame.id === undefined && frame.event === undefined && frame.data === undefined) {
    return ok(formatSseComment(frame.comment));
  }

  // Validate no newline injections in id
  if (frame.id !== undefined && containsNewline(frame.id)) {
    return err({
      code: "INVALID_FIELD_NEWLINE",
      message: "SSE 'id' field cannot contain newline characters (CR or LF).",
    });
  }

  // Validate no newline injections in event
  if (frame.event !== undefined && containsNewline(frame.event)) {
    return err({
      code: "INVALID_FIELD_NEWLINE",
      message: "SSE 'event' field cannot contain newline characters (CR or LF).",
    });
  }

  // Validate retry if provided
  if (frame.retry !== undefined) {
    if (!Number.isInteger(frame.retry) || frame.retry < 0) {
      return err({
        code: "INVALID_RETRY_VALUE",
        message: "SSE 'retry' field must be a non-negative integer.",
      });
    }
  }

  // Ensure frame has at least one content field
  if (
    frame.id === undefined &&
    frame.event === undefined &&
    frame.data === undefined &&
    frame.retry === undefined &&
    frame.comment === undefined
  ) {
    return err({
      code: "EMPTY_FRAME",
      message: "Cannot format empty SSE frame: at least one field must be defined.",
    });
  }

  const lines: string[] = [];

  // 1. Comment line (if present alongside fields)
  if (frame.comment !== undefined) {
    for (const line of splitLines(frame.comment)) {
      lines.push(line.length > 0 ? `: ${line}` : ":");
    }
  }

  // 2. id field
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`);
  }

  // 3. event field
  if (frame.event !== undefined) {
    lines.push(`event: ${frame.event}`);
  }

  // 4. retry field
  if (frame.retry !== undefined) {
    lines.push(`retry: ${String(frame.retry)}`);
  }

  // 5. data field (splits multiline content per SSE spec)
  if (frame.data !== undefined) {
    const dataLines = splitLines(frame.data);
    for (const dataLine of dataLines) {
      lines.push(`data: ${dataLine}`);
    }
  }

  // Terminate frame with double newline
  return ok(`${lines.join("\n")}\n\n`);
}

/**
 * High-level serializer for canonical Aegis `SseTransportEnvelope` instances.
 * Validates envelope (optional, default true), serializes payload to deterministic JSON,
 * and formats the resulting frame according to SSE specifications.
 */
export function serializeSseEnvelope(
  envelope: unknown,
  options: SseSerializeOptions = {},
): Result<string, SseSerializationError> {
  const shouldValidate = options.validate ?? true;

  let validatedEnvelope: SseTransportEnvelope;
  if (shouldValidate) {
    const validation = validateSseEnvelope(envelope);
    if (!validation.ok) {
      const valErr: SseValidationError = validation.error;
      return err({
        code: "VALIDATION_FAILED",
        message: valErr.message,
        validationIssues: valErr.issues,
      });
    }
    validatedEnvelope = validation.value;
  } else {
    validatedEnvelope = envelope as SseTransportEnvelope;
  }

  let jsonData: string;
  try {
    jsonData = JSON.stringify(validatedEnvelope);
  } catch (serializationErr) {
    return err({
      code: "JSON_SERIALIZATION_FAILED",
      message: "Failed to serialize SSE transport envelope to JSON.",
      cause: serializationErr,
    });
  }

  const rawFrame: SseRawFrame = {
    id: validatedEnvelope.id,
    event: options.eventName ?? validatedEnvelope.type,
    ...(options.retryMs !== undefined ? { retry: options.retryMs } : {}),
    data: jsonData,
  };

  return formatSseFrame(rawFrame);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing & Deserialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a raw SSE wire text chunk into an `SseRawFrame`.
 */
export function parseSseFrame(rawText: string): Result<SseRawFrame, SseDeserializationError> {
  const trimmed = rawText.endsWith("\n\n") ? rawText.slice(0, -2) : rawText.trim();
  if (trimmed.length === 0) {
    return err({
      code: "INVALID_FRAME_STRUCTURE",
      message: "Cannot parse empty SSE frame text.",
    });
  }

  const lines = splitLines(trimmed);
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];
  const commentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      // Comment line
      commentLines.push(line.slice(1).trimStart());
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      // Line with field name only and no value per SSE spec
      const field = line.trim();
      if (field === "data") {
        dataLines.push("");
      }
      continue;
    }

    const field = line.slice(0, colonIndex).trim();
    // In SSE spec, if value begins with a single space, strip it
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "id":
        id = value;
        break;
      case "event":
        event = value;
        break;
      case "retry": {
        const parsedRetry = Number.parseInt(value, 10);
        if (!Number.isNaN(parsedRetry)) {
          retry = parsedRetry;
        }
        break;
      }
      case "data":
        dataLines.push(value);
        break;
      default:
        // Ignore unrecognized fields per SSE specification
        break;
    }
  }

  const result: SseRawFrame = {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(retry !== undefined ? { retry } : {}),
    ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}),
    ...(commentLines.length > 0 ? { comment: commentLines.join("\n") } : {}),
  };

  return ok(result);
}

/**
 * Parses and validates an SSE frame containing a serialized `SseTransportEnvelope`.
 * Returns the unboxed, schema-validated `SseTransportEnvelope`.
 */
export function deserializeSseEnvelope(
  raw: string | SseRawFrame,
): Result<SseTransportEnvelope, SseDeserializationError> {
  let rawFrame: SseRawFrame;

  if (typeof raw === "string") {
    const parseRes = parseSseFrame(raw);
    if (!parseRes.ok) {
      return parseRes;
    }
    rawFrame = parseRes.value;
  } else {
    rawFrame = raw;
  }

  if (!rawFrame.data) {
    return err({
      code: "INVALID_FRAME_STRUCTURE",
      message: "SSE frame contains no 'data:' field to deserialize envelope.",
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawFrame.data);
  } catch (jsonErr) {
    return err({
      code: "INVALID_JSON_PAYLOAD",
      message: "Failed to parse SSE 'data:' JSON payload.",
      cause: jsonErr,
    });
  }

  const validation = validateSseEnvelope(parsedJson);
  if (!validation.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message: validation.error.message,
      validationIssues: validation.error.issues,
    });
  }

  return ok(validation.value);
}
