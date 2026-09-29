import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  MutationError,
  canonical,
  Fact,
  Reference,
  inputHash,
  type Json,
  type MutationRequest,
  type MutationReader,
  type Planner,
  type Readback,
} from "./mutation-contract.js";
import { readWritePolicy, type WriteScope } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
import type { NoFussCore } from "./core.js";
const id = z.string().min(1).max(256);
const changes = z
  .object({
    name: z.string().min(1).max(512).optional(),
    note: z.string().max(2048).optional(),
    flagged: z.boolean().optional(),
    tag_ids: z
      .array(id)
      .max(20)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Duplicate tags reject.",
      )
      .optional(),
  })
  .strict();
const options = {
  entity: z.literal("task").default("task"),
  apply: z.boolean().default(false),
  request_key: id.optional(),
  preconditions: z.array(Fact).max(100).default([]),
};
export const TaskCreateInput = z
  .object({
    ...options,
    project_id: id,
    ...changes.shape,
    name: z.string().min(1).max(512),
  })
  .strict();
export const TaskUpdateInput = z
  .object({ ...options, task_id: id, changes })
  .strict();
export const TaskCompleteInput = z.object({ ...options, task_id: id }).strict();
export const TaskInputs = {
  "task.create": TaskCreateInput,
  "task.update": TaskUpdateInput,
  "task.complete": TaskCompleteInput,
} as const;
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    task_id: id.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
type Snapshot = Record<string, Json>;
export class TaskWrites {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(reference: Reference): Promise<Snapshot | null> {
    const result = (await this.native.run("task_write_facts", {
      reference,
    })) as { reference: Reference; facts: Snapshot | null };
    if (canonical(result.reference) !== canonical(reference))
      throw new MutationError("INVALID_MUTATION", "Native reference mismatch.");
    if (
      result.facts &&
      (result.facts.id !== reference.id || result.facts.exists !== true)
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Native fact identity mismatch.",
      );
    return result.facts;
  }
  async execute(scope: WriteScope, input: unknown) {
    const parsed = TaskInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid task fields, references or write options.",
      );
    const args = parsed.data;
    if (args.apply && !args.request_key)
      throw new MutationError(
        "INVALID_MUTATION",
        "Apply requires a caller-supplied request_key.",
      );
    if (args.preconditions.some((f) => f.field !== "snapshot"))
      throw new MutationError(
        "INVALID_MUTATION",
        "Task preconditions must be complete native snapshots.",
      );
    const itemChanges: Record<string, Json> = (
      scope === "task.create"
        ? Object.fromEntries(
            Object.entries(args).filter(([key]) =>
              ["name", "note", "flagged", "tag_ids"].includes(key),
            ),
          )
        : "changes" in args
          ? args.changes
          : {}
    ) as Record<string, Json>;
    if (scope === "task.update" && !Object.keys(itemChanges).length)
      throw new MutationError(
        "INVALID_MUTATION",
        "Update must specify at least one supported field.",
      );
    const refs: Reference[] = (
      "project_id" in args ? [{ entity: "project", id: args.project_id }] : []
    ).concat(
      ((itemChanges.tag_ids ?? []) as string[]).map((id) => ({
        entity: "tag",
        id,
      })),
    );
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "task",
          targets:
            "task_id" in args ? [{ entity: "task", id: args.task_id }] : [],
          references: refs,
          changes: itemChanges as Record<string, Json>,
          preconditions: args.preconditions,
          payload:
            "project_id" in args ? { project_id: args.project_id } : null,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    const scopeAllowed = !!policy?.scopes.includes(scope);
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        const target = resolved.find(
          (r) =>
            r.reference.entity ===
            (scope === "task.create" ? "project" : "task"),
        )!.facts.snapshot as Snapshot;
        const projectId = (
          scope === "task.create" ? target.id : target.project_id
        ) as string;
        if (
          args.apply &&
          (!scopeAllowed || !policy!.project_ids.includes(projectId))
        )
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Host policy denies this operation/project.",
          );
        if (scope === "task.create" ? !target.active : !target.project_active)
          throw new MutationError(
            "INVALID_MUTATION",
            "An active containing project is required.",
          );
        if (scope === "task.complete") {
          if (target.repeating || target.ancestor_repeating)
            throw new MutationError(
              "REPEATING_COMPLETION_UNSUPPORTED",
              "Repeating task or ancestor completion is unsupported.",
            );
          if (
            target.completed ||
            target.effective_completed ||
            target.dropped ||
            target.has_children ||
            target.ancestor_auto_complete
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Complete requires an unfinished ordinary leaf without automatic ancestor completion.",
            );
        }
        // Independent public readback must be able to return every compared field.
        if (
          scope !== "task.create" &&
          ((typeof target.name === "string" &&
            target.name.length > 512 &&
            !("name" in item.changes)) ||
            (typeof target.note === "string" &&
              target.note.length > 2048 &&
              !("note" in item.changes)) ||
            (Array.isArray(target.tag_ids) &&
              target.tag_ids.length > 20 &&
              !("tag_ids" in item.changes)))
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Preserved fields exceed the initial write verification bounds.",
          );
        const groups: string[] = [];
        for (const r of resolved.filter((r) => r.reference.entity === "tag"))
          for (const group of (r.facts.snapshot as Snapshot)
            .exclusive_ancestors as string[]) {
            if (groups.includes(group))
              throw new MutationError(
                "INVALID_MUTATION",
                "Mutually exclusive tag membership is unsupported.",
              );
            groups.push(group);
          }
        return {
          item_key: item.item_key,
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
          predicted_changes: item.changes,
          payload: { project_id: projectId, baseline: target },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const snapshot = await this.snapshot(reference);
        return snapshot ? { reference, facts: { snapshot } } : null;
      },
      readFact: async (fact) => this.snapshot(fact.reference),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = Receipt.safeParse(raw);
        if (
          !receipt.success ||
          receipt.data.request_key !== req.request_key ||
          receipt.data.input_hash !== inputHash(req)
        )
          throw new Error("No independently usable dispatch identity.");
        const r = receipt.data;
        const targetId = r.task_id ?? ("task_id" in args ? args.task_id : null);
        const reference: Reference = targetId
          ? { entity: "task", id: targetId }
          : refs[0]!;
        const after = await this.snapshot(reference); // NEW evaluation after fixed synchronous dispatch.
        if (r.setter_count === 0 && r.error) {
          return {
            settled: true,
            not_attempted:
              r.error.code === "PRECONDITION_CONFLICT"
                ? "conflict"
                : "rejected",
            error: r.error,
            items: [
              {
                item_key: "task",
                all_postconditions: false,
                some_effects: false,
                evidence: [
                  "Native validation acknowledged zero setters; separate exact-fact evaluation completed.",
                ],
              },
            ],
          };
        }
        if (!targetId || !after)
          throw new Error(
            "Created identity/state unavailable; never search by name.",
          );
        // Reuse established public/native read mapping as a second independent path.
        const observed = await this.core.get({
          ids: [targetId],
          fields: [
            "name",
            "note",
            "flagged",
            "tag_ids",
            "project_id",
            "parent_id",
            "completed",
            "effective_completed",
            "completed_at",
          ],
        });
        const row = observed.results[0]?.task;
        if (!row || row.unavailable || row.truncated)
          throw new Error("Independent read incomplete.");
        for (const field of [
          "name",
          "note",
          "flagged",
          "project_id",
          "parent_id",
          "completed",
          "effective_completed",
          "completed_at",
        ] as const)
          if (canonical(row[field]) !== canonical(after[field]))
            throw new Error("Independent paths disagree.");
        if (
          canonical([...(row.tag_ids ?? [])].sort()) !==
          canonical(after.tag_ids)
        )
          throw new Error("Independent tags disagree.");
        const wanted = req.items[0]!.changes;
        const expected = Object.entries(wanted).map(
          ([key, value]) =>
            canonical(after[key]) ===
            canonical(
              key === "tag_ids" ? [...(value as string[])].sort() : value,
            ),
        );
        const payload = plan.items[0]!.payload as {
          project_id: string;
          baseline: Snapshot;
        };
        expected.push(after.project_id === payload.project_id);
        if (scope === "task.complete")
          expected.push(
            after.completed === true,
            after.effective_completed === true,
            typeof after.completed_at === "string",
          );
        else
          expected.push(
            after.completed === payload.baseline.completed ||
              scope === "task.create",
          );
        if (scope !== "task.create") {
          for (const field of [
            "name",
            "note",
            "flagged",
            "tag_ids",
            "parent_id",
            "preserved",
            "repeating",
            "ancestor_repeating",
          ])
            if (!(field in wanted))
              expected.push(
                canonical(after[field]) === canonical(payload.baseline[field]),
              );
        }
        return {
          settled: true,
          items: [
            {
              item_key: "task",
              resource: { entity: "task", id: targetId },
              all_postconditions: expected.every(Boolean),
              some_effects:
                scope === "task.create" ||
                (scope === "task.complete"
                  ? after.completed === true
                  : Object.entries(wanted).some(
                      ([key, value]) =>
                        canonical(after[key]) ===
                          canonical(
                            key === "tag_ids"
                              ? [...(value as string[])].sort()
                              : value,
                          ) &&
                        canonical(after[key]) !==
                          canonical(payload.baseline[key]),
                    )),
              evidence: [
                "Separate native facts and core exact-ID read agree after acknowledged synchronous evaluation.",
                ...(r.error
                  ? [
                      "Native apply reported an error; outcome uses independent state only.",
                    ]
                  : []),
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
          const projectId = (plan.items[0]!.payload as { project_id: string })
            .project_id;
          if (
            !current?.scopes.includes(scope) ||
            !current.project_ids.includes(projectId)
          ) {
            await recordReceipt({
              request_key: req.request_key!,
              input_hash: inputHash(req),
              finished: true,
              setter_count: 0,
              task_id: null,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Host authorization revoked before dispatch.",
              },
            });
            return;
          }
          const result = await this.native.run("task_write_apply", {
            request: req,
            plan,
            input_hash: inputHash(req),
            authorized_project_ids: current.project_ids,
          });
          await recordReceipt(Receipt.parse(result));
        },
      },
      new MutationJournal(this.directory),
      {
        mode: args.apply
          ? scopeAllowed
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
