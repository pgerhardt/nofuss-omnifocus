import { z } from "zod";
import { ReadError } from "./contract.js";

export type ErrorCategory =
  | "invalid_input"
  | "unsupported_capability"
  | "not_found"
  | "wrong_entity"
  | "invalid_cursor"
  | "cursor_mismatch"
  | "native_execution"
  | "permission"
  | "deadline"
  | "output_limit"
  | "internal_protocol"
  | "unavailable";
export function errorCategory(code: string): ErrorCategory {
  if (
    [
      "INVALID_INPUT",
      "INVALID_TEXT_SELECTION",
      "INVALID_COLLECTION_SELECTION",
      "INVALID_TREE",
    ].includes(code)
  )
    return "invalid_input";
  if (code.startsWith("UNSUPPORTED_")) return "unsupported_capability";
  if (["NOT_FOUND", "PROJECT_NOT_FOUND", "TAG_NOT_FOUND"].includes(code))
    return "not_found";
  if (["WRONG_ENTITY", "PROJECT_ROOT_EXCLUDED"].includes(code))
    return "wrong_entity";
  if (["INVALID_CURSOR", "CURSOR_STALE"].includes(code))
    return "invalid_cursor";
  if (code === "CURSOR_QUERY_MISMATCH") return "cursor_mismatch";
  if (code === "AUTOMATION_DENIED") return "permission";
  if (["TIMEOUT", "CANCELLED"].includes(code)) return "deadline";
  if (
    [
      "OUTPUT_LIMIT",
      "RESPONSE_LIMIT",
      "FIELD_OUTPUT_LIMIT",
      "RECORD_OUTPUT_LIMIT",
    ].includes(code)
  )
    return "output_limit";
  if (["NOT_RUNNING", "QUEUE_FULL", "SHUTDOWN"].includes(code))
    return "unavailable";
  if (
    ["INVALID_NATIVE_OUTPUT", "RESPONSE_MISMATCH", "READ_FAILED"].includes(code)
  )
    return "internal_protocol";
  return "native_execution";
}
export function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof ReadError
    ? { code: error.code, message: error.message }
    : {
        code: "READ_FAILED",
        message: "Read failed; no successful empty result substituted.",
      };
}
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ReadError(
      "INVALID_INPUT",
      "Input does not match the strict read contract.",
    );
  return result.data;
}
export function parseNative<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ReadError(
      "INVALID_NATIVE_OUTPUT",
      "Native result does not match the read contract.",
    );
  return result.data;
}
