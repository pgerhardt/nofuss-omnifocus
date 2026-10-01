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
const id = z.string().min(1).max(256),
  options = {
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(100).default([]),
  };
const project = z
    .object({ ...options, entity: z.literal("project"), project_id: id })
    .strict(),
  folder = z
    .object({ ...options, entity: z.literal("folder"), folder_id: id })
    .strict(),
  tag = z.object({ ...options, entity: z.literal("tag"), tag_id: id }).strict();
const sectionPeer = z
    .object({ entity: z.enum(["project", "folder"]), id })
    .strict(),
  tagPeer = z.object({ entity: z.literal("tag"), id }).strict();
const position = z.enum(["before", "after"]);
export const ContainerInputs = {
  "project.delete": project.extend({ cascade: z.literal(true) }),
  "folder.delete": folder.extend({ cascade: z.literal(true) }),
  "tag.delete": tag.extend({ cascade: z.literal(true) }),
  "project.reorder": project.extend({
    folder_id: id.nullable(),
    peer: sectionPeer,
    position,
  }),
  "folder.reorder": folder.extend({
    parent_id: id.nullable(),
    peer: sectionPeer,
    position,
  }),
  "tag.reorder": tag.extend({
    parent_id: id.nullable(),
    peer: tagPeer,
    position,
  }),
} as const;
type Scope = keyof typeof ContainerInputs;
type Snapshot = Record<string, Json>;
const receiptSchema = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().nonnegative(),
    resource_id: id.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class ContainerLifecycle {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private core: Pick<NoFussCore, "get">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(
    reference: Reference,
    shallow = false,
  ): Promise<Snapshot | null> {
    const r = (await this.native.run("container_lifecycle_facts", {
      reference,
      shallow,
    })) as { reference: Reference; facts: Snapshot | null };
    if (canonical(r.reference) !== canonical(reference))
      throw Error("Exact container correlation");
    return r.facts;
  }
  async execute(scope: Scope, input: unknown) {
    const parsed = ContainerInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid explicit container lifecycle fields",
      );
    const args = parsed.data,
      del = scope.endsWith(".delete"),
      entity = args.entity,
      target = {
        entity,
        id:
          "project_id" in args
            ? args.project_id
            : "tag_id" in args
              ? args.tag_id
              : args.folder_id!,
      };
    if (args.apply && !args.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    const refs: Reference[] = "peer" in args ? [args.peer] : [];
    const payload: Json =
      "peer" in args
        ? {
            peer: args.peer,
            parent_id: "parent_id" in args ? args.parent_id : args.folder_id,
            position: args.position,
          }
        : { cascade: true };
    const request: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(args.request_key ? { request_key: args.request_key } : {}),
      items: [
        {
          item_key: entity,
          targets: [target],
          references: refs,
          changes: {},
          preconditions: args.preconditions,
          payload,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    function authorized(p: WritePolicy | null, b: Snapshot, peer?: Snapshot) {
      if (!p?.scopes.includes(scope)) return false;
      const owned = (n: Snapshot) =>
        (n.entity === "project"
          ? p.project_ids
          : n.entity === "folder"
            ? p.folder_ids
            : p.tag_ids
        ).includes(n.id as string);
      return (
        (del ? (b.nodes as Snapshot[]) : [b.target as Snapshot]).every(owned) &&
        (!peer || owned(peer.target as Snapshot)) &&
        (b.associations as Snapshot[]).every((t) =>
          t.project_id === null
            ? p.task_ids.includes(t.id as string)
            : p.project_ids.includes(t.project_id as string),
        )
      );
    }
    const planner: Planner = {
      operation: request.operation,
      validate: (item, resolved) => {
        const b = resolved.find(
            (r) => canonical(r.reference) === canonical(target),
          )!.facts.snapshot as Snapshot,
          peer = refs.length
            ? (resolved.find(
                (r) => canonical(r.reference) === canonical(refs[0]),
              )!.facts.snapshot as Snapshot)
            : undefined;
        const t = b.target as Snapshot;
        if (args.apply && !authorized(policy, b, peer))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Full cascade, peer and association ownership denied",
          );
        if (
          del &&
          ((b.nodes as Snapshot[]).some(
            (n) => n.default_holder || n.id === b.forecast_tag_id,
          ) ||
            (b.tasks as Snapshot[]).some(
              (t) => t.attachments || t.notifications || t.assigned,
            ))
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Unbounded cascade side effects",
          );
        let order = b.sibling_ids as Snapshot[];
        if ("peer" in args) {
          const p = peer!.target as Snapshot;
          const parent = "parent_id" in args ? args.parent_id : args.folder_id;
          if (
            p.id === t.id ||
            p.parent_id !== t.parent_id ||
            parent !== t.parent_id
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Distinct exact same-container peers required",
            );
          order = order.filter((n) => n.id !== t.id);
          const index = order.findIndex(
            (n) => n.id === p.id && n.entity === p.entity,
          );
          if (index < 0)
            throw new MutationError("INVALID_MUTATION", "Exact peer absent");
          order.splice(index + (args.position === "after" ? 1 : 0), 0, t);
          order = order.map((n) => ({ entity: n.entity!, id: n.id! }));
        }
        const deleted = del
          ? [
              ...(b.nodes as Snapshot[]).map((n) => ({
                entity: n.entity as string,
                id: n.id as string,
              })),
              ...(b.tasks as Snapshot[]).map((n) => ({
                entity: "task",
                id: n.id as string,
              })),
            ]
          : [];
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
          predicted_changes: (del
            ? {
                deleted_ids: deleted,
                association_ids: (b.associations as Snapshot[]).map(
                  (t) => t.id!,
                ),
              }
            : { sibling_ids: order }) as Json,
          payload: {
            baseline: b,
            peer: peer ?? null,
            deleted,
            expected_order: order,
          },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (reference) => {
        const f = await this.snapshot(reference, !del);
        return f ? { reference, facts: { snapshot: f } } : null;
      },
      readFact: async (f) => this.snapshot(f.reference, !del),
      readback: async (req, plan, raw): Promise<Readback> => {
        const receipt = receiptSchema.parse(raw);
        if (
          receipt.request_key !== req.request_key ||
          receipt.input_hash !== inputHash(req)
        )
          throw Error("Receipt mismatch");
        const p = plan.items[0]!.payload as {
          baseline: Snapshot;
          peer: Snapshot | null;
          deleted: Reference[];
          expected_order: Json;
        };
        const b = p.baseline,
          t = b.target as Snapshot;
        if (receipt.setter_count === 0 && receipt.error) {
          await this.snapshot(target, !del);
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
                  "Zero native setters and independent exact evaluation.",
                ],
              },
            ],
          };
        }
        if (receipt.resource_id !== target.id)
          throw Error("Exact container receipt resource mismatch");
        const checks: boolean[] = [];
        let someEffects = false;
        if (del) {
          const absent = (await this.native.run("container_lifecycle_absence", {
            references: p.deleted,
          })) as { reference: Reference; absent: boolean }[];
          someEffects = absent.some((x) => x.absent);
          checks.push(
            canonical(absent.map((x) => x.reference)) === canonical(p.deleted),
            absent.every((x) => x.absent),
          );
          for (const kind of ["project", "folder", "tag", "task"]) {
            const ids = p.deleted
              .filter((r) => r.entity === kind)
              .map((r) => r.id);
            for (let i = 0; i < ids.length; i += 20) {
              const publicRead = await this.core.get({
                entity: kind as "task" | "project" | "folder" | "tag",
                ids: ids.slice(i, i + 20),
                fields: [],
              });
              if (
                publicRead.results.some(
                  (r) => r.error && r.error.code !== "NOT_FOUND",
                )
              )
                throw Error("Independent cascade read failed");
              checks.push(
                publicRead.results.every((r) => r.error?.code === "NOT_FOUND"),
              );
            }
          }
          const deletedTags = (b.nodes as Snapshot[])
            .filter((n) => n.entity === "tag")
            .map((n) => n.id as string);
          for (const old of b.associations as Snapshot[]) {
            const ref = {
              entity: old.entity as string,
              id: (old.entity === "project"
                ? old.project_id
                : old.id) as string,
            };
            const now = await this.snapshot(ref);
            if (!now) throw Error("Associated object deleted unexpectedly");
            const current =
              ref.entity === "project"
                ? (now.tasks as Snapshot[])[0]!
                : (now.task as Snapshot);
            const expected = {
              ...old,
              tag_ids: (old.tag_ids as string[]).filter(
                (x) => !deletedTags.includes(x),
              ),
            };
            checks.push(canonical(current) === canonical(expected));
            const r = await this.core.get({
              entity: ref.entity as "project" | "task",
              ids: [ref.id],
              fields: ["tag_ids"],
            });
            const row = r.results[0]?.task ?? r.results[0]?.project;
            if (!row || row.unavailable || row.truncated)
              throw Error("Association public read incomplete");
            checks.push(
              canonical([...(row.tag_ids ?? [])].sort()) ===
                canonical(expected.tag_ids),
            );
          }
          const order = await this.native.run("container_lifecycle_order", {
            entity,
            parent_id: t.parent_id,
          });
          checks.push(
            canonical(order) ===
              canonical(
                (b.sibling_ids as Snapshot[]).filter(
                  (n) => n.entity !== entity || n.id !== target.id,
                ),
              ),
          );
        } else {
          const after = await this.snapshot(target, true),
            peer = await this.snapshot(refs[0]!, true);
          if (!after || !peer)
            throw Error("Reorder exact identity disappeared");
          someEffects =
            canonical(after.sibling_ids) !== canonical(b.sibling_ids) ||
            canonical((after.target as Snapshot).parent_id) !==
              canonical(t.parent_id);
          checks.push(
            canonical(after.sibling_ids) === canonical(p.expected_order),
            canonical(peer.sibling_ids) === canonical(p.expected_order),
          );
          checks.push(
            canonical({ ...after, sibling_ids: b.sibling_ids }) ===
              canonical(b),
          );
          const publicRead = await this.core.get({
            entity,
            ids: [target.id],
            fields: [
              "name",
              ...(entity === "project"
                ? ["folder_id" as const]
                : ["parent_id" as const]),
            ],
          });
          const row =
            publicRead.results[0]?.project ??
            publicRead.results[0]?.folder ??
            publicRead.results[0]?.tag;
          if (!row || row.unavailable || row.truncated)
            throw Error("Public reordered object incomplete");
          checks.push(
            row.name === t.name,
            (entity === "project"
              ? (row as { folder_id?: string | null }).folder_id
              : (row as { parent_id?: string | null }).parent_id) ===
              t.parent_id,
          );
        }
        return {
          settled: true,
          items: [
            {
              item_key: entity,
              resource: target,
              all_postconditions: checks.every(Boolean),
              some_effects: someEffects,
              evidence: [
                "Independent native cascade/association/order facts and exact public reads determine the result.",
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
        const p = await readWritePolicy(this.directory),
          data = plan.items[0]!.payload as {
            baseline: Snapshot;
            peer: Snapshot | null;
          };
        if (!authorized(p, data.baseline, data.peer ?? undefined)) {
          await record({
            request_key: req.request_key!,
            input_hash: inputHash(req),
            finished: true,
            setter_count: 0,
            resource_id: null,
            error: {
              code: "WRITE_NOT_AUTHORIZED",
              message: "Cascade ownership revoked",
            },
          });
          return;
        }
        const r = await this.native.run("container_lifecycle_apply", {
          request: req,
          plan,
          input_hash: inputHash(req),
          policy: p,
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
