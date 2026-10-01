import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  MutationError,
  canonical,
  Fact,
  inputHash,
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
const id = z.string().min(1).max(256),
  name = z.string().min(1).max(512),
  status = z.enum(["active", "on_hold", "dropped"]);
const options = {
  apply: z.boolean().default(false),
  request_key: id.optional(),
  preconditions: z.array(Fact).max(100).default([]),
};
const tagCreate = z
  .object({
    ...options,
    entity: z.literal("tag"),
    name,
    parent_id: id.nullable().default(null),
    status: status.optional(),
  })
  .strict();
const folderCreate = z
  .object({
    ...options,
    entity: z.literal("folder"),
    name,
    parent_id: id.nullable().default(null),
  })
  .strict();
const tagUpdate = z
  .object({
    ...options,
    entity: z.literal("tag"),
    tag_id: id,
    changes: z
      .object({ name: name.optional(), status: status.optional() })
      .strict(),
  })
  .strict();
const folderUpdate = z
  .object({
    ...options,
    entity: z.literal("folder"),
    folder_id: id,
    changes: z.object({ name: name.optional() }).strict(),
  })
  .strict();
const tagMove = z
  .object({
    ...options,
    entity: z.literal("tag"),
    tag_id: id,
    parent_id: id.nullable(),
  })
  .strict();
const folderMove = z
  .object({
    ...options,
    entity: z.literal("folder"),
    folder_id: id,
    parent_id: id.nullable(),
  })
  .strict();
