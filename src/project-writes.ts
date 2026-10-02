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
const id = z.string().min(1).max(256);
const timestamp = z
  .string()
  .datetime()
  .transform((v) => new Date(v).toISOString())
  .nullable();
const changes = z
  .object({
    name: z.string().min(1).max(512).optional(),
    note: z.string().max(2048).optional(),
    flagged: z.boolean().optional(),
    tag_ids: z
      .array(id)
      .max(20)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    due_at: timestamp.optional(),
    defer_at: timestamp.optional(),
    planned_at: timestamp.optional(),
    type: z.enum(["parallel", "sequential", "single_actions"]).optional(),
    status: z.enum(["active", "on_hold"]).optional(),
  })
  .strict();
const options = {
  entity: z.literal("project"),
  apply: z.boolean().default(false),
  request_key: id.optional(),
  preconditions: z.array(Fact).max(100).default([]),
};
export const ProjectCreateInput = z
  .object({
    ...options,
    ...changes.shape,
    name: z.string().min(1).max(512),
    folder_id: id.nullable().default(null),
  })
  .strict();
export const ProjectUpdateInput = z
  .object({ ...options, project_id: id, changes })
  .strict();
export const ProjectTransitionInput = z
  .object({ ...options, project_id: id })
  .strict();
export const ProjectMoveInput = z
  .object({ ...options, project_id: id, folder_id: id.nullable() })
  .strict();
const CalendarReviewInterval = z
  .object({
    unit: z.enum(["days", "weeks", "months", "years"]),
    steps: z.number().int().positive().max(1000),
    fixed: z.boolean(),
  })
  .strict();
export const ProjectSetReviewIntervalInput = z
  .object({
    ...options,
    project_id: id,
    action: z.literal("set_interval"),
    review_interval: CalendarReviewInterval,
  })
  .strict();
export const ProjectMarkReviewedInput = z
  .object({ ...options, project_id: id, action: z.literal("mark_reviewed") })
  .strict();
