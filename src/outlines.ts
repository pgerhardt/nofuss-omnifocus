import { parseTaskPaper, validateImportNodes } from "./import-outline.js";
import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  canonical,
  inputHash,
  MutationError,
  type MutationRequest,
  type MutationReader,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import { ReadError } from "./contract.js";
import { parseInput, parseNative } from "./errors.js";
import type { NativeWorker } from "./worker.js";
const id = z.string().min(1).max(256);
export const ExportInput = z.union([
  z.object({ project_id: id, format: z.enum(["taskpaper", "opml"]) }).strict(),
  z
    .object({
      project_ids: z
        .array(id)
        .min(1)
        .max(5)
        .refine((x) => new Set(x).size === x.length),
      format: z.enum(["taskpaper", "opml"]),
    })
    .strict(),
  z.object({ folder_id: id, format: z.enum(["taskpaper", "opml"]) }).strict(),
]);
export const ImportInput = z
  .object({
    entity: z.literal("project"),
    project_id: id,
    text: z
      .string()
      .min(1)
      .max(16384)
      .refine((s) => Buffer.byteLength(s) <= 16384),
    format: z.enum(["outline", "taskpaper", "opml"]).default("outline"),
    apply: z.boolean().default(false),
    request_key: id.optional(),
    preconditions: z.array(Fact).max(2).default([]),
  })
  .strict();
const Snapshot = z
  .object({
    id,
    exists: z.literal(true),
    active: z.boolean(),
    repeat: z.boolean(),
    tentative: z.boolean(),
    child_ids: z.array(id).max(200),
    root_id: id,
  })
  .strict();
const Row = z
  .object({
    id,
    parent_id: id.nullable(),
    name: z.string().max(512),
    note: z.string().max(2048),
    flagged: z.boolean(),
    due_at: z.string().datetime().nullable(),
    defer_at: z.string().datetime().nullable(),
    attachments: z.number().int().nonnegative(),
  })
  .strict();
const ExportNative = z
  .object({
    project_id: id,
    root_id: id,
    rows: z.array(Row).min(1).max(200),
    data: z.string().nullable(),
  })
  .strict();
