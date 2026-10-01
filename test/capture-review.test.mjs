import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
for (const kind of ["task.create", "task.update"])
  for (const where of ["target", "ancestor"])
    for (const moment of ["preview", "native-recheck"])
      test(`REVIEW REGRESSION: ${kind} rejects tentative ${where} containment at ${moment}`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "nfo-capture-review-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        await writeFile(
          join(dir, "mutation-authorization.json"),
          JSON.stringify({
            schema_version: 1,
            scopes: ["task.create", "task.update"],
            project_ids: ["project"],
            allow_inbox: true,
          }),
          { mode: 0o600 },
        );
        const native = taskFixture();
        const core = new NoFussCore(native, {}, dir);
        // Reuse only double objects as a nested Inbox chain.
        native.project.task.project = null;
        native.project.task.containingProject = null;
        native.task.containingProject = null;
        const input =
          kind === "task.create"
            ? {
                name: "child",
                destination: { kind: "parent", task_id: "task" },
              }
            : { task_id: "task", changes: { name: "unsafe" } };
        const change = () => {
          (where === "target"
            ? native.task
            : native.project.task
          ).assignedContainer = native.project;
        };
        if (moment === "preview") {
          change();
          await assert.rejects(core.mutate(kind, input), {
            code: "INVALID_MUTATION",
          });
        } else {
          const p = await core.mutate(kind, input);
          native.beforeApply = change;
          const r = await core.mutate(kind, {
            ...p.apply_input,
            apply: true,
            request_key: "race",
          });
          assert.ok(["rejected", "conflict"].includes(r.items[0].outcome));
        }
        assert.deepEqual(native.events, []);
      });
