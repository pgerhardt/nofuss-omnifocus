import { createHash } from "node:crypto";
import { z } from "zod";
import {
  API_VERSION,
  ReadError,
  selectedFields,
  treeFields,
  TREE_ORDER,
  type GetArgs,
  type QueryArgs,
} from "./contract.js";
export const Key = z
  .object({
    created_at: z.string().datetime().nullable(),
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
export type PageKey = z.infer<typeof Key>;
const TreeKey = Key.pick({ id: true });
export type TreePageKey = z.infer<typeof TreeKey>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function queryHash(args: QueryArgs): string {
  return hash(
    JSON.stringify({
      version: API_VERSION,
      entity: args.entity,
      scope: args.scope,
      ...(args.scope === "project"
        ? { project_id: args.project_id, depth: args.depth ?? "descendants" }
        : {}),
      ...(args.entity === "project"
        ? { status: args.status, flagged: args.flagged }
        : { include_completed: args.include_completed ?? false }),
      sort: args.sort,
      limit: args.limit,
      view: args.view,
      fields: selectedFields(args),
    }),
  );
}
export function treeHash(args: GetArgs): string {
  if (!args.tree)
    throw new ReadError("INVALID_TREE", "Tree options are required.");
  return hash(
    JSON.stringify({
      version: API_VERSION,
      operation: "project_tree",
      project_id: args.ids[0],
      order: TREE_ORDER,
      view: args.tree.view,
      fields: treeFields(args.tree),
      limit: args.tree.limit,
      project_view: args.view,
      project_fields: selectedFields(args),
      text: args.text
        ? { ...args.text, length: args.text.length ?? 2048 }
        : undefined,
      collection: args.collection,
    }),
  );
}
export function encodeCursor(
  query: string,
  after: PageKey | TreePageKey | FieldKey,
): string {
  const body = { v: API_VERSION, query, after };
  return Buffer.from(
    JSON.stringify({ ...body, checksum: hash(JSON.stringify(body)) }),
  ).toString("base64url");
}
export function decodeCursor(
  cursor: string | undefined,
  query: string,
): PageKey | null {
  return decodeBoundCursor(cursor, query, Key);
}
export function decodeTreeCursor(
  cursor: string | undefined,
  query: string,
): TreePageKey | null {
  return decodeBoundCursor(cursor, query, TreeKey);
}
function decodeBoundCursor<T>(
  cursor: string | undefined,
  query: string,
  key: z.ZodType<T>,
): T | null {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw Error();
    const c = z
      .object({
        v: z.literal(API_VERSION),
        query: z.string(),
        after: key,
        checksum: z.string(),
      })
      .strict()
      .parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    const { checksum, ...body } = c;
    if (checksum !== hash(JSON.stringify(body))) throw Error();
    if (c.query !== query)
      throw new ReadError(
        "CURSOR_QUERY_MISMATCH",
        "Cursor belongs to another query or projection. Restart this traversal.",
      );
    return c.after;
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError(
      "INVALID_CURSOR",
      "Cursor is malformed, damaged or from another schema version.",
    );
  }
}

// Field cursors can move from a query/tree record to its exact get. They bind
// ownership, field, units/order and window size, not unrelated record fields.
const FieldKey = z
  .object({
    offset: z.number().int().positive(),
    limit: z.number().int().min(1).max(2048),
  })
  .strict();
type FieldKey = z.infer<typeof FieldKey>;
export function fieldHash(
  entity: "task" | "project",
  id: string,
  field: string,
): string {
  return hash(
    JSON.stringify({
      version: API_VERSION,
      operation: "field_window",
      entity,
      id,
      field,
      order:
        field === "name" || field === "note"
          ? "unicode_codepoints_v1"
          : "native_elements_v1",
    }),
  );
}
export function decodeFieldCursor(
  cursor: string | undefined,
  owner: string,
  limit?: number,
  maximum = 2048,
): FieldKey | null {
  const key = decodeBoundCursor(cursor, owner, FieldKey);
  if (key && key.limit > maximum)
    throw new ReadError(
      "INVALID_CURSOR",
      "Field cursor window size exceeds this field limit.",
    );
  if (key && limit !== undefined && key.limit !== limit)
    throw new ReadError(
      "CURSOR_QUERY_MISMATCH",
      "Field cursor window size differs. Restart this field traversal.",
    );
  return key;
}