export const TaxonomyInputs = {
  "tag.create": tagCreate,
  "tag.update": tagUpdate,
  "tag.move": tagMove,
  "folder.create": folderCreate,
  "folder.update": folderUpdate,
  "folder.move": folderMove,
} as const;
type Scope = keyof typeof TaxonomyInputs;
type Snapshot = Record<string, Json>;
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    resource_id: id.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class TaxonomyWrites {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(reference: Reference): Promise<Snapshot | null> {
    const r = (await this.native.run("taxonomy_write_facts", {
      reference,
    })) as { reference: Reference; facts: Snapshot | null };
    if (
      canonical(r.reference) !== canonical(reference) ||
      (r.facts && (r.facts.id !== reference.id || r.facts.exists !== true))
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Native taxonomy reference mismatch",
      );
    return r.facts;
  }
  async execute(scope: Scope, input: unknown) {
    const parsed = TaxonomyInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError("INVALID_MUTATION", "Invalid taxonomy fields");
    const args = parsed.data,
      entity = args.entity,
      create = scope.endsWith(".create"),
      move = scope.endsWith(".move");
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    if (args.preconditions.some((f) => f.field !== "snapshot"))
      throw new MutationError(
        "INVALID_MUTATION",
        "Complete native snapshot preconditions required",
      );
    const targetId =
      "tag_id" in args
        ? args.tag_id
        : "folder_id" in args
          ? args.folder_id
          : null;
    const wanted = (
      create
        ? Object.fromEntries(
            Object.entries(args).filter(([k]) =>
              ["name", "status"].includes(k),
            ),
          )
        : "changes" in args
          ? args.changes
          : {}
    ) as Record<string, Json>;
    if (!create && !move && !Object.keys(wanted).length)
      throw new MutationError(
        "INVALID_MUTATION",
        "Update requires a supported field",
      );
    const parent = "parent_id" in args ? args.parent_id : undefined;
    const refs: Reference[] =
      typeof parent === "string" ? [{ entity, id: parent }] : [];
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: entity,
          targets: targetId ? [{ entity, id: targetId }] : [],
          references: refs,
          changes: wanted,
          preconditions: args.preconditions,
          payload: parent === undefined ? null : { parent_id: parent },
        },
      ],
    };
    const authorized = (p: WritePolicy | null) =>
      !!p?.scopes.includes(scope) &&
      (create
        ? entity === "tag"
          ? p.allow_tag_creation
          : p.allow_folder_creation
        : (entity === "tag" ? p.tag_ids : p.folder_ids).includes(targetId!)) &&
      (typeof parent !== "string" ||
        (entity === "tag" ? p.tag_ids : p.folder_ids).includes(parent));
    const policy = await readWritePolicy(this.directory);
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        if (args.apply && !authorized(policy))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Host denies taxonomy object/parent",
          );
        const baseline = (resolved.find((r) => r.reference.id === targetId)
          ?.facts.snapshot ?? null) as Snapshot | null;
        const destination = (resolved.find((r) => r.reference.id === parent)
          ?.facts.snapshot ?? null) as Snapshot | null;
        if (destination?.effective_active !== true && destination)
          throw new MutationError(
            "INVALID_MUTATION",
            "Parent must be effectively active",
          );
        if (
          move &&
          (parent === targetId ||
            (Array.isArray(destination?.ancestor_ids) &&
              destination!.ancestor_ids.includes(targetId!)))
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Self/descendant hierarchy cycles reject",
          );
        if (
          entity === "tag" &&
          ((baseline?.exclusive_ancestors as Json[] | undefined)?.length ||
            (destination?.exclusive_ancestors as Json[] | undefined)?.length ||
            destination?.children_exclusive === true)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Moves/edits across mutually exclusive tag ancestry are unsupported",
          );
        if (
          baseline &&
          typeof baseline.name === "string" &&
          baseline.name.length > 512
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Name exceeds independent readback bounds",
          );
        return {
          item_key: item.item_key,
          predicted_changes: item.changes,
          preconditions: resolved
            .filter(
              (r) =>
                !item.preconditions.some(
                  (f) => canonical(f.reference) === canonical(r.reference),
                ),
            )
            .map((r) => ({
              reference: r.reference,
              field: "snapshot",
              expected: r.facts.snapshot!,
            })),
          payload: {
            baseline,
            parent_id:
              parent === undefined ? (baseline?.parent_id ?? null) : parent,
          },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const snapshot = await this.snapshot(reference);
        return snapshot ? { reference, facts: { snapshot } } : null;
      },
      readFact: (fact) => this.snapshot(fact.reference),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = Receipt.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req)
        )
          throw Error("Dispatch identity mismatch");
        const rid = receipt.resource_id ?? targetId;
        if (receipt.setter_count === 0 && receipt.error) {
          for (const ref of req.items[0]!.targets.concat(refs))
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
                item_key: entity,
                all_postconditions: false,
                some_effects: false,
                evidence: [
                  "Zero setters acknowledged; separate native references read",
                ],
              },
            ],
          };
        }
        if (!rid) throw Error("Constructor identity unavailable");
        const after = await this.snapshot({ entity, id: rid });
        if (!after) throw Error("Exact taxonomy object disappeared");
        const observed = await this.core.get({
          entity,
          ids: [rid],
          fields: ["name", "parent_id", "status", "active", "effective_active"],
        });
        const row = observed.results[0]?.[entity] as
          | Record<string, unknown>
          | undefined;
        if (!row || row.unavailable || row.truncated)
          throw Error("Independent taxonomy read incomplete");
        for (const field of [
          "name",
          "parent_id",
          "status",
          "active",
          "effective_active",
        ])
          if (canonical(row[field]) !== canonical(after[field]))
            throw Error("Independent taxonomy paths disagree");
        const payload = plan.items[0]!.payload as {
          baseline: Snapshot | null;
          parent_id: Json;
        };
        const baseline = payload.baseline;
        const expected = Object.entries(wanted).map(
          ([k, v]) => canonical(after[k]) === canonical(v),
        );
        expected.push(after.parent_id === payload.parent_id);
        if (baseline)
          for (const field of ["name", "status", "preserved"])
            if (!(field in wanted))
              expected.push(
                canonical(after[field]) === canonical(baseline[field]),
              );
        return {
          settled: true,
          items: [
            {
              item_key: entity,
              resource: { entity, id: rid },
              all_postconditions: expected.every(Boolean),
              some_effects:
                baseline === null || canonical(after) !== canonical(baseline),
              evidence: [
                "Separate native facts and public exact-ID taxonomy reads agree",
              ],
            },
          ],
        };
      },
    };
    const boundary = new MutationBoundary(
      planner,
      reader,
      {
        apply: async (req, plan, recordReceipt) => {
          const current = await readWritePolicy(this.directory);
          if (!authorized(current)) {
            await recordReceipt({
              request_key: req.request_key!,
              input_hash: inputHash(req),
              finished: true,
              setter_count: 0,
              resource_id: null,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Authorization revoked",
              },
            });
            return;
          }
          await recordReceipt(
            Receipt.parse(
              await this.native.run("taxonomy_write_apply", {
                request: req,
                plan,
                input_hash: inputHash(req),
                authorized_tag_ids: current!.tag_ids,
                authorized_folder_ids: current!.folder_ids,
                allow_tag_creation: current!.allow_tag_creation,
                allow_folder_creation: current!.allow_folder_creation,
              }),
            ),
          );
        },
      },
      new MutationJournal(this.directory),
      {
        mode: args.apply
          ? authorized(policy)
            ? "apply-authorized"
            : "read-only"
          : "preview-authorized",
      },
    );
    if (args.apply) return boundary.apply(request);
    const preview = await boundary.preview(request);
    const applyInput = {
      ...args,
      preconditions: preview.plan.items[0]!.preconditions,
    };
    return {
      mode: "preview" as const,
      operation: scope,
      ...preview,
      apply_input: applyInput,
      apply_input_hash: inputHash({
        ...request,
        items: [
          { ...request.items[0]!, preconditions: applyInput.preconditions },
        ],
      }),
    };
  }
}
