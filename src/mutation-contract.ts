// Internal only: no production operation or transport imports this boundary.
import { createHash } from "node:crypto";
import { z } from "zod";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
// Canonical JSON: UTF-16 key order, array order retained, finite numbers using
// JSON number encoding (-0 = 0), exact strings (no Unicode/fuzzy normalization).
// Reject non-JSON values rather than silently dropping them from the hash.
export function canonical(value: unknown): string {
  if (value && typeof value === "object") {
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (descriptor.get || descriptor.set)
        throw new MutationError(
          "INVALID_MUTATION",
          "Accessors are not JSON data.",
        );
    }
  }
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      !Object.keys(value).every((key, index) => key === String(index))
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Sparse/decorated arrays are not JSON.",
      );
    return `[${value.map(canonical).join(",")}]`;
  }
  if (
    typeof value === "object" &&
    value &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length)
      throw new MutationError(
        "INVALID_MUTATION",
        "Only enumerable JSON keys are accepted.",
      );
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new MutationError(
    "INVALID_MUTATION",
    "Expected finite, plain JSON data.",
  );
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex");
const text = z.string().min(1).max(256);
export const Reference = z.object({ entity: text, id: text }).strict();
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export const Fact = z
  .object({ reference: Reference, field: text, expected: json })
  .strict();
export const MutationRequest = z
  .object({
    operation: z
      .object({ kind: text, version: z.number().int().positive() })
      .strict(),
    request_key: text.optional(),
    items: z
      .array(
        z
          .object({
            item_key: text,
            targets: z.array(Reference).max(100),
            references: z.array(Reference).max(100),
            changes: z.record(z.string(), json),
            preconditions: z.array(Fact).max(100),
            payload: json,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type MutationRequest = z.infer<typeof MutationRequest>;
export type Reference = z.infer<typeof Reference>;
export type Fact = z.infer<typeof Fact>;
export type MutationItem = MutationRequest["items"][number];
export function normalize(input: unknown, apply = false): MutationRequest {
  let encoded: string;
  try {
    encoded = canonical(input);
  } catch {
    throw new MutationError("INVALID_MUTATION", "Mutation must be plain JSON.");
  }
  if (Buffer.byteLength(encoded) > 65536)
    throw new MutationError("INVALID_MUTATION", "Mutation exceeds 64 KiB.");
  const parsed = MutationRequest.safeParse(JSON.parse(encoded));
  if (
    !parsed.success ||
    canonical(parsed.data) !== encoded ||
    (apply && !parsed.data.request_key)
  )
    throw new MutationError(
      "INVALID_MUTATION",
      "Invalid mutation envelope; apply requires caller request_key.",
    );
  const request = parsed.data;
  if (
    new Set(request.items.map((i) => i.item_key)).size !== request.items.length
  )
    throw new MutationError("INVALID_MUTATION", "Duplicate item_key.");
  for (const item of request.items)
    for (const fact of item.preconditions) {
      if (
        ![...item.targets, ...item.references].some(
          (ref) => canonical(ref) === canonical(fact.reference),
        )
      )
        throw new MutationError(
          "INVALID_MUTATION",
          "Every precondition reference must be declared.",
        );
    }
  return request;
}
export function inputHash(request: MutationRequest): string {
  const { request_key: _key, ...meaning } = request;
  return digest(meaning);
}
export type MutationCode =
  | "INVALID_MUTATION"
  | "REQUEST_KEY_REUSE_MISMATCH"
  | "PRECONDITION_CONFLICT"
  | "MUTATION_BUSY"
  | "MUTATION_RECONCILIATION_REQUIRED"
  | "WRITE_NOT_AUTHORIZED"
  | "MUTATION_STATE_UNAVAILABLE"
  | "REPEATING_COMPLETION_UNSUPPORTED";
export class MutationError extends Error {
  constructor(
    public code: MutationCode,
    message: string,
  ) {
    super(message);
  }
}
export function mutationErrorInfo(error: unknown): {
  code: MutationCode;
  message: string;
} {
  return error instanceof MutationError
    ? { code: error.code, message: error.message }
    : {
        code: "MUTATION_STATE_UNAVAILABLE",
        message:
          "Mutation safety state or required facts unavailable; fail closed.",
      };
}
export const ItemOutcome = z
  .object({
    item_key: text,
    outcome: z.enum(["applied", "rejected", "conflict", "partial", "unknown"]),
    evidence: z.array(z.string().max(1024)).max(100),
    resource: Reference.optional(),
  })
  .strict();
export const MutationResult = z
  .object({
    request_key: text,
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(ItemOutcome).min(1).max(100),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
    reconciliation_required: z.boolean(),
  })
  .strict();
export type MutationResult = z.infer<typeof MutationResult>;
export type Authorization = {
  mode: "read-only" | "preview-authorized" | "apply-authorized";
};
export const DENY_WRITES: Readonly<Authorization> = Object.freeze({
  mode: "read-only",
});
export type PlannedItem = {
  item_key: string;
  preconditions: Fact[];
  predicted_changes: Json;
  payload: Json;
};
export type Plan = { items: PlannedItem[] };
// Ports are trusted internal implementation code, not a sandbox for plugins.
// Planning receives plain frozen facts, never native objects or a writer.
export interface Planner {
  operation: MutationRequest["operation"];
  validate(item: MutationItem, facts: Resolved[]): PlannedItem;
}
export type Resolved = { reference: Reference; facts: Record<string, Json> };
export interface MutationReader {
  resolve(reference: Reference): Promise<Resolved | null>;
  readFact(fact: Fact): Promise<Json>;
  // Must be a NEW read evaluation. Never consume setter-returned state.
  // settled requires proof no original setter can still execute plus independent state.
  // A launcher exit/timeout or setter success alone is never such proof.
  readback(
    request: MutationRequest,
    plan: Plan,
    receipt?: Json,
  ): Promise<Readback>;
}
export const Readback = z
  .object({
    settled: z.boolean(),
    not_attempted: z.enum(["rejected", "conflict"]).optional(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
    items: z
      .array(
        z
          .object({
            item_key: text,
            resource: Reference.optional(),
            all_postconditions: z.boolean(),
            some_effects: z.boolean(),
            evidence: z.array(z.string().min(1).max(1024)).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type Readback = z.infer<typeof Readback>;
export interface MutationWriter {
  // Does not return outcomes/state. Receipt records dispatch identity, never proof of final state.
  // NFO-10 must recheck in-app facts at its first-setter boundary as well.
  apply(
    request: MutationRequest,
    plan: Plan,
    recordReceipt: (receipt: Json) => Promise<void>,
  ): Promise<void>;
}
export function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
