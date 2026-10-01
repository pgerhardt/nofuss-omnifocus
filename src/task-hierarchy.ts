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
import {
  readWritePolicy,
  type WritePolicy,
  type WriteScope,
} from "./write-authorization.js";
import type { NativeWorker } from "./worker.js";
import type { NoFussCore } from "./core.js";
const id = z.string().min(1).max(256);
const common = {
  entity: z.literal("task").default("task"),
  task_id: id,
  apply: z.boolean().default(false),
  request_key: id.optional(),
  preconditions: z.array(Fact).max(100).default([]),
};
export const TaskSubtreeInput = z
  .object({ ...common, subtree: z.literal(true) })
  .strict();
export const TaskReorderInput = z
  .object({
    ...common,
    container: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project"), project_id: id }).strict(),
      z.object({ kind: z.literal("parent"), task_id: id }).strict(),
      z.object({ kind: z.literal("inbox") }).strict(),
    ]),
    position: z.enum(["before", "after"]),
    peer_id: id,
  })
  .strict();
type Snapshot = Record<string, Json>;
const receiptSchema = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    task_id: id.nullable(),
    generated_ids: z.array(id).max(50),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class TaskHierarchy {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(reference: Reference): Promise<Snapshot | null> {
    const r = (await this.native.run("task_hierarchy_facts", {
      reference,
    })) as { reference: Reference; facts: Snapshot | null };
    if (canonical(r.reference) !== canonical(reference))
      throw Error("Hierarchy correlation");
    return r.facts;
  }
  async execute(scope: WriteScope, input: unknown) {
    const parsed = (
      scope === "task.reorder" ? TaskReorderInput : TaskSubtreeInput
    ).safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid explicit hierarchy input",
      );
    const args = parsed.data;
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    const target = { entity: "task", id: args.task_id };
    const refs: Reference[] = [];
    if ("peer_id" in args) {
      refs.push({ entity: "task", id: args.peer_id });
      const c = args.container;
      refs.push(
        c.kind === "project"
          ? { entity: "project", id: c.project_id }
          : c.kind === "parent"
            ? { entity: "task", id: c.task_id }
            : { entity: "inbox", id: "inbox" },
      );
    }
    const payload = (
      "peer_id" in args
        ? {
            container: args.container,
            peer_id: args.peer_id,
            position: args.position,
          }
        : { subtree: true }
    ) as Json;
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: "task",
          targets: [target],
          references: refs,
          changes: {},
          preconditions: args.preconditions,
          payload,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    function authorized(p: WritePolicy | null, b: Snapshot) {
      const nodes = b.tree as Snapshot[];
      return (
        !!p?.scopes.includes(scope) &&
        (nodes[0]!.project_id === null
          ? nodes.every((n) => p.task_ids.includes(n.id as string))
          : p.project_ids.includes(nodes[0]!.project_id as string))
      );
    }
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        const baseline = resolved.find(
          (r) => canonical(r.reference) === canonical(target),
        )!.facts.snapshot as Snapshot;
        if (args.apply && !authorized(policy, baseline))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Whole subtree ownership denied",
          );
        const nodes = baseline.tree as Snapshot[],
          ancestors = baseline.ancestors as Snapshot[];
        if (
          [...nodes, ...ancestors].some(
            (n) =>
              n.repeating ||
              n.completed_by_children ||
              n.assigned_container_id !== null,
          ) ||
          nodes.some((n) => n.attachment_count || n.notification_count) ||
          (scope !== "task.delete" &&
            [...nodes, ...ancestors].some(
              (n) =>
                n.completed || n.effective_completed || n.effective_dropped,
            ))
        )
          throw new MutationError("INVALID_MUTATION", "Unsafe hierarchy state");
        let order = baseline.sibling_ids as string[];
        if ("peer_id" in args) {
          const peer = resolved.find(
            (r) =>
              r.reference.entity === "task" && r.reference.id === args.peer_id,
          )!.facts.snapshot as Snapshot;
          const pn = (peer.tree as Snapshot[])[0]!;
          const c = args.container;
          const parent =
            c.kind === "inbox"
              ? null
              : c.kind === "parent"
                ? c.task_id
                : (
                    resolved.find((r) => r.reference.entity === "project")!
                      .facts.snapshot as Snapshot
                  ).root_id;
          if (
            args.peer_id === args.task_id ||
            nodes[0]!.parent_id !== parent ||
            pn.parent_id !== parent ||
            pn.project_id !== nodes[0]!.project_id
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Distinct exact same-container peers required",
            );
          order = order.filter((x) => x !== args.task_id);
          const index = order.indexOf(args.peer_id);
          if (index < 0)
            throw new MutationError(
              "INVALID_MUTATION",
              "Peer absent from direct siblings",
            );
          order.splice(
            index + (args.position === "after" ? 1 : 0),
            0,
            args.task_id,
          );
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
          predicted_changes: (scope === "task.reorder"
            ? { sibling_ids: order }
            : { subtree_ids: nodes.map((n) => n.id) }) as Json,
          payload: { baseline, expected_order: order },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const f = await this.snapshot(reference);
        return f ? { reference, facts: { snapshot: f } } : null;
      },
      readFact: async (f) => this.snapshot(f.reference),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = receiptSchema.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req)
        )
          throw Error("Receipt identity mismatch");
        const baseline = (plan.items[0]!.payload as { baseline: Snapshot })
          .baseline;
        if (receipt.setter_count === 0 && receipt.error) {
          await this.snapshot(target);
          return {
            settled: true,
            not_attempted:
              receipt.error.code === "PRECONDITION_CONFLICT"
                ? "conflict"
                : "rejected",
            error: receipt.error,
            items: [
              {
                item_key: "task",
                all_postconditions: false,
                some_effects: false,
                evidence: [
                  "Native zero-setter receipt and independent exact evaluation.",
                ],
              },
            ],
          };
        }
        if (scope !== "task.duplicate" && receipt.task_id !== args.task_id)
          throw Error("Exact hierarchy receipt resource mismatch");
        const oldNodes = baseline.tree as Snapshot[];
        const checks: boolean[] = [];
        let someEffects = false;
        if (scope === "task.delete") {
          const references = oldNodes.map((n) => ({
            entity: "task",
            id: n.id as string,
          }));
          const absence = z
            .array(
              z
                .object({
                  reference: z
                    .object({ entity: z.literal("task"), id })
                    .strict(),
                  absent: z.boolean(),
                })
                .strict(),
            )
            .parse(
              await this.native.run("task_hierarchy_absence", { references }),
            );
          if (
            canonical(absence.map((x) => x.reference)) !== canonical(references)
          )
            throw Error("Exact deletion absence correlation");
          checks.push(absence.every((x) => x.absent));
          someEffects = absence.some((x) => x.absent);
          for (let offset = 0; offset < references.length; offset += 20) {
            const publicRead = await this.core.get({
              ids: references.slice(offset, offset + 20).map((r) => r.id),
              fields: [],
            });
            if (
              publicRead.results.some(
                (r) => r.error && r.error.code !== "NOT_FOUND",
              )
            )
              throw Error("Independent deletion read failed");
            checks.push(
              publicRead.results.every((r) => r.error?.code === "NOT_FOUND"),
            );
          }
          const root = oldNodes[0]!;
          const containerRef: Reference =
            root.parent_id === null
              ? { entity: "inbox", id: "inbox" }
              : (baseline.ancestors as Snapshot[])[0]?.is_project_root === true
                ? { entity: "project", id: root.project_id as string }
                : { entity: "task", id: root.parent_id as string };
          const order = z
            .object({
              reference: z.object({ entity: z.string(), id }).strict(),
              ids: z.array(id),
            })
            .strict()
            .parse(
              await this.native.run("task_hierarchy_order", {
                reference: containerRef,
              }),
            );
          if (canonical(order.reference) !== canonical(containerRef))
            throw Error("Deletion container identity mismatch");
          const siblings = order.ids;
          checks.push(
            canonical(siblings) ===
              canonical(
                (baseline.sibling_ids as string[]).filter(
                  (x) => x !== args.task_id,
                ),
              ),
          );
        } else {
          const resultId = receipt.task_id;
          if (!resultId)
            throw Error(
              "Generated root identity unavailable; never infer/retry",
            );
          const after = await this.snapshot({ entity: "task", id: resultId });
          if (!after) throw Error("Exact returned root missing");
          const nodes = after.tree as Snapshot[];
          someEffects =
            scope === "task.duplicate"
              ? resultId !== args.task_id
              : scope === "task.reorder"
                ? canonical(after.sibling_ids) !==
                  canonical(baseline.sibling_ids)
                : scope === "task.drop"
                  ? nodes[0]!.dropped_at !== oldNodes[0]!.dropped_at
                  : nodes[0]!.completed !== oldNodes[0]!.completed ||
                    nodes[0]!.completed_at !== oldNodes[0]!.completed_at;
          if (scope === "task.duplicate") {
            if (
              resultId === args.task_id ||
              receipt.generated_ids.length !== oldNodes.length ||
              new Set(receipt.generated_ids).size !== oldNodes.length ||
              receipt.generated_ids.some((x) =>
                oldNodes.some((n) => n.id === x),
              )
            )
              throw Error("Generated descendant identities incomplete");
            const source = await this.snapshot(target);
            if (!source) throw Error("Original source disappeared");
            const expectedSiblings = [...(baseline.sibling_ids as string[])];
            expectedSiblings.splice(
              expectedSiblings.indexOf(args.task_id) + 1,
              0,
              resultId,
            );
            checks.push(
              canonical(after.sibling_ids) === canonical(expectedSiblings),
            );
            source.sibling_ids = (source.sibling_ids as string[]).filter(
              (x) => x !== resultId,
            );
            const parent = (source.ancestors as Snapshot[])[0];
            if (parent)
              parent.child_ids = (parent.child_ids as string[]).filter(
                (x) => x !== resultId,
              );
            checks.push(
              canonical(receipt.generated_ids) ===
                canonical(nodes.map((n) => n.id)),
              canonical(source) === canonical(baseline),
            );
            const normalize = (rows: Snapshot[]) =>
              rows.map((n) => {
                const { id, parent_id, child_ids, ...rest } = n;
                return {
                  ...rest,
                  parent_index: rows.findIndex((r) => r.id === parent_id),
                  children: (child_ids as string[]).map((x) =>
                    rows.findIndex((r) => r.id === x),
                  ),
                };
              });
            checks.push(
              canonical(normalize(nodes)) === canonical(normalize(oldNodes)),
              nodes[0]!.parent_id === oldNodes[0]!.parent_id,
            );
          } else {
            checks.push(
              canonical(nodes.map((n) => n.id)) ===
                canonical(oldNodes.map((n) => n.id)),
            );
            for (let i = 0; i < nodes.length; i++) {
              const old = oldNodes[i]!,
                now = nodes[i]!;
              const omit =
                scope === "task.reorder"
                  ? []
                  : scope === "task.drop"
                    ? ["dropped_at", "effective_dropped"]
                    : ["completed", "completed_at", "effective_completed"];
              for (const k of Object.keys(old))
                if (!omit.includes(k))
                  checks.push(canonical(old[k]) === canonical(now[k]));
              if (scope === "task.drop")
                checks.push(
                  now.effective_dropped === true,
                  i === 0
                    ? typeof now.dropped_at === "string"
                    : now.dropped_at === old.dropped_at,
                );
              if (scope === "task.complete")
                checks.push(
                  now.effective_completed === true,
                  i === 0
                    ? now.completed === true &&
                        typeof now.completed_at === "string"
                    : now.completed === old.completed &&
                        now.completed_at === old.completed_at,
                );
            }
            checks.push(
              canonical(after.sibling_ids) ===
                canonical(
                  (plan.items[0]!.payload as { expected_order: Json })
                    .expected_order,
                ),
            );
            if ("peer_id" in args) {
              const c = args.container;
              const independent = await this.snapshot(
                c.kind === "project"
                  ? { entity: "project", id: c.project_id }
                  : c.kind === "parent"
                    ? { entity: "task", id: c.task_id }
                    : { entity: "inbox", id: "inbox" },
              );
              if (!independent)
                throw Error("Exact reorder container disappeared");
              const order =
                c.kind === "parent"
                  ? (independent.tree as Snapshot[])[0]!.child_ids
                  : independent.sibling_ids;
              checks.push(
                canonical(order) ===
                  canonical(
                    (plan.items[0]!.payload as { expected_order: Json })
                      .expected_order,
                  ),
              );
            }
          }
          const fields = [
            "name",
            "note",
            "flagged",
            "tag_ids",
            "project_id",
            "parent_id",
            "completed",
            "completed_at",
            "dropped_at",
            "effective_completed",
            "effective_dropped",
            "due_at",
            "defer_at",
            "effective_due_at",
            "effective_defer_at",
            "planned_at",
            "estimated_minutes",
            "sequential",
            "completed_by_children",
            "floating_time_zone",
          ] as const;
          for (let offset = 0; offset < nodes.length; offset += 20) {
            const chunk = nodes.slice(offset, offset + 20);
            const r = await this.core.get({
              ids: chunk.map((n) => n.id as string),
              fields: [...fields],
            });
            for (let i = 0; i < chunk.length; i++) {
              const n = chunk[i]!,
                row = r.results[i]?.task;
              if (!row || row.id !== n.id || row.unavailable || row.truncated)
                throw Error("Independent subtree public read incomplete");
              for (const k of fields)
                checks.push(
                  canonical(
                    k === "tag_ids" ? [...(row.tag_ids ?? [])].sort() : row[k],
                  ) === canonical(n[k]),
                );
            }
          }
        }
        return {
          settled: true,
          items: [
            {
              item_key: "task",
              resource: { entity: "task", id: receipt.task_id ?? args.task_id },
              all_postconditions: checks.every(Boolean),
              some_effects: someEffects,
              evidence: [
                "Separate exact subtree facts and public reads verify every affected persistent ID.",
                ...(scope === "task.duplicate"
                  ? receipt.generated_ids.map(
                      (id) =>
                        "Generated persistent ID from returned-root traversal: " +
                        id,
                    )
                  : []),
              ],
            },
          ],
        };
      },
    };
    const writer = {
      apply: async (
        req: MutationRequest,
        plan: import("./mutation-contract.js").Plan,
        record: (r: Json) => Promise<void>,
      ) => {
        const p = await readWritePolicy(this.directory);
        const b = (plan.items[0]!.payload as { baseline: Snapshot }).baseline;
        if (!authorized(p, b)) {
          await record({
            request_key: req.request_key!,
            input_hash: inputHash(req),
            finished: true,
            setter_count: 0,
            task_id: null,
            generated_ids: [],
            error: {
              code: "WRITE_NOT_AUTHORIZED",
              message: "Whole subtree authorization revoked",
            },
          });
          return;
        }
        const r = await this.native.run("task_hierarchy_apply", {
          request: req,
          plan,
          input_hash: inputHash(req),
          scopes: p!.scopes,
          project_ids: p!.project_ids,
          task_ids: p!.task_ids,
        });
        await record(receiptSchema.parse(r));
      },
    };
    const boundary = new MutationBoundary(
      planner,
      reader,
      writer,
      new MutationJournal(this.directory),
      {
        mode: args.apply
          ? policy?.scopes.includes(scope)
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
