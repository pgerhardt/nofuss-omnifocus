import { z } from "zod";
import { MutationError } from "./mutation-contract.js";
const instant = z
  .string()
  .datetime()
  .refine((s) => new Date(s).toISOString() === s);
export const ImportNode = z
  .object({
    name: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (s) =>
          s === s.trim() && !/[\u0000-\u001f@]/.test(s) && !s.endsWith(":"),
      ),
    depth: z.number().int().min(0).max(10),
    parent: z.number().int().min(-1).max(19),
    note: z
      .string()
      .max(2048)
      .refine(
        (s) => s === s.trim(),
        "Native plain notes trim boundary whitespace",
      )
      .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)),
    flagged: z.boolean(),
    due_at: instant.nullable(),
    defer_at: instant.nullable(),
    estimated_minutes: z.number().int().min(0).max(100000).nullable(),
  })
  .strict();
export type ImportNode = z.infer<typeof ImportNode>;
export function validateImportNodes(value: unknown) {
  const p = z.array(ImportNode).min(1).max(20).safeParse(value);
  if (!p.success)
    throw new MutationError(
      "INVALID_MUTATION",
      "Unsupported bounded import metadata",
    );
  const nodes = p.data;
  nodes.forEach((n, i) => {
    let parent = -1;
    if (n.depth) {
      for (let k = i - 1; k >= 0; k--)
        if (nodes[k]!.depth === n.depth - 1) {
          parent = k;
          break;
        }
      if (parent < 0 || nodes[i - 1]!.depth < n.depth - 1)
        throw new MutationError("INVALID_MUTATION", "Skipped import depth");
    }
    if (n.parent !== parent)
      throw new MutationError("INVALID_MUTATION", "Import parent mismatch");
  });
  return nodes;
}
export function parseTaskPaper(text: string) {
  if (Buffer.byteLength(text) > 16384)
    throw new MutationError("INVALID_MUTATION", "Import exceeds 16 KiB");
  const nodes: ImportNode[] = [];
  const noteLines = new Map<ImportNode, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const bullet = /^(\t*)- (.*)$/.exec(line);
    if (!bullet) {
      const n = nodes.at(-1);
      if (!n || !line.startsWith("\t".repeat(n.depth + 1)))
        throw new MutationError(
          "INVALID_MUTATION",
          "Invalid TaskPaper note indentation",
        );
      const note = line.slice(n.depth + 1);
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note) ||
        note.startsWith("- ")
      )
        throw new MutationError("INVALID_MUTATION", "Ambiguous TaskPaper note");
      const lines = noteLines.get(n) ?? [];
      lines.push(note);
      noteLines.set(n, lines);
      n.note = lines.join("\n");
      continue;
    }
    const depth = bullet[1]!.length,
      raw = bullet[2]!,
      at = raw.indexOf(" @"),
      name = at < 0 ? raw : raw.slice(0, at),
      tail = at < 0 ? "" : raw.slice(at);
    const n: ImportNode = {
        name,
        depth,
        parent: -1,
        note: "",
        flagged: false,
        due_at: null,
        defer_at: null,
        estimated_minutes: null,
      },
      seen = new Set();
    let rest = tail;
    while (rest) {
      const m = /^ @(flagged|due|defer|estimate)(?:\(([^()]*)\))?(?= @|$)/.exec(
        rest,
      );
      if (!m || seen.has(m[1]))
        throw new MutationError(
          "INVALID_MUTATION",
          "Unknown/duplicate TaskPaper annotation",
        );
      seen.add(m[1]);
      if (m[1] === "flagged") {
        if (m[2] !== undefined)
          throw new MutationError(
            "INVALID_MUTATION",
            "Flag annotation has no value",
          );
        n.flagged = true;
      } else if (m[1] === "estimate") {
        if (!/^(0|[1-9]\d*)$/.test(m[2] ?? ""))
          throw new MutationError(
            "INVALID_MUTATION",
            "Estimate requires integer minutes",
          );
        n.estimated_minutes = Number(m[2]);
      } else n[m[1] === "due" ? "due_at" : "defer_at"] = m[2] ?? "";
      rest = rest.slice(m[0].length);
    }
    if (depth) {
      for (let k = nodes.length - 1; k >= 0; k--)
        if (nodes[k]!.depth === depth - 1) {
          n.parent = k;
          break;
        }
    }
    nodes.push(n);
  }
  return validateImportNodes(nodes);
}
