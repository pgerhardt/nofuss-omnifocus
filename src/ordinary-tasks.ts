import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  canonical,
  inputHash,
  MutationError,
  type MutationRequest,
  type Json,
  type Reference,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
const id = z.string().min(1).max(256),
  options = {
    entity: z.literal("task"),
    task_id: id,
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(4).default([]),
  };
export const OrdinaryTaskInputs = {
  "task.uncomplete": z.object(options).strict(),
  "task.undrop": z.object(options).strict(),
  "task.convert_to_project": z
    .object({
      ...options,
      destination: z.discriminatedUnion("entity", [
        z
          .object({ entity: z.literal("library"), id: z.literal("library") })
          .strict(),
        z.object({ entity: z.literal("folder"), id }).strict(),
      ]),
    })
    .strict(),
};
type Scope = keyof typeof OrdinaryTaskInputs;
type Snapshot = {
  id: string;
  root_project: string | null;
  rows: Record<string, Json>[];
  ancestors: Record<string, Json>[];
  sibling_ids: string[];
};
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().min(0).max(1),
    resource_id: id.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class OrdinaryTasks {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  private async facts(ref: Reference): Promise<Json | null> {
    const r = (await this.native.run("ordinary_task_facts", {
      reference: ref,
    })) as { reference: Reference; facts: Json | null };
    if (
      canonical(r.reference) !== canonical(ref) ||
      (r.facts && (r.facts as { id: Json }).id !== ref.id)
    )
      throw Error("Ordinary task fact association");
    return r.facts;
  }
  async execute(scope: Scope, input: unknown) {
    const p = OrdinaryTaskInputs[scope].safeParse(input);
    if (!p.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid ordinary task operation",
      );
    const args = p.data,
      ref = { entity: "task", id: args.task_id },
      conversion = scope === "task.convert_to_project",
      destination =
        scope === "task.convert_to_project"
          ? (
              args as z.infer<
                (typeof OrdinaryTaskInputs)["task.convert_to_project"]
              >
            ).destination
          : null;
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    const req: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "ordinary-task",
          targets: [ref],
          references: destination ? [destination] : [],
          changes: destination ? { destination } : {},
          preconditions: args.preconditions,
          payload: null,
        },
      ],
    };
    const allowed = (policy: WritePolicy | null, s: Snapshot | null) =>
      !!policy?.scopes.includes(scope) &&
      !!s &&
      s.rows.every((r) =>
        r.project_id
          ? policy.project_ids.includes(r.project_id as string)
          : policy.allow_inbox && policy.task_ids.includes(r.id as string),
      ) &&
      (!conversion ||
        (policy.allow_project_creation &&
          (destination?.entity !== "folder" ||
            policy.folder_ids.includes(destination.id))));
    const policy = await readWritePolicy(this.directory);
    const b = new MutationBoundary(
      {
        operation: req.operation,
        validate: (item, resolved) => {
          const s = resolved[0]!.facts.snapshot as unknown as Snapshot,
            root = s.rows[0]!;
          if (args.apply && !allowed(policy, s))
            throw new MutationError(
              "WRITE_NOT_AUTHORIZED",
              "Exact task, destination and project creation authority required",
            );
          if (
            s.root_project ||
            s.id.includes(".") ||
            s.ancestors.some(
              (r) => r.repeat || r.auto || r.tentative || r.completed || r.drop,
            ) ||
            s.rows.some(
              (r) =>
                r.repeat ||
                r.auto ||
                r.tentative ||
                r.attachments ||
                r.notifications,
            )
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Unsafe ordinary task context",
            );
          if (
            conversion
              ? s.rows.some((r) => r.completed || r.drop) ||
                root.effective_due !== root.due ||
                root.effective_defer !== root.defer ||
                root.effective_planned !== root.planned
              : s.rows.length !== 1 ||
                (scope === "task.uncomplete"
                  ? !root.completed || !!root.drop
                  : !!root.completed || !root.drop)
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Exact local ordinary lifecycle state required",
            );
          if (
            destination &&
            (resolved[1]!.facts.snapshot as { child_ids: Json[] }).child_ids
              .length >= 200
          )
            throw new MutationError("INVALID_MUTATION", "Destination full");
          return {
            item_key: item.item_key,
            predicted_changes: {
              operation: scope,
              identity: conversion
                ? "native returned project/root ID"
                : "same task ID",
            },
            preconditions: resolved.map((r) => ({
              reference: r.reference,
              field: "snapshot",
              expected: r.facts.snapshot!,
            })),
            payload: {
              baseline: s,
              destination: destination ? resolved[1]!.facts.snapshot! : null,
            } as unknown as Json,
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
            receipt.input_hash !== inputHash(request)
          )
            throw Error("Ordinary receipt correlation");
          if (!receipt.resource_id)
            throw Error("Returned conversion identity missing");
          if (!conversion && receipt.resource_id !== ref.id)
            throw Error("Restoration resource mismatch");
          const payload = plan.items[0]!.payload as unknown as {
              baseline: Snapshot;
              destination: { child_ids: string[] } | null;
            },
            before = payload.baseline;
          const r = (await this.native.run("ordinary_task_readback", {
            source: ref,
            destination,
            project_id: conversion ? receipt.resource_id : null,
            source_parent_id: before.rows[0]!.parent_id,
            ancestor_ids: before.ancestors.map((r) => r.id),
          })) as {
            source: Snapshot | null;
            source_order: string[] | null;
            old_ancestors: Record<string, Json>[];
            destination: { child_ids: string[] } | null;
            project: {
              id: string;
              root_id: string;
              folder_id: string | null;
              status: string;
            } | null;
          };
          if (!r.source || r.source.id !== ref.id)
            throw Error("Exact source unavailable");
          const after = r.source;
          if (
            conversion &&
            receipt.setter_count > 0 &&
            (r.project?.id !== receipt.resource_id ||
              r.project?.root_id !== ref.id ||
              after.root_project !== receipt.resource_id)
          )
            throw Error(
              "Conversion project/root identity association unproved",
            );
          const expectedAncestors = conversion
            ? before.ancestors.map((r) =>
                r.id === before.rows[0]!.parent_id
                  ? {
                      ...r,
                      child_ids: (r.child_ids as string[]).filter(
                        (k) => k !== ref.id,
                      ),
                    }
                  : r,
              )
            : before.ancestors;
          const checks = [
            canonical(expectedAncestors) === canonical(r.old_ancestors),
            before.rows.length === after.rows.length,
          ];
          for (let i = 0; i < before.rows.length; i++) {
            const old = before.rows[i]!,
              now = after.rows[i]!;
            if (!now) {
              checks.push(false);
              continue;
            }
            for (const [k, v] of Object.entries(old))
              if (
                ![
                  "parent_id",
                  "project_id",
                  "completed",
                  "completion",
                  "drop",
                  "effective_completion",
                  "effective_drop",
                ].includes(k)
              )
                checks.push(canonical(now[k]) === canonical(v));
            if (conversion) {
              checks.push(
                now.completed === old.completed,
                now.completion === old.completion,
                now.drop === old.drop,
                now.project_id === receipt.resource_id,
                now.parent_id === (i === 0 ? null : old.parent_id),
              );
            } else
              checks.push(
                now.parent_id === old.parent_id,
                now.project_id === old.project_id,
                now.completed === false,
                now.completion === null,
                now.drop === null,
                now.effective_completion === null,
                now.effective_drop === null,
              );
          }
          if (conversion) {
            const expectedDest = [
              ...payload.destination!.child_ids,
              receipt.resource_id,
            ];
            checks.push(
              r.project?.id === receipt.resource_id,
              r.project?.root_id === ref.id,
              r.project?.status === "active",
              r.project?.folder_id ===
                (destination?.entity === "folder" ? destination.id : null),
              canonical(r.destination?.child_ids) === canonical(expectedDest),
            );
            checks.push(
              canonical(r.source_order) ===
                canonical(before.sibling_ids.filter((x) => x !== ref.id)),
            );
          } else
            checks.push(
              canonical(after.sibling_ids) === canonical(before.sibling_ids),
              after.root_project === before.root_project,
            );
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
                item_key: "ordinary-task",
                ...(!conversion || receipt.setter_count > 0
                  ? {
                      resource: {
                        entity: conversion ? "project" : "task",
                        id: receipt.resource_id,
                      },
                    }
                  : {}),
                all_postconditions: !receipt.error && checks.every(Boolean),
                some_effects: canonical(after) !== canonical(before),
                evidence: [
                  "Separate exact native readback verifies local/effective restoration or returned project/root/descendant identities and preserved metadata; no generated identity inference.",
                ],
              },
            ],
          };
        },
      },
      {
        apply: async (request, plan, record) => {
          const current = await readWritePolicy(this.directory);
          const before = (
            plan.items[0]!.payload as unknown as { baseline: Snapshot }
          ).baseline;
          if (!allowed(current, before)) {
            await record({
              request_key: request.request_key!,
              input_hash: inputHash(request),
              finished: true,
              setter_count: 0,
              resource_id: ref.id,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Task authority revoked",
              },
            });
            return;
          }
          await record(
            Receipt.parse(
              await this.native.run("ordinary_task_apply", {
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
    const apply_input = {
      ...args,
      preconditions: preview.plan.items[0]!.preconditions,
    };
    return {
      mode: "preview" as const,
      input_hash: preview.input_hash,
      plan: preview.plan.items[0]!.predicted_changes,
      apply_input,
      apply_input_hash: inputHash({
        ...req,
        items: [{ ...req.items[0]!, preconditions: apply_input.preconditions }],
      }),
    };
  }
}