export const ProjectInputs = {
  "project.create": ProjectCreateInput,
  "project.update": ProjectUpdateInput,
  "project.complete": ProjectTransitionInput,
  "project.drop": ProjectTransitionInput,
  "project.move": ProjectMoveInput,
  "project.set_review_interval": ProjectSetReviewIntervalInput,
  "project.mark_reviewed": ProjectMarkReviewedInput,
} as const;
type Snapshot = Record<string, Json>;
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    project_id: id.nullable(),
    reviewed_at: z.string().datetime().optional(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class ProjectWrites {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(
    reference: Reference,
    review = false,
  ): Promise<Snapshot | null> {
    const r = (await this.native.run("project_write_facts", {
      reference,
      ...(review ? { review_interval: true } : {}),
    })) as {
      reference: Reference;
      facts: Snapshot | null;
    };
    if (
      canonical(r.reference) !== canonical(reference) ||
      (r.facts && (r.facts.id !== reference.id || r.facts.exists !== true))
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Native project reference mismatch.",
      );
    return r.facts;
  }
  async execute(scope: keyof typeof ProjectInputs, input: unknown) {
    const parsed = ProjectInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid project fields or write options.",
      );
    const args = parsed.data;
    const review = [
      "project.set_review_interval",
      "project.mark_reviewed",
    ].includes(scope);
    if (args.apply && !args.request_key)
      throw new MutationError(
        "INVALID_MUTATION",
        "Apply requires caller request_key.",
      );
    if (args.preconditions.some((f) => f.field !== "snapshot"))
      throw new MutationError(
        "INVALID_MUTATION",
        "Complete native snapshots are required.",
      );
    const wanted = (
      scope === "project.create"
        ? Object.fromEntries(
            Object.entries(args).filter(([key]) =>
              Object.hasOwn(changes.shape, key),
            ),
          )
        : "changes" in args
          ? args.changes
          : "review_interval" in args
            ? { review_interval: args.review_interval }
            : {}
    ) as Record<string, Json>;
    if (scope === "project.update" && !Object.keys(wanted).length)
      throw new MutationError(
        "INVALID_MUTATION",
        "Update requires a supported field.",
      );
    const refs: Reference[] = (
      "folder_id" in args && args.folder_id
        ? [{ entity: "folder", id: args.folder_id }]
        : []
    ).concat(
      ((wanted.tag_ids as string[] | undefined) ?? []).map((id) => ({
        entity: "tag",
        id,
      })),
    );
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "project",
          targets:
            "project_id" in args
              ? [{ entity: "project", id: args.project_id }]
              : [],
          references: refs,
          changes: wanted,
          preconditions: args.preconditions,
          payload: "folder_id" in args ? { folder_id: args.folder_id } : null,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    const authorized = (p: WritePolicy | null) =>
      !!p?.scopes.includes(scope) &&
      (scope === "project.create"
        ? p.allow_project_creation
        : "project_id" in args && p.project_ids.includes(args.project_id)) &&
      (!("folder_id" in args) ||
        args.folder_id === null ||
        p.folder_ids.includes(args.folder_id));
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        if (args.apply && !authorized(policy))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Host policy denies project or destination.",
          );
        const target = (resolved.find((r) => r.reference.entity === "project")
          ?.facts.snapshot ?? null) as Snapshot | null;
        if (target) {
          if (
            scope === "project.update" &&
            "note" in wanted &&
            target.note_plain_safe !== true
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Plain note replacement would discard rich or unsupported content.",
            );
          if (target.repeating === true)
            throw new MutationError(
              "INVALID_MUTATION",
              "Repeating projects are outside this lifecycle contract.",
            );
          if (
            ["project.complete", "project.drop"].includes(scope) &&
            !["active", "on_hold"].includes(target.status as string)
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Transition requires unfinished project.",
            );
          if (
            "status" in wanted &&
            !["active", "on_hold"].includes(target.status as string)
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Only reversible active/on-hold status transitions are supported.",
            );
        }
        if (review) {
          if (
            !target ||
            !["active", "on_hold"].includes(target.status as string)
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Review requires an unfinished non-repeating project.",
            );
          const interval = target.review_interval as Snapshot;
          if (
            !interval ||
            (scope === "project.mark_reviewed" &&
              !["days", "weeks", "months", "years"].includes(
                interval.unit as string,
              ))
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Sub-day review scheduling is outside the verified calendar contract.",
            );
        }
        const folder = resolved.find((r) => r.reference.entity === "folder")
          ?.facts.snapshot as Snapshot | undefined;
        if (folder && folder.effective_active !== true)
          throw new MutationError(
            "INVALID_MUTATION",
            "Destination folder must be effectively active.",
          );
        if ("planned_at" in wanted && target?.planned_supported === false)
          throw new MutationError(
            "INVALID_MUTATION",
            "Planned date unavailable.",
          );
        const due = "due_at" in wanted ? wanted.due_at : target?.due_at;
        const defer = "defer_at" in wanted ? wanted.defer_at : target?.defer_at;
        if (
          ("due_at" in wanted || "defer_at" in wanted) &&
          typeof due === "string" &&
          typeof defer === "string" &&
          Date.parse(defer) > Date.parse(due)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Defer must not follow due.",
          );
        if (
          target &&
          ((typeof target.name === "string" && target.name.length > 512) ||
            (typeof target.note === "string" && target.note.length > 2048) ||
            (Array.isArray(target.tag_ids) && target.tag_ids.length > 20))
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Project exceeds independent verification bounds.",
          );
        const exclusive: string[] = [];
        for (const r of resolved.filter((r) => r.reference.entity === "tag"))
          for (const group of (r.facts.snapshot as Snapshot)
            .exclusive_ancestors as string[]) {
            if (exclusive.includes(group))
              throw new MutationError(
                "INVALID_MUTATION",
                "Mutually exclusive tags are unsupported.",
              );
            exclusive.push(group);
          }
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
            baseline: target,
            folder_id:
              "folder_id" in args
                ? args.folder_id
                : (target?.folder_id ?? null),
          },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const snapshot = await this.snapshot(reference, review);
        return snapshot ? { reference, facts: { snapshot } } : null;
      },
      readFact: (fact) => this.snapshot(fact.reference, review),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = Receipt.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req)
        )
          throw Error("Unusable dispatch identity.");
        const targetId =
          receipt.project_id ?? ("project_id" in args ? args.project_id : null);
        if (
          scope !== "project.create" &&
          "project_id" in args &&
          targetId !== args.project_id
        )
          throw Error("Project receipt differs from exact requested target");
        if (receipt.setter_count === 0 && receipt.error) {
          if (targetId)
            await this.snapshot({ entity: "project", id: targetId }, review);
          else for (const ref of refs) await this.snapshot(ref, review);
          return {
            settled: true,
            not_attempted:
              receipt.error.code === "PRECONDITION_CONFLICT"
                ? "conflict"
                : "rejected",
            error: receipt.error,
            items: [
              {
                item_key: "project",
                all_postconditions: false,
                some_effects: false,
                evidence: [
                  "Zero setters acknowledged; independent reference reads completed.",
                ],
              },
            ],
          };
        }
        if (!targetId)
          throw Error("Constructor identity absent; never search by name.");
        const after = await this.snapshot(
          { entity: "project", id: targetId },
          review,
        );
        if (!after) throw Error("Exact project disappeared.");
        const fields = [
          "name",
          "note",
          "flagged",
          "tag_ids",
          "folder_id",
          "status",
          "type",
          "due_at",
          "defer_at",
          "completed_at",
          ...(after.planned_supported ? ["planned_at"] : []),
          ...(review
            ? ["review_interval", "last_review_at", "next_review_at"]
            : []),
        ] as const;
        const observed = await this.core.get({
          entity: "project",
          ids: [targetId],
          fields,
        });
        const row = observed.results[0]?.project as
          | Record<string, unknown>
          | undefined;
        if (!row || row.unavailable || row.truncated)
          throw Error("Independent project read incomplete.");
        for (const field of fields) {
          const value =
            field === "tag_ids"
              ? [...(row[field] as string[])].sort()
              : row[field];
          if (
            canonical(value) !==
            canonical(
              ["last_review_at", "next_review_at"].includes(field)
                ? (after.preserved as Snapshot)[field]
                : after[field],
            )
          )
            throw Error("Independent project paths disagree: " + field);
        }
        const payload = plan.items[0]!.payload as {
          baseline: Snapshot | null;
          folder_id: Json;
        };
        const baseline = payload.baseline;
        const expected = Object.entries(wanted).map(
          ([k, v]) =>
            canonical(after[k]) ===
            canonical(k === "tag_ids" ? [...(v as string[])].sort() : v),
        );
        expected.push(after.folder_id === payload.folder_id);
        if (scope === "project.complete")
          expected.push(
            after.status === "done",
            typeof after.completed_at === "string",
          );
        if (scope === "project.drop")
          expected.push(
            after.status === "dropped",
            typeof after.dropped_at === "string",
          );
        if (scope === "project.mark_reviewed") {
          const preserved = after.preserved as Snapshot;
          expected.push(
            preserved.last_review_at === receipt.reviewed_at,
            typeof preserved.next_review_at === "string" &&
              Date.parse(preserved.next_review_at) >
                Date.parse(receipt.reviewed_at!),
            canonical(after.review_interval) ===
              canonical(baseline!.review_interval),
          );
        }
        if (baseline) {
          for (const field of [
            "name",
            "note",
            "flagged",
            "tag_ids",
            "due_at",
            "defer_at",
            "planned_at",
            "type",
            "status",
            "completed_at",
            "dropped_at",
            "preserved",
          ]) {
            if (
              field in wanted ||
              (["project.complete", "project.drop"].includes(scope) &&
                ["status", "completed_at", "dropped_at"].includes(field))
            )
              continue;
            if (field === "preserved" && review) {
              const omit =
                scope === "project.mark_reviewed"
                  ? ["last_review_at", "next_review_at"]
                  : ["next_review_at"];
              const retained = (v: Json) =>
                Object.fromEntries(
                  Object.entries(v as Snapshot).filter(
                    ([k]) => !omit.includes(k),
                  ),
                );
              expected.push(
                canonical(retained(after.preserved!)) ===
                  canonical(retained(baseline.preserved!)),
              );
            } else
              expected.push(
                canonical(after[field]) === canonical(baseline[field]),
              );
          }
          if (
            !(
              after.due_at === null &&
              after.defer_at === null &&
              ("due_at" in wanted || "defer_at" in wanted)
            )
          )
            expected.push(after.floating === baseline.floating);
        }
        return {
          settled: true,
          items: [
            {
              item_key: "project",
              resource: { entity: "project", id: targetId },
              all_postconditions: expected.every(Boolean),
              some_effects:
                baseline === null || canonical(after) !== canonical(baseline),
              evidence: [
                "Separate native facts and public exact-project read agree; dispatch acknowledgement is not final-state proof.",
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
              project_id: null,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Authorization revoked before dispatch.",
              },
            });
            return;
          }
          const result = await this.native.run("project_write_apply", {
            request: req,
            plan,
            input_hash: inputHash(req),
            authorized_project_ids: current!.project_ids,
            authorized_folder_ids: current!.folder_ids,
            allow_project_creation: current!.allow_project_creation,
            review_interval: review,
          });
          await recordReceipt(Receipt.parse(result));
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
