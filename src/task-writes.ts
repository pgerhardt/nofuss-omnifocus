import { z } from "zod";
import { Recurrence, NotificationWrite } from "./contract.js";
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
  type MutationWriter,
} from "./mutation-contract.js";
import { readWritePolicy } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
import type { NoFussCore } from "./core.js";
const id = z.string().min(1).max(256);
const timestamp = z
  .string()
  .datetime()
  .transform((value) => new Date(value).toISOString())
  .nullable();
const scheduling = [
  "due_at",
  "defer_at",
  "planned_at",
  "estimated_minutes",
] as const;
export const TaskScalarChanges = z
  .object({
    due_at: timestamp.optional(),
    defer_at: timestamp.optional(),
    planned_at: timestamp.optional(),
    estimated_minutes: z.number().int().nonnegative().nullable().optional(),
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
export const TaskCreateShape = z
  .object({
    ...options,
    project_id: id.optional(),
    destination: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("inbox") }).strict(),
        z.object({ kind: z.literal("parent"), task_id: id }).strict(),
      ])
      .optional(),
    ...TaskScalarChanges.shape,
    name: z.string().min(1).max(512),
  })
  .strict();
export const validCreateDestination = (args: {
  project_id?: string;
  destination?: unknown;
}) =>
  (args.project_id !== undefined ? 1 : 0) +
    (args.destination !== undefined ? 1 : 0) ===
  1;
export const TaskCreateInput = TaskCreateShape.refine(
  validCreateDestination,
  "Exactly one explicit create destination required.",
);
export const TaskUpdateInput = z
  .object({
    ...options,
    task_id: id,
    changes: TaskScalarChanges.extend({
      recurrence: Recurrence.nullable().optional(),
      notifications: z.array(NotificationWrite).max(20).optional(),
    }),
  })
  .strict();
export const TaskCompleteInput = z.object({ ...options, task_id: id }).strict();
export const TaskMoveInput = z
  .object({
    ...options,
    task_id: id,
    destination: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project"), project_id: id }).strict(),
      z.object({ kind: z.literal("parent"), task_id: id }).strict(),
      z.object({ kind: z.literal("inbox") }).strict(),
    ]),
  })
  .strict();
