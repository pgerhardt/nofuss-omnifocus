import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWrites } from "../dist/project-writes.js";
import { fixture } from "./project-write-fixture.mjs";
async function setup(t) {
  const f = fixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = new f.Project("base");
  const folder = new f.Folder("folder");
  const policy = {
    schema_version: 1,
    scopes: [
      "project.create",
      "project.update",
      "project.complete",
      "project.drop",
      "project.move",
    ],
    project_ids: [p.id.primaryKey],
    folder_ids: ["folder"],
    allow_project_creation: true,
  };
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify(policy),
    { mode: 0o600 },
  );
  return {
    ...f,
    dir,
    p,
    folder,
    writes: new ProjectWrites(f.native, f.core, dir),
  };
}
test("NATIVE-ALGORITHM DOUBLE: project create identity, exact folder and durable same-key reuse", async (t) => {
  const f = await setup(t);
  const args = {
    entity: "project",
    name: "new",
    folder_id: "folder",
    apply: true,
    request_key: "create",
    type: "sequential",
  };
  const r = await f.writes.execute("project.create", args);
  assert.equal(r.items[0].outcome, "applied");
  const id = r.items[0].resource.id;
  assert.equal(f.projects.get(id).parentFolder, f.folder);
  assert.equal(f.projects.get(id).sequential, true);
  const count = f.projects.size;
  assert.deepEqual(await f.writes.execute("project.create", args), r);
  assert.equal(f.projects.size, count);
  assert.equal(
    (await f.writes.execute("project.create", { ...args, name: "changed" }))
      .error.code,
    "REQUEST_KEY_REUSE_MISMATCH",
  );
});
test("NATIVE-ALGORITHM DOUBLE: merged date request rejects before any setter and preview is read-only", async (t) => {
  const f = await setup(t);
  f.p.dueDate = new Date("2030-01-01Z");
  const count = f.counters.setters;
  const args = {
    entity: "project",
    project_id: f.p.id.primaryKey,
    changes: { defer_at: "2031-01-01T00:00:00Z" },
    apply: true,
    request_key: "invalid",
  };
  const r = await f.writes.execute("project.update", args);
  assert.equal(r.items[0].outcome, "rejected");
  assert.equal(f.counters.setters, count);
  assert.equal(f.p.deferDate, null);
  await f.writes.execute("project.update", {
    ...args,
    apply: false,
    changes: { name: "preview" },
  });
  assert.equal(f.p.name, "base");
});
test("NATIVE-ALGORITHM DOUBLE: move root/folder preserves metadata; update verifies status and type", async (t) => {
  const f = await setup(t),
    project_id = f.p.id.primaryKey;
  for (const folder_id of ["folder", null]) {
    const r = await f.writes.execute("project.move", {
      entity: "project",
      project_id,
      folder_id,
      apply: true,
      request_key: "move-" + folder_id,
    });
    assert.equal(r.items[0].outcome, "applied");
    assert.equal(f.p.parentFolder, folder_id ? f.folder : null);
    assert.equal(f.p.name, "base");
  }
  const r = await f.writes.execute("project.update", {
    entity: "project",
    project_id,
    changes: {
      name: "renamed",
      note: "preserved",
      type: "single_actions",
      status: "on_hold",
      due_at: "2030-02-02T01:02:03.456Z",
    },
    apply: true,
    request_key: "update",
  });
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(f.p.containsSingletonActions, true);
  assert.equal(f.p.status, f.Project.Status.OnHold);
});
test("NATIVE-ALGORITHM DOUBLE: stale preview snapshots conflict and inactive destination has no effects", async (t) => {
  const f = await setup(t);
  const args = {
    entity: "project",
    project_id: f.p.id.primaryKey,
    changes: { name: "new" },
  };
  const preview = await f.writes.execute("project.update", args);
  f.p.note = "external change";
  const r = await f.writes.execute("project.update", {
    ...preview.apply_input,
    apply: true,
    request_key: "stale",
  });
  assert.equal(r.items[0].outcome, "conflict");
  assert.equal(f.p.name, "base");
  f.folder.effectiveActive = false;
  const move = await f.writes.execute("project.move", {
    entity: "project",
    project_id: f.p.id.primaryKey,
    folder_id: "folder",
    apply: true,
    request_key: "inactive",
  });
  assert.equal(move.items[0].outcome, "rejected");
  assert.equal(f.p.parentFolder, null);
});
test("NATIVE-ALGORITHM DOUBLE: repeating project transitions rejected; ordinary completion verified", async (t) => {
  const f = await setup(t),
    args = {
      entity: "project",
      project_id: f.p.id.primaryKey,
      apply: true,
      request_key: "repeat",
    };
  f.p.repetitionRule = {};
  assert.equal(
    (await f.writes.execute("project.complete", args)).items[0].outcome,
    "rejected",
  );
  f.p.repetitionRule = null;
  assert.equal(
    (
      await f.writes.execute("project.complete", {
        ...args,
        request_key: "complete",
      })
    ).items[0].outcome,
    "applied",
  );
  assert.equal(f.p.status, f.Project.Status.Done);
});
