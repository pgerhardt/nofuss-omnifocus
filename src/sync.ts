import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  inputHash,
  canonical,
  MutationError,
  type MutationRequest,
  type MutationReader,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import { parseInput, parseNative } from "./errors.js";
import type { NativeWorker } from "./worker.js";
const id = z.string().min(1).max(256);
export const SyncInput = z.object({}).strict();
export const SyncTriggerInput = z
  .object({
    entity: z.literal("sync"),
    document_id: id,
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(2).default([]),
  })
  .strict();
export const SyncOutput = z
  .object({
    document_id: id,
    syncing: z.boolean().nullable(),
    last_sync_date: z.string().datetime().nullable(),
    last_sync_error: z.object({ present: z.boolean() }).nullable(),
    unavailable: z.array(
      z.enum(["syncing", "last_sync_date", "last_sync_error"]),
    ),
    observed_at: z.string().datetime(),
    sync_completion: z.literal("unavailable"),
    last_attempted_sync: z.literal("unavailable"),
    last_successful_sync: z.literal("unavailable"),
    pending_local_changes: z.literal("unavailable"),
    remote_acknowledgement: z.literal("unavailable"),
  })
  .strict();
const Receipt = z
  .object({
    request_key: id,
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().min(0).max(1),
    document_id: id.nullable(),
    accepted: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class Sync {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  async read(input: unknown) {
    parseInput(SyncInput, input);
    return parseNative(SyncOutput, await this.native.run("sync_facts", {}));
  }
  async trigger(input: unknown) {
    const p = SyncTriggerInput.safeParse(input);
    if (!p.success)
      throw new MutationError(
        "INVALID_MUTATION",
        "Invalid sync trigger request",
      );
    const a = p.data,
      ref = { entity: "document", id: a.document_id };
    if (a.apply && !a.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    if (
      a.preconditions.some(
        (f) =>
          canonical(f.reference) !== canonical(ref) ||
          f.field !== "document_id" ||
          f.expected !== a.document_id,
      )
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Exact default document identity required",
      );
    const req: MutationRequest = {
      operation: { kind: "sync.trigger", version: 1 },
      ...(a.request_key ? { request_key: a.request_key } : {}),
      items: [
        {
          item_key: "sync",
          targets: [ref],
          references: [],
          changes: { request_sync: true },
          preconditions: a.preconditions,
          payload: null,
        },
      ],
    };
    const authorized = (p: WritePolicy | null) =>
      !!p?.scopes.includes("sync.trigger") && p.allow_sync;
    const policy = await readWritePolicy(this.directory);
    const reader: MutationReader = {
      resolve: async (r) => {
        const s = await this.read({});
        return s.document_id === r.id
          ? { reference: r, facts: { document_id: s.document_id } }
          : null;
      },
      readFact: async () => (await this.read({})).document_id,
      readback: async (request, _plan, raw) => {
        const receipt = Receipt.parse(raw),
          s = await this.read({});
        if (
          receipt.request_key !== request.request_key ||
          receipt.input_hash !== inputHash(request) ||
          receipt.document_id !== s.document_id ||
          s.document_id !== ref.id
        )
          throw Error("Sync dispatch association unavailable");
        const notAttempted = receipt.setter_count === 0 && receipt.error;
        return {
          settled: true,
          ...(notAttempted
            ? {
                not_attempted:
                  receipt.error!.code === "PRECONDITION_CONFLICT"
                    ? ("conflict" as const)
                    : ("rejected" as const),
                error: receipt.error!,
              }
            : {}),
          items: [
            {
              item_key: "sync",
              resource: ref,
              all_postconditions:
                receipt.setter_count === 1 &&
                receipt.accepted &&
                !receipt.error,
              some_effects: false,
              evidence: [
                "Sync trigger acceptance requires completed native dispatch receipt plus separate exact default-document observation. Remote completion, successful sync and other-device state remain unavailable.",
              ],
            },
          ],
        };
      },
    };
    const b = new MutationBoundary(
      {
        operation: req.operation,
        validate: (item) => ({
          item_key: item.item_key,
          predicted_changes: {
            trigger: "accepted_only",
            sync_completion: "unavailable",
          },
          preconditions: [
            { reference: ref, field: "document_id", expected: ref.id },
          ],
          payload: null,
        }),
      },
      reader,
      {
        apply: async (request, plan, record) => {
          const current = await readWritePolicy(this.directory);
          if (!authorized(current)) {
            await record({
              request_key: request.request_key!,
              input_hash: inputHash(request),
              finished: true,
              setter_count: 0,
              document_id: ref.id,
              accepted: false,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Host sync authority revoked",
              },
            });
            return;
          }
          await record(
            Receipt.parse(
              await this.native.run("sync_apply", {
                request,
                plan,
                input_hash: inputHash(request),
                allow_sync: current!.allow_sync,
              }),
            ),
          );
        },
      },
      new MutationJournal(this.directory),
      {
        mode: a.apply
          ? authorized(policy)
            ? "apply-authorized"
            : "read-only"
          : "preview-authorized",
      },
    );
    if (a.apply) return b.apply(req);
    const preview = await b.preview(req);
    return {
      mode: "preview" as const,
      operation: "sync.trigger",
      ...preview,
      apply_input: {
        ...a,
        preconditions: preview.plan.items[0]!.preconditions,
      },
    };
  }
}
