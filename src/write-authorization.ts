import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "./mutation-journal.js";
export const WRITE_SCOPES = [
  "task.create",
  "task.update",
  "task.complete",
] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];
const policySchema = z
  .object({
    schema_version: z.literal(1),
    scopes: z.array(z.enum(WRITE_SCOPES)).max(3),
    project_ids: z.array(z.string().min(1).max(256)).max(100),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.scopes).size === p.scopes.length &&
      new Set(p.project_ids).size === p.project_ids.length,
  );
export type WritePolicy = z.infer<typeof policySchema>;
export async function readWritePolicy(
  directory = stateDirectory(),
): Promise<WritePolicy | null> {
  try {
    const dir = await lstat(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== process.getuid?.() ||
      (dir.mode & 0o777) !== 0o700
    )
      return null;
    const fd = await open(
      join(directory, "mutation-authorization.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await fd.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 16384
      )
        return null;
      return policySchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(await fd.readFile()),
        ),
      );
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}
