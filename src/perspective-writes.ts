import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  MutationError,
  canonical,
  inputHash,
  Fact,
  type Json,
  type Reference,
  type MutationRequest,
  type Planner,
  type MutationReader,
  type Readback,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
import type { NoFussCore } from "./core.js";
type Rule =
  | { kind: "availability"; value: "remaining" | "available" | "completed" }
  | { kind: "flagged" | "due" | "has_due" | "leaf" }
  | { kind: "search"; terms: string[] }
  | { kind: "tags"; match: "all" | "any"; tag_ids: string[] }
  | { kind: "focus"; project_ids: string[] }
  | { kind: "disabled"; rule: Rule }
  | { kind: "group"; aggregation: "all" | "any" | "none"; rules: Rule[] };
const Rule: z.ZodType<Rule> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("availability"),
        value: z.enum(["remaining", "available", "completed"]),
      })
      .strict(),
    z.object({ kind: z.literal("flagged") }).strict(),
    z.object({ kind: z.literal("due") }).strict(),
    z.object({ kind: z.literal("has_due") }).strict(),
    z.object({ kind: z.literal("leaf") }).strict(),
    z
      .object({
        kind: z.literal("search"),
        terms: z.array(z.string().min(1).max(256)).min(1).max(10),
      })
      .strict(),
    z.object({ kind: z.literal("disabled"), rule: Rule }).strict(),
    z
      .object({
        kind: z.literal("tags"),
        match: z.enum(["all", "any"]),
        tag_ids: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(10)
          .refine((x) => new Set(x).size === x.length),
      })
      .strict(),
    z
      .object({
        kind: z.literal("focus"),
        project_ids: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(10)
          .refine((x) => new Set(x).size === x.length),
      })
      .strict(),
    z
      .object({
        kind: z.literal("group"),
        aggregation: z.enum(["all", "any", "none"]),
        rules: z.array(Rule).min(1).max(10),
      })
      .strict(),
  ]),
);
const rules = z
    .array(Rule)
    .min(1)
    .max(10)
    .refine((rs) => {
      let count = 0;
      function check(r: Rule, d: number): boolean {
        return (
          ++count <= 50 &&
          d <= 4 &&
          (r.kind === "disabled"
            ? check(r.rule, d + 1)
            : r.kind !== "group" || r.rules.every((x) => check(x, d + 1)))
        );
      }
      return rs.every((r) => check(r, 0));
    }),
  id = z.string().min(1).max(256),
  aggregation = z.enum(["all", "any", "none"]),
  name = z.string().min(1).max(512),
  options = {
    entity: z.literal("perspective"),
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(10).default([]),
  };
const color = z
  .object({
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
    a: z.number().min(0).max(1),
  })
  .strict()
  .nullable()
  .transform((v) =>
    v
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, Math.fround(x)]),
        )
      : null,
  );
export const PerspectiveInputs = {
  "perspective.create": z
    .object({
      ...options,
      name,
      rules,
      aggregation,
      icon_color: color.optional(),
    })
    .strict(),
  "perspective.update": z
    .object({
      ...options,
      perspective_id: id,
      changes: z
        .object({
          name: name.optional(),
          rules: rules.optional(),
          aggregation: aggregation.optional(),
          icon_color: color.optional(),
        })
        .strict()
        .refine((x) => Object.keys(x).length > 0),
    })
    .strict(),
  "perspective.delete": z.object({ ...options, perspective_id: id }).strict(),
} as const;
type Scope = keyof typeof PerspectiveInputs;
type Snapshot = Record<string, Json>;
const receiptSchema = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    perspective_id: id.nullable(),
    rolled_back: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
