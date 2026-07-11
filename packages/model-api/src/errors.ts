/**
 * Structured regeneration errors.
 *
 * Codes are machine-readable on purpose: they are surfaced to the user AND fed
 * back to the AI copilot verbatim so it can self-correct ("FILLET_TOO_LARGE →
 * retry with a smaller radius").
 */

export type RegenErrorCode =
  | "EMPTY_SELECTION"
  | "QUERY_NO_MATCH"
  | "INVALID_PARAMS"
  | "EXPRESSION_ERROR"
  | "OPEN_PROFILE"
  | "KERNEL_FAILURE"
  | "FILLET_TOO_LARGE"
  | "BOOLEAN_FAILED"
  | "UPSTREAM_FAILED";

export class RegenError extends Error {
  constructor(
    readonly code: RegenErrorCode,
    message: string,
    /** Persistent entity names involved, for viewport highlighting. */
    readonly entities: string[] = [],
  ) {
    super(message);
    this.name = "RegenError";
  }
}

/** Serializable form (Errors don't cross the worker boundary intact). */
export interface RegenErrorInfo {
  code: RegenErrorCode;
  message: string;
  entities: string[];
}

export function toErrorInfo(e: unknown): RegenErrorInfo {
  if (e instanceof RegenError)
    return { code: e.code, message: e.message, entities: e.entities };
  return {
    code: "KERNEL_FAILURE",
    message: e instanceof Error ? e.message : String(e),
    entities: [],
  };
}
