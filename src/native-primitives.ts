import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  MutationError,
  canonical,
  inputHash,
  type Json,
  type Reference,
  type MutationRequest,
} from "./mutation-contract.js";
import { parseInput, parseNative } from "./errors.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
const id = z.string().min(1).max(256),
  options = {
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(4).default([]),
  };
const calendar = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const n = Date.parse(s + "T00:00:00Z");
    return (
      s.slice(0, 4) >= "1000" &&
      Number.isFinite(n) &&
      new Date(n).toISOString().slice(0, 10) === s
    );
  });
export const PrimitiveInputs = {
  "document.set_forecast_tag": z
    .object({
      ...options,
      entity: z.literal("document"),
      document_id: id,
      tag_id: id.nullable(),
    })
    .strict(),
  "tag.set_allows_next_action": z
    .object({
      ...options,
      entity: z.literal("tag"),
      tag_id: id,
      allows_next_action: z.boolean(),
    })
    .strict(),
  "project.set_next_review_date": z
    .object({
      ...options,
      entity: z.literal("project"),
      project_id: id,
      date: calendar.nullable(),
    })
    .strict(),
};
export const PreferencesInput = z.object({ tag_id: id.optional() }).strict();
const PreferencesOutput = z
  .object({
    document_id: id,
    forecast_tag_id: id.nullable(),
    tag: z.object({ id, allows_next_action: z.boolean() }).strict().nullable(),
    observed_at: z.string().datetime(),
  })
  .strict();
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().min(0).max(1),
    resource_id: id,
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
type Scope = keyof typeof PrimitiveInputs;
type Snapshot = Record<string, Json>;
export class NativePrimitives {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  async preferences(input: unknown) {
    const a = parseInput(PreferencesInput, input),
      r = parseNative(
        PreferencesOutput,
        await this.native.run("primitive_preferences", a),
      );
    if (a.tag_id && r.tag?.id !== a.tag_id)
      throw Error("Preference tag correlation");
    return r;
  }
  private async facts(ref: Reference) {
    const r = (await this.native.run("primitive_facts", {
      reference: ref,
    })) as { reference: Reference; facts: Snapshot | null };
    if (
      canonical(r.reference) !== canonical(ref) ||
      (r.facts && r.facts.id !== ref.id)
    )
      throw Error("Primitive facts correlation");
    return r.facts;
  }
  async execute(scope: Scope, input: unknown) {
    const p = PrimitiveInputs[scope].safeParse(input);
    if (!p.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid primitive fields/date",
      );
    const args = p.data;
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    const ref: Reference =
      args.entity === "document"
        ? { entity: "document", id: args.document_id }
        : args.entity === "tag"
          ? { entity: "tag", id: args.tag_id }
          : { entity: "project", id: args.project_id };
    const references: Reference[] =
      args.entity === "document" && args.tag_id
        ? [{ entity: "tag", id: args.tag_id }]
        : [];
    const changes: Record<string, Json> =
      args.entity === "document"
        ? { tag_id: args.tag_id }
        : args.entity === "tag"
          ? { allows_next_action: args.allows_next_action }
          : { date: args.date };
    const req: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "primitive",
          targets: [ref],
          references,
          changes,
          preconditions: args.preconditions,
          payload: null,
        },
      ],
    };
    const authorized = (policy: WritePolicy | null) =>
      !!policy?.scopes.includes(scope) &&
      (ref.entity === "document"
        ? policy.allow_preferences &&
          references.every((r) => policy.tag_ids.includes(r.id))
        : ref.entity === "tag"
          ? policy.tag_ids.includes(ref.id)
          : policy.project_ids.includes(ref.id));
    const policy = await readWritePolicy(this.directory);
    const b = new MutationBoundary(
      {
        operation: req.operation,
        validate: (item, resolved) => {
          if (args.apply && !authorized(policy))
            throw new MutationError(
              "WRITE_NOT_AUTHORIZED",
              "Exact native preference/review authority required",
            );
          const s = resolved[0]!.facts.snapshot as Snapshot;
          if (
            ref.entity === "project" &&
            (!s.active ||
              s.repeat ||
              s.tentative ||
              (changes.date === null && !s.reset_date))
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Direct review reset requires verified ordinary calendar schedule",
            );
          return {
            item_key: item.item_key,
            predicted_changes: changes,
            preconditions: resolved.map((r) => ({
              reference: r.reference,
              field: "snapshot",
              expected: r.facts.snapshot!,
            })),
            payload: s,
          };
        },
      },
      {
        resolve: async (r) => {
          const s = await this.facts(r);
          return s ? { reference: r, facts: { snapshot: s } } : null;
        },
        readFact: async (f) => await this.facts(f.reference),
        readback: async (request, plan, raw) => {
          const receipt = Receipt.parse(raw);
          if (
            receipt.request_key !== request.request_key ||
            receipt.input_hash !== inputHash(request) ||
            receipt.resource_id !== ref.id
          )
            throw Error("Primitive receipt correlation");
          const before = plan.items[0]!.payload as Snapshot,
            after = await this.facts(ref);
          if (!after) throw Error("Exact primitive target unavailable");
          let expected: Snapshot;
          if (ref.entity === "document")
            expected = {
              ...before,
              forecast_tag_id: changes.tag_id!,
              forecast_value: changes.tag_id ?? "",
              forecast_override: changes.tag_id !== null,
            };
          else if (ref.entity === "tag")
            expected = {
              ...before,
              allows_next_action: changes.allows_next_action!,
            };
          else
            expected = {
              ...before,
              next_review_at: after.next_review_at!,
              next_review_date: changes.date ?? before.reset_date!,
              next_review_midnight: true,
            };
          const checks = [canonical(after) === canonical(expected)];
          for (const r of references) {
            const post = await this.facts(r),
              pre = plan.items[0]!.preconditions.find(
                (f) => canonical(f.reference) === canonical(r),
              );
            checks.push(!!post && canonical(post) === canonical(pre?.expected));
          }
          return {
            settled: true,
            ...(receipt.setter_count === 0 && receipt.error
              ? {
                  not_attempted:
                    receipt.error.code === "PRECONDITION_CONFLICT"
                      ? ("conflict" as const)
                      : ("rejected" as const),
                  error: receipt.error,
                }
              : {}),
            items: [
              {
                item_key: "primitive",
                resource: ref,
                all_postconditions: !receipt.error && checks.every(Boolean),
                some_effects: canonical(after) !== canonical(before),
                evidence: [
                  "Separate exact native preference/review readback; review date normalized to native local midnight; no remote sync or availability inference.",
                ],
              },
            ],
          };
        },
      },
      {
        apply: async (request, plan, record) => {
          const current = await readWritePolicy(this.directory);
          if (!authorized(current)) {
            await record({
              request_key: request.request_key!,
              input_hash: inputHash(request),
              finished: true,
              setter_count: 0,
              resource_id: ref.id,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Primitive authority revoked",
              },
            });
            return;
          }
          await record(
            Receipt.parse(
              await this.native.run("primitive_apply", {
                request,
                plan,
                input_hash: inputHash(request),
                policy: current,
              }),
            ),
          );
        },
      },
      new MutationJournal(this.directory),
      { mode: args.apply ? "apply-authorized" : "preview-authorized" },
    );
    if (args.apply) return b.apply(req);
    const preview = await b.preview(req);
    return {
      mode: "preview" as const,
      input_hash: preview.input_hash,
      plan: preview.plan.items[0]!.predicted_changes,
      apply_input: {
        ...args,
        preconditions: preview.plan.items[0]!.preconditions,
      },
    };
  }
}
