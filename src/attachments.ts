import { z } from "zod";
import { createHash } from "node:crypto";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  canonical,
  inputHash,
  MutationError,
  type Json,
  type Reference,
  type MutationRequest,
  type Planner,
  type MutationReader,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import { ReadError } from "./contract.js";
import { parseInput, parseNative } from "./errors.js";
import { readAttachmentFile } from "./attachment-paths.js";
import type { NativeWorker } from "./worker.js";
const id = z.string().min(1).max(256),
  handle = z.string().regex(/^[a-f0-9]{64}$/);
const target = { entity: z.enum(["task", "project"]), id };
export const AttachmentReadInput = z
  .object({ ...target, handle: handle.optional() })
  .strict();
const opts = {
  apply: z.boolean().default(false),
  request_key: id.optional(),
  preconditions: z.array(Fact).max(2).default([]),
};
const filename = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\/\\\u0000]/.test(s) && s !== "." && s !== "..");
function attach(entity: "task" | "project") {
  return z
    .object({
      ...opts,
      entity: z.literal(entity),
      id,
      path: z.string().min(1).max(4096),
      filename,
    })
    .strict();
}
function detach(entity: "task" | "project") {
  return z.object({ ...opts, entity: z.literal(entity), id, handle }).strict();
}
export const AttachmentInputs = {
  "task.attach": attach("task"),
  "project.attach": attach("project"),
  "task.detach": detach("task"),
  "project.detach": detach("project"),
} as const;
type Scope = keyof typeof AttachmentInputs;
const descriptor = z
  .object({
    filename: z.string().max(512).nullable(),
    type: z.enum(["file", "directory", "symlink", "unknown"]),
    size_bytes: z.number().int().nonnegative().nullable(),
    data: z.string().max(21848).nullable(),
    reference_url: z.string().max(2048).nullable().optional(),
    tree_status: z.enum(["available", "unsupported"]).optional(),
    tree: z
      .array(
        z
          .object({
            names: z.array(z.string().max(128)).min(1).max(4),
            type: z.enum(["file", "directory", "symlink", "unknown"]),
            size_bytes: z.number().int().nonnegative().nullable(),
            reference_url: z.string().max(2048).nullable(),
          })
          .strict(),
      )
      .max(20)
      .nullable()
      .optional(),
  })
  .strict();
const Snapshot = z
  .object({
    id,
    exists: z.literal(true),
    project_id: id.nullable(),
    items: z.array(descriptor).max(20),
  })
  .strict();