function archive(r: Rule): Json {
  if (r.kind === "availability") return { actionAvailability: r.value };
  if (r.kind === "flagged" || r.kind === "due") return { actionStatus: r.kind };
  if (r.kind === "has_due") return { actionHasDueDate: true };
  if (r.kind === "leaf") return { actionIsLeaf: true };
  if (r.kind === "search") return { actionMatchingSearch: r.terms };
  if (r.kind === "tags")
    return {
      [r.match === "all" ? "actionHasAllOfTags" : "actionHasAnyOfTags"]:
        r.tag_ids,
    };
  if (r.kind === "focus") return { actionWithinFocus: r.project_ids };
  if (r.kind === "disabled") return { disabledRule: archive(r.rule) };
  if (r.kind === "group")
    return {
      aggregateType: r.aggregation,
      aggregateRules: r.rules.map(archive),
    };
  throw Error("unsupported rule");
}
export class PerspectiveWrites {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(reference: Reference) {
    const r = (await this.native.run("perspective_write_facts", {
      reference,
    })) as { reference: Reference; facts: Snapshot | null };
    if (canonical(r.reference) !== canonical(reference))
      throw Error("Perspective correlation");
    return r.facts;
  }
  async execute(scope: Scope, input: unknown) {
    const parsed = PerspectiveInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid typed perspective fields",
      );
    const args = parsed.data,
      create = scope === "perspective.create",
      del = scope === "perspective.delete";
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    const ref: Reference =
        "perspective_id" in args
          ? { entity: "perspective", id: args.perspective_id }
          : { entity: "perspective_inventory", id: "custom" },
      changes: Record<string, Json> = (
        "changes" in args
          ? args.changes
          : "name" in args
            ? {
                name: args.name,
                rules: args.rules,
                aggregation: args.aggregation,
                ...(args.icon_color !== undefined
                  ? { icon_color: args.icon_color }
                  : {}),
              }
            : {}
      ) as Record<string, Json>;
    const references: Reference[] = [];
    function collect(r: Rule) {
      if (r.kind === "tags")
        references.push(...r.tag_ids.map((id) => ({ entity: "tag", id })));
      else if (r.kind === "focus")
        references.push(
          ...r.project_ids.map((id) => ({ entity: "project", id })),
        );
      else if (r.kind === "group") r.rules.forEach(collect);
      else if (r.kind === "disabled") collect(r.rule);
    }
    if (changes.rules) (changes.rules as Rule[]).forEach(collect);
    const exactReferences = references.filter(
      (r, i) =>
        references.findIndex((x) => canonical(x) === canonical(r)) === i,
    );
    if (exactReferences.length > 20)
      throw new MutationError(
        "INVALID_MUTATION",
        "Perspective reference bound",
      );
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "perspective",
          targets: create ? [] : [ref],
          references: [...(create ? [ref] : []), ...exactReferences],
          changes,
          preconditions: args.preconditions,
          payload: null,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory),
      owned = (p: WritePolicy | null) =>
        !!p?.scopes.includes(scope) &&
        (create
          ? p.allow_perspective_creation
          : p.perspective_ids.includes(ref.id)) &&
        exactReferences.every((r) =>
          r.entity === "tag"
            ? p.tag_ids.includes(r.id)
            : p.project_ids.includes(r.id),
        );
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        if (args.apply && !owned(policy))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Exact perspective ownership/creation denied",
          );
        const baseline = resolved[0]!.facts.snapshot!;
        if (Buffer.byteLength(JSON.stringify(resolved)) > 16000)
          throw new MutationError(
            "INVALID_MUTATION",
            "Combined perspective snapshot bound",
          );
        return {
          item_key: item.item_key,
          preconditions: resolved.map((r) => ({
            reference: r.reference,
            field: "snapshot",
            expected: r.facts.snapshot!,
          })),
          predicted_changes: del ? { deleted_id: ref.id } : changes,
          payload: { baseline },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const s = await this.snapshot(reference);
        return s ? { reference, facts: { snapshot: s } } : null;
      },
      readFact: (f) => this.snapshot(f.reference),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = receiptSchema.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req)
        )
          throw Error("Receipt identity");
        const baseline = (plan.items[0]!.payload as { baseline: Snapshot })
          .baseline;
        if (receipt.setter_count === 0 && receipt.error) {
          await this.snapshot(ref);
          return {
            settled: true,
            not_attempted:
              receipt.error.code === "PRECONDITION_CONFLICT"
                ? "conflict"
                : "rejected",
            error: receipt.error,
            items: [
              {
                item_key: "perspective",
                all_postconditions: false,
                some_effects: false,
                evidence: ["Zero setter receipt and independent native facts."],
              },
            ],
          };
        }
        if (!create && receipt.perspective_id !== ref.id)
          throw Error("Exact perspective receipt resource mismatch");
        const identity = create ? receipt.perspective_id : ref.id;
        if (!identity) throw Error("Unknown constructor identity");
        const resource = { entity: "perspective", id: identity },
          current = await this.snapshot(resource);
        const publicRead = await this.core.get({
          entity: "perspective",
          ids: [identity],
          fields:
            del || receipt.rolled_back
              ? []
              : ["name", "rule_archive", "rule_aggregation", "icon_color"],
        });
        if (
          publicRead.results[0]?.error &&
          publicRead.results[0]?.error?.code !== "NOT_FOUND"
        )
          throw Error("Independent perspective read failed");
        const row = publicRead.results[0]?.perspective;
        if (row?.unavailable || row?.truncated)
          throw Error("Independent perspective projection incomplete");
        if ((current === null) !== !row)
          throw Error("Independent perspective identities disagree");
        if (receipt.rolled_back && current !== null)
          throw Error("Independent rollback absence not established");
        const someEffects = create
          ? (current !== null &&
              !(baseline.ids as string[]).includes(identity)) ||
            (receipt.rolled_back && current === null)
          : current === null || canonical(current) !== canonical(baseline);
        const referencesPreserved = await Promise.all(
          exactReferences.map(async (r) => {
            const pre = plan.items[0]!.preconditions.find(
              (f) => canonical(f.reference) === canonical(r),
            );
            return (
              canonical(await this.snapshot(r)) === canonical(pre?.expected)
            );
          }),
        );
        let pass = false;
        if (del)
          pass =
            current === null &&
            publicRead.results[0]?.error?.code === "NOT_FOUND";
        else if (!receipt.rolled_back && current) {
          const expected: Snapshot = {
            ...(create ? { id: identity, icon_color: null } : baseline),
            ...("icon_color" in changes
              ? { icon_color: changes.icon_color }
              : {}),
            ...("name" in changes ? { name: changes.name } : {}),
            ...("rules" in changes
              ? { rules: (changes.rules as Rule[]).map(archive) }
              : {}),
            ...("aggregation" in changes
              ? { aggregation: changes.aggregation }
              : {}),
          };
          pass =
            canonical(current) === canonical(expected) &&
            !!row &&
            !row.unavailable &&
            !row.truncated &&
            row.name === expected.name &&
            canonical(row.rule_archive?.rules) === canonical(expected.rules) &&
            row.rule_aggregation === expected.aggregation &&
            canonical(row.icon_color) === canonical(expected.icon_color);
          if (create) {
            const inventory = await this.snapshot(ref);
            pass =
              pass &&
              canonical(inventory?.ids) ===
                canonical([...(baseline.ids as string[]), identity].sort());
          }
        }
        return {
          settled: true,
          items: [
            {
              item_key: "perspective",
              resource,
              all_postconditions: pass && referencesPreserved.every(Boolean),
              some_effects: someEffects,
              evidence: [
                "Returned persistent constructor identity; independent exact native and public rule/archive readback.",
              ],
            },
          ],
          ...(receipt.error ? { error: receipt.error } : {}),
        };
      },
    };
    const boundary = new MutationBoundary(
      planner,
      reader,
      {
        apply: async (req, plan, record) => {
          const p = await readWritePolicy(this.directory);
          if (!owned(p)) {
            await record({
              request_key: req.request_key!,
              input_hash: inputHash(req),
              finished: true,
              setter_count: 0,
              perspective_id: null,
              rolled_back: false,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Perspective authority revoked",
              },
            });
            return;
          }
          const r = await this.native.run("perspective_write_apply", {
            request: req,
            plan,
            input_hash: inputHash(req),
            policy: p,
          });
          await record(receiptSchema.parse(r));
        },
      },
      new MutationJournal(this.directory),
      {
        mode: args.apply
          ? owned(policy)
            ? "apply-authorized"
            : "read-only"
          : "preview-authorized",
      },
    );
    if (args.apply) return boundary.apply(request);
    const preview = await boundary.preview(request);
    return {
      mode: "preview",
      operation: scope,
      ...preview,
      apply_input: {
        ...args,
        preconditions: preview.plan.items[0]!.preconditions,
      },
    };
  }
}
