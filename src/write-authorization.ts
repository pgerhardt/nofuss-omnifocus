import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "./mutation-journal.js";
export const WRITE_SCOPES = [
  "task.create",
  "task.update",
  "task.complete",
  "task.move",
  "task.drop",
  "task.duplicate",
  "task.delete",
  "task.batch",
  "project.create",
  "project.update",
  "project.complete",
  "project.drop",
  "project.move",
  "project.set_review_interval",
  "project.mark_reviewed",
  "tag.create",
  "tag.update",
  "tag.move",
  "folder.create",
  "folder.update",
  "folder.move",
] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];
const policySchema = z
  .object({
    schema_version: z.literal(1),
    scopes: z.array(z.enum(WRITE_SCOPES)).max(WRITE_SCOPES.length),
    project_ids: z.array(z.string().min(1).max(256)).max(100),
    task_ids: z.array(z.string().min(1).max(256)).max(100).default([]),
    folder_ids: z.array(z.string().min(1).max(256)).max(100).default([]),
    allow_inbox: z.boolean().default(false),
    allow_project_creation: z.boolean().default(false),
    tag_ids: z.array(z.string().min(1).max(256)).max(100).default([]),
    allow_tag_creation: z.boolean().default(false),
    allow_folder_creation: z.boolean().default(false),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.scopes).size === p.scopes.length &&
      new Set(p.project_ids).size === p.project_ids.length &&
      new Set(p.task_ids).size === p.task_ids.length &&
      new Set(p.folder_ids).size === p.folder_ids.length &&
      new Set(p.tag_ids).size === p.tag_ids.length,
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

// One catalog/readiness decision; per-operation target authorization still runs
// independently at preflight and dispatch.
export function enabledWriteScopes(policy: WritePolicy | null): WriteScope[] {
  return WRITE_SCOPES.filter((scope) => {
    if (!policy?.scopes.includes(scope)) return false;
    if (scope === "task.batch")
      return (
        ["task.create", "task.update", "task.move", "task.complete"].some((s) =>
          policy.scopes.includes(s as WriteScope),
        ) &&
        (policy.project_ids.length > 0 ||
          (policy.allow_inbox &&
            ["task.create", "task.update"].some((s) =>
              policy.scopes.includes(s as WriteScope),
            )) ||
          (policy.task_ids.length > 0 && policy.scopes.includes("task.move")))
      );
    if (scope.startsWith("tag."))
      return scope === "tag.create"
        ? policy.allow_tag_creation
        : policy.tag_ids.length > 0;
    if (scope.startsWith("folder."))
      return scope === "folder.create"
        ? policy.allow_folder_creation
        : policy.folder_ids.length > 0;
    if (scope.startsWith("project."))
      return scope === "project.create"
        ? policy.allow_project_creation
        : policy.project_ids.length > 0;
    return (
      policy.project_ids.length > 0 ||
      (["task.create", "task.update"].includes(scope) && policy.allow_inbox) ||
      (["task.move", "task.drop", "task.duplicate", "task.delete"].includes(
        scope,
      ) &&
        policy.task_ids.length > 0)
    );
  });
}
