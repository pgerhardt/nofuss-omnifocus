import { z } from "zod";
import {
  TaskWrites,
  TaskCreateShape,
  validCreateDestination,
  TaskUpdateInput,
  TaskCompleteInput,
  TaskMoveInput,
  TaskScalarChanges,
} from "./task-writes.js";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  MutationError,
  canonical,
  inputHash,
  type Json,
  type MutationRequest,
  type Planner,
  type MutationReader,
  type Readback,
} from "./mutation-contract.js";
import { readWritePolicy } from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
import type { NoFussCore } from "./core.js";
const key = z.string().min(1).max(256),
  omit = { entity: true, apply: true, request_key: true } as const;
const common = {
  entity: z.literal("task").default("task"),
  apply: z.boolean().default(false),
  request_key: key.optional(),
};
export const TaskBatchInput = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("create"),
      items: z
        .array(
          TaskCreateShape.omit(omit)
            .extend({ item_key: key })
            .refine(validCreateDestination),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("update"),
      items: z
        .array(
          TaskUpdateInput.omit(omit).extend({
            item_key: key,
            changes: TaskScalarChanges,
          }),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("move"),
      items: z
        .array(TaskMoveInput.omit(omit).extend({ item_key: key }))
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("complete"),
      items: z
        .array(TaskCompleteInput.omit(omit).extend({ item_key: key }))
        .min(1)
        .max(20),
    })
    .strict(),
]);
const error = z.object({ code: z.string(), message: z.string() }).nullable();
const BatchReceipt = z
  .object({
    request_key: key,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    error,
    items: z
      .array(
        z
          .object({
            item_key: key,
            setter_count: z.number().int().nonnegative(),
            task_id: key.nullable(),
            error,
            attempted: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export class TaskBatch {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  async execute(input: unknown) {
    const parsed = TaskBatchInput.safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid bounded batch fields.",
      );
    const args = parsed.data;
    if (args.apply && !args.request_key)
      throw new MutationError(
        "INVALID_MUTATION",
        "Batch apply requires request_key.",
      );
    if (new Set(args.items.map((i) => i.item_key)).size !== args.items.length)
      throw new MutationError("INVALID_MUTATION", "Duplicate item_key.");
    const scope = `task.${args.action}` as
      | "task.create"
      | "task.update"
      | "task.move"
      | "task.complete";
    const scalars = await Promise.all(
      args.items.map(({ item_key: _key, ...input }) =>
        new TaskWrites(this.native, this.core, this.directory).prepare(scope, {
          ...input,
          apply: args.apply,
          request_key: args.request_key,
        }),
      ),
    );
    const request: MutationRequest = {
      operation: { kind: "task.batch", version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: scalars.map((s, i) => ({
        ...s.request.items[0]!,
        item_key: args.items[i]!.item_key,
        payload: {
          scalar_kind: scope,
          scalar_payload: s.request.items[0]!.payload,
        },
      })),
    };
    const policy = await readWritePolicy(this.directory),
      allowed =
        !!policy?.scopes.includes("task.batch") &&
        !!policy.scopes.includes(scope);
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        const index = request.items.findIndex(
            (i) => i.item_key === item.item_key,
          ),
          scalar = scalars[index]!;
        const targets = request.items.flatMap((i) => i.targets);
        if (new Set(targets.map(canonical)).size !== targets.length)
          throw new MutationError("INVALID_MUTATION", "Duplicate target.");
        if (
          request.items.some((i) =>
            i.references.some((r) =>
              targets.some((t) => canonical(r) === canonical(t)),
            ),
          )
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Target/destination overlap is outside batch scope.",
          );
        for (const r of resolved.filter((r) =>
          targets.some((t) => canonical(t) === canonical(r.reference)),
        )) {
          const f = r.facts.snapshot as Record<string, Json>;
          if (
            (f.ancestor_ids as string[]).some((id) =>
              targets.some((t) => t.entity === "task" && t.id === id),
            )
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Ancestor/descendant batch targets unsupported.",
            );
        }
        const declared = [...item.targets, ...item.references];
        const p = scalar.planner.validate(
          scalar.request.items[0]!,
          resolved.filter((r) =>
            declared.some((t) => canonical(t) === canonical(r.reference)),
          ),
        );
        return { ...p, item_key: item.item_key };
      },
    };
    const reader: MutationReader = {
      resolve: (r) => scalars[0]!.reader.resolve(r),
      readFact: (f) => scalars[0]!.reader.readFact(f),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = BatchReceipt.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req) ||
          canonical(receipt.items.map((i) => i.item_key)) !==
            canonical(req.items.map((i) => i.item_key))
        )
          throw Error("Batch dispatch identity mismatch");
        if (
          receipt.setter_count !==
            receipt.items.reduce((n, i) => n + i.setter_count, 0) ||
          receipt.items.some(
            (i, index) =>
              !i.attempted &&
              (i.setter_count !== 0 ||
                !i.error ||
                receipt.items.slice(index + 1).some((j) => j.attempted)),
          )
        )
          throw Error("Inconsistent whole-request dispatch accounting");
        const items: Readback["items"] = [];
        for (let i = 0; i < req.items.length; i++) {
          const s = scalars[i]!,
            r = receipt.items[i]!,
            scalarRequest = {
              ...s.request,
              request_key: req.request_key,
              items: [
                {
                  ...s.request.items[0]!,
                  preconditions: req.items[i]!.preconditions,
                },
              ],
            };
          try {
            const result = await s.reader.readback(
              scalarRequest,
              { items: [{ ...plan.items[i]!, item_key: "task" }] },
              {
                request_key: req.request_key,
                input_hash: inputHash(scalarRequest),
                finished: true,
                setter_count: r.setter_count,
                task_id: r.task_id,
                error: r.error,
              },
            );
            items.push({
              ...result.items[0]!,
              item_key: req.items[i]!.item_key,
              ...(result.not_attempted
                ? { not_attempted: result.not_attempted }
                : {}),
              evidence: [
                ...result.items[0]!.evidence,
                "One whole-request native dispatch; separate per-item readback.",
              ],
            });
          } catch {
            items.push({
              item_key: req.items[i]!.item_key,
              all_postconditions: false,
              some_effects: false,
              evidence: [
                "Independent batch item evidence incomplete; never replay.",
              ],
            });
          }
        }
        return {
          settled: true,
          items,
          ...(receipt.error ? { error: receipt.error } : {}),
        };
      },
    };
    const boundary = new MutationBoundary(
      planner,
      reader,
      {
        apply: async (req, plan, record) => {
          const current = await readWritePolicy(this.directory);
          if (
            !current?.scopes.includes("task.batch") ||
            !current.scopes.includes(scope)
          ) {
            const e = {
              code: "WRITE_NOT_AUTHORIZED",
              message: "Batch/scalar authorization revoked before dispatch",
            };
            await record({
              request_key: req.request_key!,
              input_hash: inputHash(req),
              finished: true,
              setter_count: 0,
              error: e,
              items: req.items.map((i) => ({
                item_key: i.item_key,
                setter_count: 0,
                task_id: i.targets[0]?.id ?? null,
                error: e,
                attempted: false,
              })),
            });
            return;
          }
          const result = await this.native.run("task_write_apply", {
            request: req,
            plan,
            input_hash: inputHash(req),
            authorized_project_ids: current.project_ids,
            authorized_task_ids: current.task_ids,
            authorized_inbox: current.allow_inbox,
            authorized_scopes: current.scopes,
          });
          await record(BatchReceipt.parse(result) as Json);
        },
      },
      new MutationJournal(this.directory),
      {
        mode: args.apply
          ? allowed
            ? "apply-authorized"
            : "read-only"
          : "preview-authorized",
      },
    );
    if (args.apply) return boundary.apply(request);
    const preview = await boundary.preview(request),
      apply_input = {
        ...args,
        items: args.items.map((i, index) => ({
          ...i,
          preconditions: preview.plan.items[index]!.preconditions,
        })),
      };
    return {
      mode: "preview" as const,
      operation: "task.batch",
      ...preview,
      apply_input,
      apply_input_hash: inputHash({
        ...request,
        items: request.items.map((i, index) => ({
          ...i,
          preconditions: apply_input.items[index]!.preconditions,
        })),
      }),
    };
  }
}