export const TaskInputs = {
  "task.create": TaskCreateInput,
  "task.update": TaskUpdateInput,
  "task.complete": TaskCompleteInput,
  "task.move": TaskMoveInput,
  "task.drop": TaskCompleteInput,
  "task.duplicate": TaskCompleteInput,
  "task.delete": TaskCompleteInput,
} as const;
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    task_id: id.nullable(),
    source_task_id: id.optional(),
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
  private async snapshot(
    reference: Reference,
    extended = false,
  ): Promise<Snapshot | null> {
    const result = (await this.native.run("task_write_facts", {
      reference,
      extended,
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
  async prepare(scope: keyof typeof TaskInputs, input: unknown) {
    const parsed = TaskInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid task fields, references or write options.",
      );
    const args = parsed.data;
    if (
      scope === "task.create" &&
      ("project_id" in args && args.project_id !== undefined ? 1 : 0) +
        ("destination" in args && args.destination !== undefined ? 1 : 0) !==
        1
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Exactly one explicit create destination is required.",
      );
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
              ["name", "note", "flagged", "tag_ids", ...scheduling].includes(
                key,
              ),
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
    const extended =
      "recurrence" in itemChanges || "notifications" in itemChanges;
    const destination =
      "destination" in args
        ? (args.destination as z.infer<typeof TaskMoveInput>["destination"])
        : undefined;
    const refs: Reference[] = (
      "project_id" in args && args.project_id
        ? [{ entity: "project", id: args.project_id }]
        : []
    ).concat(
      ((itemChanges.tag_ids ?? []) as string[]).map((id) => ({
        entity: "tag",
        id,
      })),
    );
    if (scope === "task.create" && destination?.kind === "inbox")
      refs.push({ entity: "inbox", id: "inbox" });
    if (destination?.kind === "project")
      refs.push({ entity: "project", id: destination.project_id });
    if (destination?.kind === "parent")
      refs.push({ entity: "task", id: destination.task_id });
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
            "project_id" in args && args.project_id
              ? { project_id: args.project_id }
              : destination
                ? { destination }
                : null,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    const scopeAllowed = !!policy?.scopes.includes(scope);
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        const createReference: Reference | undefined =
          scope === "task.create"
            ? "project_id" in args && args.project_id
              ? { entity: "project", id: args.project_id }
              : destination?.kind === "parent"
                ? { entity: "task", id: destination.task_id }
                : { entity: "inbox", id: "inbox" }
            : request.items[0]!.targets[0];
        const target = resolved.find(
          (r) => canonical(r.reference) === canonical(createReference),
        )!.facts.snapshot as Snapshot;
        const projectId = (
          scope === "task.create" && createReference?.entity === "project"
            ? target.id
            : (target.project_id ?? null)
        ) as string | null;
        const inboxOperation =
          (scope === "task.create" || (scope === "task.update" && !extended)) &&
          projectId === null;
        if (
          args.apply &&
          (!scopeAllowed ||
            !(projectId !== null
              ? policy!.project_ids.includes(projectId)
              : inboxOperation
                ? policy!.allow_inbox
                : [
                    "task.move",
                    "task.drop",
                    "task.duplicate",
                    "task.delete",
                  ].includes(scope) &&
                  policy!.task_ids.includes(target.id as string)))
        )
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Host policy denies this operation/container.",
          );
        if (
          !["task.move", "task.drop", "task.duplicate", "task.delete"].includes(
            scope,
          ) &&
          !inboxOperation &&
          (createReference?.entity === "project"
            ? !target.active
            : !target.project_active)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "An active containing project is required.",
          );
        if (
          scope === "task.create" &&
          destination?.kind === "parent" &&
          (target.completed ||
            target.effective_completed ||
            target.dropped ||
            target.repeating ||
            target.ancestor_repeating ||
            target.ancestor_auto_complete ||
            target.assigned_container_id !== null ||
            (target.preserved as Snapshot).completed_by_children)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Parent must be unfinished ordinary work without repetition or automatic completion.",
          );
        if (
          ((scope === "task.create" && destination?.kind === "parent") ||
            (scope === "task.update" && inboxOperation)) &&
          (target.assigned_container_id !== null || target.ancestor_tentative)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Tentative target or ancestor containment is unsafe.",
          );
        let destinationProject: string | null = projectId;
        let destinationParent: Json =
          scope === "task.create"
            ? destination?.kind === "parent"
              ? target.id!
              : (target.root_id ?? null)
            : (target.parent_id ?? null);
        if (scope === "task.move") {
          if (
            target.completed ||
            target.effective_completed ||
            target.dropped ||
            target.repeating ||
            target.ancestor_repeating ||
            target.ancestor_auto_complete
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Move requires unfinished ordinary work without repeating or automatic ancestors.",
            );
          if (destination?.kind === "inbox") {
            destinationProject = null;
            destinationParent = null;
          } else {
            const dest = resolved.find(
              (r) =>
                r.reference.entity ===
                  (destination?.kind === "project" ? "project" : "task") &&
                r.reference.id ===
                  (destination?.kind === "project"
                    ? destination.project_id
                    : destination?.task_id),
            )!.facts.snapshot as Snapshot;
            if (destination?.kind === "parent") {
              if (
                dest.id === target.id ||
                (dest.ancestor_ids as string[]).includes(target.id as string) ||
                dest.completed ||
                dest.effective_completed ||
                dest.dropped ||
                dest.repeating ||
                dest.ancestor_repeating ||
                dest.ancestor_auto_complete ||
                (dest.preserved as Snapshot).completed_by_children
              )
                throw new MutationError(
                  "INVALID_MUTATION",
                  "Invalid parent state or self/descendant cycle.",
                );
              destinationProject = dest.project_id as string | null;
              destinationParent = dest.id!;
              if (destinationProject !== null && !dest.project_active)
                throw new MutationError(
                  "INVALID_MUTATION",
                  "Inactive destination project.",
                );
              if (
                args.apply &&
                !(destinationProject !== null
                  ? policy!.project_ids.includes(destinationProject)
                  : policy!.task_ids.includes(dest.id as string))
              )
                throw new MutationError(
                  "WRITE_NOT_AUTHORIZED",
                  "Destination is not authorized.",
                );
            } else {
              if (!dest.active || dest.repeating || dest.auto_complete)
                throw new MutationError(
                  "INVALID_MUTATION",
                  "Inactive, repeating or automatic destination project.",
                );
              destinationProject = dest.id as string;
              destinationParent = dest.root_id!;
              if (
                args.apply &&
                !policy!.project_ids.includes(destinationProject)
              )
                throw new MutationError(
                  "WRITE_NOT_AUTHORIZED",
                  "Destination project is not authorized.",
                );
            }
          }
        }
        if (["task.drop", "task.duplicate", "task.delete"].includes(scope)) {
          if (
            target.has_children ||
            target.repeating ||
            target.ancestor_repeating ||
            target.ancestor_auto_complete ||
            (scope !== "task.delete" &&
              (target.completed ||
                target.effective_completed ||
                target.dropped))
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Lifecycle requires an ordinary leaf without repeating or automatic ancestors; drop/duplicate require unfinished work.",
            );
          if (
            scope === "task.duplicate" &&
            (target.attachment_count !== 0 ||
              ((target.preserved as Snapshot).notification_ids instanceof
                Array &&
                ((target.preserved as Snapshot).notification_ids as Json[])
                  .length))
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Duplicate attachments/notifications are outside the verified copy contract.",
            );
        }
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
        if ("planned_at" in item.changes && target.planned_supported !== true)
          throw new MutationError(
            "INVALID_MUTATION",
            "Planned date is unavailable on this native database.",
          );
        const due =
          "due_at" in item.changes
            ? item.changes.due_at
            : scope === "task.create"
              ? null
              : target.due_at;
        const defer =
          "defer_at" in item.changes
            ? item.changes.defer_at
            : scope === "task.create"
              ? null
              : target.defer_at;
        if (
          ("due_at" in item.changes || "defer_at" in item.changes) &&
          typeof due === "string" &&
          typeof defer === "string" &&
          Date.parse(defer) > Date.parse(due)
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Defer date must not follow due date.",
          );
        if (extended) {
          if (
            target.has_children ||
            target.completed ||
            target.effective_completed ||
            target.dropped ||
            target.ancestor_repeating ||
            target.ancestor_auto_complete
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Rule/alarm edits require an unfinished ordinary leaf.",
            );
          if (
            ["due_at", "defer_at", "planned_at"].some((k) => k in item.changes)
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Set anchor dates in a separate request before rule/alarm edits.",
            );
          const r = item.changes.recurrence as Snapshot | null | undefined;
          if (r && !(r.anchor === "due" ? target.due_at : target.defer_at))
            throw new MutationError(
              "INVALID_MUTATION",
              "Exact local recurrence anchor required.",
            );
          if (
            ((item.changes.notifications ?? []) as Snapshot[]).some(
              (n) => n.kind === "due_relative",
            ) &&
            !target.due_at
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Exact local due anchor required.",
            );
          if ((target.notifications as Json[]).length > 20)
            throw new MutationError(
              "INVALID_MUTATION",
              "Existing alarm collection exceeds verification bounds.",
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
          payload: {
            project_id: projectId,
            inbox_authorized: inboxOperation,
            baseline: target,
            destination_project_id: destinationProject,
            destination_parent_id: destinationParent,
          },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const snapshot = await this.snapshot(reference, extended);
        return snapshot ? { reference, facts: { snapshot } } : null;
      },
      readFact: async (fact) => this.snapshot(fact.reference, extended),
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
        if (
          scope !== "task.create" &&
          scope !== "task.duplicate" &&
          targetId !== req.items[0]!.targets[0]!.id
        )
          throw Error(
            "Dispatch target identity differs from exact requested target",
          );
        const reference: Reference = targetId
          ? { entity: "task", id: targetId }
          : refs[0]!;
        const after = await this.snapshot(reference, extended); // NEW evaluation after fixed synchronous dispatch.
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
        if (scope === "task.delete") {
          if (!targetId) throw Error("Deleted target identity unavailable");
          const observed = await this.core.get({ ids: [targetId], fields: [] });
          if (
            after !== null ||
            observed.results[0]?.error?.code !== "NOT_FOUND"
          )
            throw Error("Independent deletion absence paths disagree");
          return {
            settled: true,
            items: [
              {
                item_key: "task",
                resource: { entity: "task", id: targetId },
                all_postconditions: true,
                some_effects: true,
                evidence: [
                  "Synchronous dispatch followed by separate native resolution and public exact-ID absence proof.",
                ],
              },
            ],
          };
        }
        if (scope === "task.duplicate") {
          if (
            !r.source_task_id ||
            r.source_task_id !== req.items[0]!.targets[0]!.id ||
            targetId === r.source_task_id
          )
            throw Error("Duplicate generated identity missing or unchanged");
          const original = await this.snapshot({
            entity: "task",
            id: r.source_task_id,
          });
          if (
            canonical(original) !==
            canonical(
              (plan.items[0]!.payload as { baseline: Snapshot }).baseline,
            )
          )
            throw Error("Duplicate altered original state");
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
            "in_inbox",
            "available",
            "effective_due_at",
            "effective_defer_at",
            "effective_completed",
            "completed_at",
            "dropped_at",
            "due_at",
            "defer_at",
            "estimated_minutes",
            ...(extended
              ? [
                  "notifications" as const,
                  ...("recurrence" in itemChanges
                    ? ["recurrence" as const]
                    : []),
                ]
              : []),
            ...(after.planned_supported === true
              ? ["planned_at" as const]
              : []),
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
          "in_inbox",
          "available",
          "effective_due_at",
          "effective_defer_at",
          "effective_completed",
          "completed_at",
          "dropped_at",
          "due_at",
          "defer_at",
          "estimated_minutes",
          ...(after.planned_supported === true ? ["planned_at" as const] : []),
        ] as const)
          if (canonical(row[field]) !== canonical(after[field]))
            throw new Error("Independent paths disagree.");
        if (
          canonical([...(row.tag_ids ?? [])].sort()) !==
          canonical(after.tag_ids)
        )
          throw new Error("Independent tags disagree.");
        if (extended) {
          if (
            "recurrence" in req.items[0]!.changes &&
            canonical(row.recurrence) !== canonical(after.recurrence)
          )
            throw Error("Independent recurrence paths disagree");
          if (canonical(row.notifications) !== canonical(after.notifications))
            throw Error("Independent notification paths disagree");
        }
        const wanted = req.items[0]!.changes;
        const alarmSpecs = (value: Json) =>
          (value as Snapshot[])
            .map((n) =>
              n.kind === "absolute"
                ? { kind: n.kind, fire_at: n.absolute_fire_at }
                : {
                    kind: n.kind,
                    relative_offset_minutes: n.relative_offset_minutes,
                  },
            )
            .sort((a, b) => canonical(a).localeCompare(canonical(b)));
        const expected = Object.entries(wanted).map(
          ([key, value]) =>
            canonical(
              key === "notifications"
                ? alarmSpecs(after.notifications!)
                : after[key],
            ) ===
            canonical(
              key === "tag_ids"
                ? [...(value as string[])].sort()
                : key === "notifications"
                  ? [...(value as Json[])].sort((a, b) =>
                      canonical(a).localeCompare(canonical(b)),
                    )
                  : value,
            ),
        );
        const payload = plan.items[0]!.payload as {
          project_id: string | null;
          baseline: Snapshot;
          destination_project_id: string | null;
          destination_parent_id: Json;
        };
        expected.push(
          after.project_id ===
            (scope === "task.move"
              ? payload.destination_project_id
              : payload.project_id),
        );
        if (scope === "task.move" || scope === "task.create")
          expected.push(after.parent_id === payload.destination_parent_id);
        if (scope === "task.create") {
          expected.push(
            after.completed === false,
            after.effective_completed === false,
            after.dropped === false,
            after.repeating === false,
            after.in_inbox ===
              (payload.project_id === null &&
                payload.destination_parent_id === null),
          );
          for (const [local, effective] of [
            ["due_at", "effective_due_at"],
            ["defer_at", "effective_defer_at"],
            ["planned_at", "effective_planned_at"],
          ] as const) {
            if (local === "planned_at" && !after.planned_supported) continue;
            expected.push(
              canonical(after[local]) === canonical(wanted[local] ?? null),
            );
            // Native effective dates remain separate facts; exact public due/defer reads agree below.
            if (payload.destination_parent_id === null)
              expected.push(
                canonical(after[effective]) === canonical(after[local]),
              );
          }
        }
        if (scope === "task.drop")
          expected.push(
            after.dropped === true,
            typeof after.dropped_at === "string",
          );
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
            ...(scope === "task.duplicate" ? [] : ["preserved"]),
            ...scheduling,
            "repeating",
            "ancestor_repeating",
          ])
            if (
              !(field in wanted) &&
              !(field === "repeating" && "recurrence" in wanted) &&
              !(field === "preserved" && "notifications" in wanted) &&
              !(scope === "task.move" && field === "parent_id")
            )
              expected.push(
                canonical(after[field]) === canonical(payload.baseline[field]),
              );
        }
        if (extended && "notifications" in wanted) {
          const beforePreserved = payload.baseline.preserved as Snapshot,
            afterPreserved = after.preserved as Snapshot;
          for (const key of ["added", "sequential", "completed_by_children"])
            expected.push(
              canonical(beforePreserved[key]) ===
                canonical(afterPreserved[key]),
            );
          const ns = after.notifications as Snapshot[];
          expected.push(
            ns.every(
              (n) =>
                n.task_id === targetId &&
                n.is_snoozed === false &&
                n.repeat_interval_seconds === 0,
            ),
          );
          for (const n of ns)
            if (n.kind === "due_relative")
              expected.push(
                Date.parse(n.initial_fire_at as string) ===
                  Date.parse(after.due_at as string) +
                    (n.relative_offset_minutes as number) * 60000,
              );
        }
        if (extended) {
          expected.push(
            canonical(after.sibling_ids) ===
              canonical(payload.baseline.sibling_ids),
          );
          if (!("recurrence" in wanted))
            expected.push(
              canonical(after.recurrence_raw) ===
                canonical(payload.baseline.recurrence_raw),
            );
          if (!("notifications" in wanted))
            expected.push(
              canonical(after.notifications) ===
                canonical(payload.baseline.notifications),
            );
        }
        if (scope === "task.duplicate") {
          const originalPreserved = payload.baseline.preserved as Snapshot,
            copyPreserved = after.preserved as Snapshot;
          for (const field of [
            "sequential",
            "completed_by_children",
            "notification_ids",
          ])
            expected.push(
              canonical(originalPreserved[field]) ===
                canonical(copyPreserved[field]),
            );
          expected.push(
            after.attachment_count === 0,
            targetId !== payload.baseline.id,
          );
        }
        if (
          scope !== "task.create" &&
          !(
            after.due_at === null &&
            after.defer_at === null &&
            ("due_at" in wanted || "defer_at" in wanted)
          )
        )
          expected.push(after.floating === payload.baseline.floating);
        return {
          settled: true,
          items: [
            {
              item_key: "task",
              resource: { entity: "task", id: targetId },
              all_postconditions: expected.every(Boolean),
              some_effects:
                scope === "task.create" ||
                scope === "task.duplicate" ||
                (scope === "task.drop" && after.dropped === true) ||
                (scope === "task.move"
                  ? after.project_id !== payload.baseline.project_id ||
                    after.parent_id !== payload.baseline.parent_id
                  : scope === "task.complete"
                    ? after.completed === true
                    : Object.keys(wanted).some(
                        (key) =>
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
    return {
      request,
      planner,
      reader,
      args,
      scopeAllowed,
      writer: {
        apply: async (req, plan, recordReceipt) => {
          const current = await readWritePolicy(this.directory);
          const payload = plan.items[0]!.payload as {
            project_id: string | null;
            inbox_authorized: boolean;
          };
          const projectId = payload.project_id;
          if (
            !current?.scopes.includes(scope) ||
            !(
              (projectId !== null && current.project_ids.includes(projectId)) ||
              (projectId === null &&
                payload.inbox_authorized &&
                current.allow_inbox) ||
              ([
                "task.move",
                "task.drop",
                "task.duplicate",
                "task.delete",
              ].includes(scope) &&
                projectId === null &&
                "task_id" in args &&
                current.task_ids.includes(args.task_id))
            )
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
            extended,
            authorized_project_ids: current.project_ids,
            authorized_task_ids: current.task_ids,
            authorized_inbox: current.allow_inbox,
          });
          await recordReceipt(Receipt.parse(result));
        },
      } satisfies MutationWriter,
    };
  }
  async execute(scope: keyof typeof TaskInputs, input: unknown) {
    const { request, planner, reader, args, scopeAllowed, writer } =
      await this.prepare(scope, input);
    const boundary = new MutationBoundary(
      planner,
      reader,
      writer,
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