type Snapshot = z.infer<typeof Snapshot>;
const Receipt = z
  .object({
    request_key: id,
    input_hash: handle,
    finished: z.literal(true),
    setter_count: z.number().int().min(0).max(1),
    resource_id: id,
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
function contentHandle(w: z.infer<typeof descriptor>) {
  return w.data === null
    ? null
    : createHash("sha256").update(canonical(w)).digest("hex");
}
export class Attachments {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(reference: Reference, strict = false) {
    const r = (await this.native.run("attachment_facts", {
      reference,
      strict,
    })) as { reference: Reference; facts: unknown };
    if (canonical(r.reference) !== canonical(reference))
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Attachment owner association failed",
      );
    if (r.facts === null) return null;
    const s = parseNative(Snapshot, r.facts);
    if (s.id !== reference.id)
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Attachment identity mismatch",
      );
    if (s.items.reduce((n, w) => n + (w.tree?.length ?? 0), 0) > 20)
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Directory inventory metadata bound",
      );
    if (strict && Buffer.byteLength(JSON.stringify(s)) > 30000)
      throw new ReadError(
        "UNSUPPORTED_ATTACHMENT",
        "Complete attachment snapshot exceeds 30000 bytes",
      );
    for (const w of s.items)
      if (
        w.data !== null &&
        (Buffer.from(w.data, "base64").toString("base64") !== w.data ||
          Buffer.from(w.data, "base64").length !== w.size_bytes)
      )
        throw new ReadError(
          "INVALID_NATIVE_OUTPUT",
          "Invalid attachment bytes",
        );
    return s;
  }
  async read(input: unknown) {
    const a = parseInput(AttachmentReadInput, input),
      s = await this.snapshot({ entity: a.entity, id: a.id });
    if (!s) throw new ReadError("NOT_FOUND", "Exact attachment owner absent");
    const items = s.items.map((w) => ({
      filename: w.filename,
      type: w.type,
      size_bytes: w.size_bytes,
      handle: contentHandle(w),
      identity: "content_descriptor" as const,
      ...(w.reference_url !== undefined
        ? { reference_url: w.reference_url }
        : {}),
      ...(w.tree_status ? { tree_status: w.tree_status, tree: w.tree } : {}),
    }));
    if (a.handle) {
      const found = s.items.filter((w) => contentHandle(w) === a.handle);
      if (found.length !== 1)
        throw new ReadError(
          "UNSUPPORTED_ATTACHMENT_IDENTITY",
          "Attachment descriptor is absent or duplicated; no stable occurrence ID",
        );
      return {
        entity: a.entity,
        id: a.id,
        attachment: items.find((w) => w.handle === a.handle)!,
        data_base64: found[0]!.data!,
        read_at: new Date().toISOString(),
      };
    }
    return {
      entity: a.entity,
      id: a.id,
      attachments: items,
      read_at: new Date().toISOString(),
      limitations: [
        "No persistent native occurrence ID; identical descriptors are ambiguous.",
        "Content available only for embedded regular files, 16384 bytes each and 20480 bytes per inventory.",
        "Directories, symlinks and linked external files are never followed.",
      ],
    };
  }
  async execute(scope: Scope, input: unknown) {
    const parsed = AttachmentInputs[scope].safeParse(input);
    if (!parsed.success)
      throw new MutationError("INVALID_MUTATION", "Invalid attachment request");
    const a = parsed.data,
      ref = { entity: a.entity, id: a.id },
      adding = "path" in a;
    if (a.apply && !a.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    if (
      a.preconditions.some(
        (f) =>
          f.field !== "snapshot" || canonical(f.reference) !== canonical(ref),
      )
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Exact owner attachment snapshot required",
      );
    const authorized = (p: WritePolicy | null) =>
      !!p?.scopes.includes(scope) &&
      (a.entity === "project" ? p.project_ids : p.task_ids).includes(a.id);
    let changes: Record<string, Json>;
    if (adding)
      changes = {
        filename: a.filename,
        data: await readAttachmentFile(a.path, this.directory),
      };
    else changes = { handle: a.handle };
    const req: MutationRequest = {
      operation: { kind: scope, version: 1 },
      ...(a.request_key ? { request_key: a.request_key } : {}),
      items: [
        {
          item_key: "attachment",
          targets: [ref],
          references: [],
          changes,
          preconditions: a.preconditions,
          payload: null,
        },
      ],
    };
    const policy = await readWritePolicy(this.directory);
    const planner: Planner = {
      operation: req.operation,
      validate: (item, resolved) => {
        if (a.apply && !authorized(policy))
          throw new MutationError(
            "WRITE_NOT_AUTHORIZED",
            "Exact owner attachment authority required",
          );
        const baseline = resolved[0]!.facts.snapshot as Snapshot;
        const selected = adding
          ? null
          : baseline.items.filter((w) => contentHandle(w) === changes.handle);
        if (selected && selected.length !== 1)
          throw new MutationError(
            "INVALID_MUTATION",
            "Absent/ambiguous attachment content identity",
          );
        const expected = adding
          ? [
              ...baseline.items,
              {
                filename: changes.filename!,
                type: "file",
                size_bytes: Buffer.from(changes.data as string, "base64")
                  .length,
                data: changes.data!,
              },
            ]
          : baseline.items.filter(
              (w) => canonical(w) !== canonical(selected![0]),
            );
        if (
          Buffer.byteLength(JSON.stringify({ ...baseline, items: expected })) >
            30000 ||
          expected.length > 20 ||
          expected.reduce((n, w) => n + (w.size_bytes as number), 0) > 20480
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Attachment mutation exceeds complete-set bounds",
          );
        return {
          item_key: item.item_key,
          predicted_changes: changes,
          preconditions: [
            { reference: ref, field: "snapshot", expected: baseline },
          ],
          payload: { baseline, expected, selected: selected?.[0] ?? null },
        };
      },
    };
    const reader: MutationReader = {
      resolve: async (r) => {
        const s = await this.snapshot(r, true);
        return s ? { reference: r, facts: { snapshot: s } } : null;
      },
      readFact: async (f) => await this.snapshot(f.reference, true),
      readback: async (request, plan, raw) => {
        const receipt = Receipt.parse(raw);
        if (
          receipt.request_key !== request.request_key ||
          receipt.input_hash !== inputHash(request) ||
          receipt.resource_id !== ref.id
        )
          throw Error("Attachment receipt mismatch");
        const after = await this.snapshot(ref, true);
        if (!after) throw Error("Exact owner disappeared");
        const payload = plan.items[0]!.payload as {
          baseline: Snapshot;
          expected: Json;
        };
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
              item_key: "attachment",
              resource: ref,
              all_postconditions:
                canonical(after.items) === canonical(payload.expected) &&
                after.project_id === payload.baseline.project_id,
              some_effects: canonical(after) !== canonical(payload.baseline),
              evidence: [
                "Separate exact-owner native evaluation verifies complete ordered attachment bytes/metadata and project identity",
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
        apply: async (request, plan, record) => {
          const current = await readWritePolicy(this.directory);
          if (!authorized(current)) {
            await record({
              request_key: request.request_key!,
              input_hash: inputHash(request),
              finished: true,
              setter_count: 0,
              resource_id: ref.id,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Host attachment authority revoked",
              },
            });
            return;
          }
          // Re-read authorized file at dispatch; content must still equal the hashed request.
          if (
            adding &&
            (await readAttachmentFile(a.path, this.directory)) !== changes.data
          )
            throw new MutationError(
              "PRECONDITION_CONFLICT",
              "Attachment source changed before apply",
            );
          await record(
            Receipt.parse(
              await this.native.run("attachment_apply", {
                request,
                plan,
                input_hash: inputHash(request),
                authorized_ids:
                  a.entity === "project"
                    ? current!.project_ids
                    : current!.task_ids,
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
    if (a.apply) return boundary.apply(req);
    const preview = await boundary.preview(req);
    const applyInput = {
      ...a,
      preconditions: preview.plan.items[0]!.preconditions,
    };
    // Keep review output bounded: full bytes appear once in exact apply preconditions,
    // while the visible plan describes identity/counts without duplicating content.
    return {
      mode: "preview" as const,
      operation: scope,
      input_hash: preview.input_hash,
      plan: {
        owner: ref,
        operation: adding ? "add" : "remove",
        filename: adding ? a.filename : null,
        handle: adding ? null : a.handle,
      },
      apply_input: applyInput,
      apply_input_hash: inputHash({
        ...req,
        items: [{ ...req.items[0]!, preconditions: applyInput.preconditions }],
      }),
    };
  }
}