export function parseOutline(text: string) {
  if (Buffer.byteLength(text) > 16384)
    throw new MutationError("INVALID_MUTATION", "Outline exceeds 16 KiB");
  const nodes: { name: string; depth: number; parent: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = /^(\t*)- ([^\u0000-\u001f@]+)$/.exec(line);
    if (
      !m ||
      m[1]!.length > 10 ||
      !m[2]!.trim() ||
      m[2] !== m[2]!.trim() ||
      m[2]!.length > 512 ||
      m[2]!.endsWith(":") ||
      nodes.length >= 20
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Only 1-20 ordinary tab-indented bullets, no metadata/notes",
      );
    const depth = m[1]!.length;
    let parent = -1;
    if (depth) {
      for (let i = nodes.length - 1; i >= 0; i--)
        if (nodes[i]!.depth === depth - 1) {
          parent = i;
          break;
        }
      if (parent < 0 || nodes.at(-1)!.depth < depth - 1)
        throw new MutationError("INVALID_MUTATION", "Skipped outline depth");
    }
    nodes.push({ name: m[2]!, depth, parent });
  }
  if (!nodes.length)
    throw new MutationError("INVALID_MUTATION", "Empty outline");
  return nodes;
}
function xml(s: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s))
    throw new ReadError(
      "UNSUPPORTED_EXPORT",
      "XML-invalid controls in outline text",
    );
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\t", "&#9;");
}
export class Outlines {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  async export(input: unknown) {
    const a = parseInput(ExportInput, input);
    if (!("project_id" in a)) return this.exportSelected(a);
    const r = parseNative(
      ExportNative,
      await this.native.run("outline_export", a),
    );
    if (
      r.project_id !== a.project_id ||
      r.rows[0]!.id !== r.root_id ||
      r.rows[0]!.parent_id !== null ||
      new Set(r.rows.map((t) => t.id)).size !== r.rows.length
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Export identity inventory mismatch",
      );
    let data = r.data;
    const previous = new Set<string>();
    for (const t of r.rows) {
      if (t.parent_id !== null && !previous.has(t.parent_id))
        throw new ReadError(
          "INVALID_NATIVE_OUTPUT",
          "Export parent/preorder mismatch",
        );
      previous.add(t.id);
    }
    if (a.format === "opml") {
      const render = (row: z.infer<typeof Row>): string =>
        '<outline text="' +
        xml(row.name) +
        '" _note="' +
        xml(row.note) +
        '" flagged="' +
        row.flagged +
        '"' +
        (row.due_at ? ' due="' + xml(row.due_at) + '"' : "") +
        (row.defer_at ? ' defer="' + xml(row.defer_at) + '"' : "") +
        ">" +
        r.rows
          .filter((t) => t.parent_id === row.id)
          .map(render)
          .join("") +
        "</outline>";
      data =
        '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>NoFuss outline</title></head><body>' +
        render(r.rows[0]!) +
        "</body></opml>";
    }
    if (typeof data !== "string" || Buffer.byteLength(data) > 24000)
      throw new ReadError(
        "RESPONSE_LIMIT",
        "Complete outline exceeds export byte budget",
      );
    return {
      project_id: a.project_id,
      format: a.format,
      data,
      source_ids: r.rows.map((t) => t.id),
      fidelity:
        a.format === "taskpaper"
          ? "native_taskpaper_text"
          : "nofuss_opml_outline",
      warnings:
        a.format === "taskpaper"
          ? [
              "Native TaskPaper text preserves ordinary nesting, plain notes and supported date/flag annotations. No import/export equivalence for advanced fields is claimed.",
              "Project type/identity, folders, attachment content, alarms, review metadata and custom perspectives are not preserved. Tags/recurrence/estimates/floating/planned dates may be text annotations; their roundtrip is unverified.",
            ]
          : [
              "OPML preserves one project label and task nesting, plain notes, local due/defer dates and flagged values as NoFuss attributes. Consuming applications may ignore attributes.",
              "Persistent identity/project type, folders, tags, estimates, recurrence, alarms, review metadata, custom perspectives and attachments are not preserved.",
            ],
      read_at: new Date().toISOString(),
    };
  }
  private async exportSelected(a: {
    format: "taskpaper" | "opml";
    project_ids?: string[];
    folder_id?: string;
  }) {
    const Folder = z
      .object({
        id,
        name: z.string().max(512),
        parent_id: id.nullable(),
        child_ids: z.array(id).max(25),
      })
      .strict();
    const Project = ExportNative.extend({ folder_id: id.nullable() });
    const r = parseNative(
      z
        .object({
          projects: z.array(Project).max(5),
          folders: z.array(Folder).max(20),
          data: z.string().nullable(),
        })
        .strict(),
      await this.native.run("outline_export", a),
    );
    if (
      a.project_ids &&
      (canonical(r.projects.map((p) => p.project_id)) !==
        canonical(a.project_ids) ||
        r.folders.length)
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Exact selected projects mismatch",
      );
    if (
      a.folder_id &&
      (r.folders[0]?.id !== a.folder_id || r.folders[0].parent_id !== null)
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Exact folder root mismatch",
      );
    const ids = r.projects.flatMap((p) => p.rows.map((t) => t.id));
    if (
      ids.length > 200 ||
      new Set(ids).size !== ids.length ||
      new Set(r.folders.map((f) => f.id)).size !== r.folders.length ||
      new Set(r.projects.map((p) => p.project_id)).size !== r.projects.length
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Selected export identity bound",
      );
    for (const p of r.projects) {
      if (p.rows[0]?.id !== p.root_id || p.rows[0].parent_id !== null)
        throw new ReadError("INVALID_NATIVE_OUTPUT", "Project export root");
      const seen = new Set<string>();
      for (const t of p.rows) {
        if (t.parent_id !== null && !seen.has(t.parent_id))
          throw new ReadError(
            "INVALID_NATIVE_OUTPUT",
            "Export preorder mismatch",
          );
        seen.add(t.id);
      }
    }
    const seenFolders = new Set<string>();
    for (const f of r.folders) {
      if (f.parent_id !== null && !seenFolders.has(f.parent_id))
        throw new ReadError(
          "INVALID_NATIVE_OUTPUT",
          "Folder preorder mismatch",
        );
      seenFolders.add(f.id);
      const kids = [
        ...r.folders.filter((x) => x.parent_id === f.id).map((x) => x.id),
        ...r.projects
          .filter((p) => p.folder_id === f.id)
          .map((p) => p.project_id),
      ];
      if (
        canonical([...kids].sort()) !== canonical([...f.child_ids].sort()) ||
        new Set(f.child_ids).size !== f.child_ids.length
      )
        throw new ReadError(
          "INVALID_NATIVE_OUTPUT",
          "Complete folder membership mismatch",
        );
    }
    if (a.folder_id && r.projects.some((p) => !seenFolders.has(p.folder_id!)))
      throw new ReadError("INVALID_NATIVE_OUTPUT", "Project folder mismatch");
    let data = r.data;
    if (a.format === "opml") {
      const renderProject = (p: z.infer<typeof Project>) => {
        const render = (t: z.infer<typeof Row>): string =>
          '<outline text="' +
          xml(t.name) +
          '" _note="' +
          xml(t.note) +
          '" flagged="' +
          t.flagged +
          '"' +
          (t.due_at ? ' due="' + xml(t.due_at) + '"' : "") +
          (t.defer_at ? ' defer="' + xml(t.defer_at) + '"' : "") +
          ">" +
          p.rows
            .filter((x) => x.parent_id === t.id)
            .map(render)
            .join("") +
          "</outline>";
        return render(p.rows[0]!);
      };
      const renderFolder = (f: z.infer<typeof Folder>): string =>
        '<outline text="' +
        xml(f.name) +
        '" type="nofuss:folder">' +
        f.child_ids
          .map((k) => {
            const folder = r.folders.find((x) => x.id === k);
            if (folder) return renderFolder(folder);
            return renderProject(r.projects.find((x) => x.project_id === k)!);
          })
          .join("") +
        "</outline>";
      data =
        '<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>NoFuss selected outline</title></head><body>' +
        (a.folder_id
          ? renderFolder(r.folders[0]!)
          : r.projects.map(renderProject).join("")) +
        "</body></opml>";
    }
    if (typeof data !== "string" || Buffer.byteLength(data) > 24000)
      throw new ReadError(
        "RESPONSE_LIMIT",
        "Complete selected export exceeds 24 KiB",
      );
    return {
      format: a.format,
      project_ids: r.projects.map((p) => p.project_id),
      folder_ids: r.folders.map((f) => f.id),
      source_ids: ids,
      data,
      fidelity:
        a.format === "taskpaper"
          ? "native_taskpaper_text"
          : "nofuss_opml_outline",
      warnings: [
        "Selected exports are bounded to 5 projects, 20 folders and 200 combined task nodes. Native TaskPaper preserves native text annotations; folder hierarchy is represented only in NoFuss OPML.",
        "Plain notes, nesting, local due/defer and flags survive NoFuss OPML. Persistent identities/project type, tags, estimates, recurrence, floating/planned dates, alarms, review, rich notes, attachments and perspectives do not roundtrip. Folder/project hierarchy import is deliberately unsupported; attributes/types are rejected rather than discarded.",
      ],
      read_at: new Date().toISOString(),
    };
  }
  private async snapshot(ref: { entity: string; id: string }) {
    const r = (await this.native.run("import_facts", { reference: ref })) as {
      reference: unknown;
      facts: unknown;
    };
    if (canonical(r.reference) !== canonical(ref))
      throw Error("Import target mismatch");
    const s = r.facts === null ? null : parseNative(Snapshot, r.facts);
    if (s && s.id !== ref.id)
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Import project ID mismatch",
      );
    return s;
  }
  async import(input: unknown) {
    const p = ImportInput.safeParse(input);
    if (!p.success)
      throw new MutationError("INVALID_MUTATION", "Invalid outline import");
    const a = p.data,
      nodes =
        a.format === "opml"
          ? validateImportNodes(
              await this.native.run("outline_parse_opml", { text: a.text }),
            )
          : a.format === "taskpaper"
            ? parseTaskPaper(a.text)
            : parseOutline(a.text).map((n) => ({
                ...n,
                note: "",
                flagged: false,
                due_at: null,
                defer_at: null,
                estimated_minutes: null,
              })),
      ref = { entity: "project", id: a.project_id };
    if (a.apply && !a.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    if (
      a.preconditions.some(
        (f) =>
          canonical(f.reference) !== canonical(ref) || f.field !== "snapshot",
      )
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Complete exact destination preconditions required",
      );
    const req: MutationRequest = {
      operation: { kind: "project.import_outline", version: 1 },
      ...(a.request_key ? { request_key: a.request_key } : {}),
      items: [
        {
          item_key: "import",
          targets: [ref],
          references: [],
          changes: {
            text: nodes
              .map((n) => "\t".repeat(n.depth) + "- " + n.name)
              .join("\n"),
            nodes,
          },
          preconditions: a.preconditions,
          payload: null,
        },
      ],
    };
    const authorized = (p: WritePolicy | null) =>
        !!p?.scopes.includes("project.import_outline") &&
        p.project_ids.includes(ref.id) &&
        p.allow_inbox,
      policy = await readWritePolicy(this.directory);
    const receiptSchema = z
      .object({
        request_key: id,
        input_hash: z.string(),
        finished: z.literal(true),
        setter_count: z.number().int().min(0).max(102),
        project_id: id,
        roots: z.array(id).max(20),
        inventory: z
          .array(
            z
              .object({ id, name: z.string(), parent_id: id.nullable() })
              .strict(),
          )
          .max(20),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
      })
      .strict();
    const reader: MutationReader = {
      resolve: async (r) => {
        const s = await this.snapshot(r);
        return s ? { reference: r, facts: { snapshot: s } } : null;
      },
      readFact: (f) => this.snapshot(f.reference),
      readback: async (request, plan, raw) => {
        const receipt = receiptSchema.parse(raw);
        if (
          receipt.request_key !== request.request_key ||
          receipt.input_hash !== inputHash(request) ||
          receipt.project_id !== ref.id
        )
          throw Error("Import receipt mismatch");
        const baseline = Snapshot.parse(plan.items[0]!.payload),
          r = (await this.native.run("import_readback", {
            project_id: ref.id,
            ids: receipt.inventory.map((t) => t.id),
          })) as { destination: unknown; items: unknown };
        const after = parseNative(Snapshot, r.destination);
        if (receipt.setter_count === 0 && receipt.error)
          return {
            settled: true,
            not_attempted:
              receipt.error.code === "PRECONDITION_CONFLICT"
                ? "conflict"
                : "rejected",
            error: receipt.error,
            items: [
              {
                item_key: "import",
                all_postconditions: false,
                some_effects: false,
                evidence: [
                  "No import setter acknowledged; separate exact destination read",
                ],
              },
            ],
          };
        const items = parseNative(
          z
            .array(
              z
                .object({
                  id,
                  name: z.string(),
                  parent_id: id.nullable(),
                  project_id: id.nullable(),
                  child_ids: z.array(id),
                  ordinary: z.boolean(),
                  note: z.string(),
                  flagged: z.boolean(),
                  due_at: z.string().datetime().nullable(),
                  defer_at: z.string().datetime().nullable(),
                  estimated_minutes: z.number().nullable(),
                })
                .strict(),
            )
            .max(20),
          r.items,
        );
        if (
          receipt.inventory.length !== nodes.length ||
          items.length !== nodes.length ||
          new Set(items.map((t) => t.id)).size !== nodes.length
        )
          throw Error("Generated complete identity inventory unavailable");
        const expected = nodes.map((n, i) => ({
          ...n,
          id: receipt.inventory[i]!.id,
          parent_id:
            n.parent < 0 ? baseline.root_id : receipt.inventory[n.parent]!.id,
        }));
        const matches = items.every(
          (t, i) =>
            t.id === expected[i]!.id &&
            t.name === expected[i]!.name &&
            t.parent_id === expected[i]!.parent_id &&
            t.project_id === ref.id &&
            t.ordinary &&
            [
              "note",
              "flagged",
              "due_at",
              "defer_at",
              "estimated_minutes",
            ].every(
              (k) =>
                canonical(t[k as keyof typeof t]) ===
                canonical(expected[i]![k as keyof (typeof nodes)[number]]),
            ) &&
            canonical(t.child_ids) ===
              canonical(
                expected.filter((n) => n.parent === i).map((n) => n.id),
              ),
        );
        const roots = expected.filter((n) => n.parent < 0).map((n) => n.id);
        return {
          settled: true,
          items: [
            {
              item_key: "import",
              resource: ref,
              all_postconditions:
                matches &&
                canonical(receipt.roots) === canonical(roots) &&
                !roots.some((id) => baseline.child_ids.includes(id)) &&
                canonical(after) ===
                  canonical({
                    ...baseline,
                    child_ids: [...baseline.child_ids, ...roots],
                  }),
              some_effects: items.length > 0,
              evidence: [
                "Independent exact generated IDs: " +
                  items.map((t) => t.id).join(", "),
                "Separate native evaluation verifies every name/ordinary state, destination, parent and complete child order; no rollback",
              ],
            },
          ],
        };
      },
    };
    const b = new MutationBoundary(
      {
        operation: req.operation,
        validate: (item, resolved) => {
          const s = Snapshot.parse(resolved[0]!.facts.snapshot);
          if (
            s.child_ids.length + nodes.filter((n) => n.parent < 0).length >
              200 ||
            !s.active ||
            s.repeat ||
            s.tentative
          )
            throw new MutationError(
              "INVALID_MUTATION",
              "Ordinary active project required",
            );
          return {
            item_key: item.item_key,
            predicted_changes: { nodes },
            preconditions: [{ reference: ref, field: "snapshot", expected: s }],
            payload: s,
          };
        },
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
              project_id: ref.id,
              roots: [],
              inventory: [],
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Import project/Inbox authority revoked",
              },
            });
            return;
          }
          await record(
            receiptSchema.parse(
              await this.native.run("import_apply", {
                request,
                plan,
                input_hash: inputHash(request),
                authorized_project_ids: current!.project_ids,
                allow_inbox: current!.allow_inbox,
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
      operation: "project.import_outline",
      input_hash: preview.input_hash,
      plan: {
        format: a.format,
        node_count: nodes.length,
        root_count: nodes.filter((n) => n.parent < 0).length,
      },
      apply_input: {
        ...a,
        preconditions: preview.plan.items[0]!.preconditions,
      },
    };
  }
}
