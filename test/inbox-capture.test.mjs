import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { MutationJournal } from "../dist/mutation-journal.js";
import { TaskCreateInput } from "../dist/task-writes.js";
import { taskFixture } from "./task-write-fixture.mjs";
const inbox = { destination: { kind: "inbox" }, name: "capture" };
const parent = {
  destination: { kind: "parent", task_id: "task" },
  name: "child",
};
const basePolicy = {
  schema_version: 1,
  scopes: ["task.create", "task.update"],
  project_ids: ["project"],
  allow_inbox: true,
};
async function setup(t, policy = basePolicy) {
  const dir = await mkdtemp(join(tmpdir(), "nfo38-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const setPolicy = (p) =>
    writeFile(
      join(dir, "mutation-authorization.json"),
      typeof p === "string" ? p : JSON.stringify(p),
      { mode: 0o600 },
    );
  await setPolicy(policy);
  const native = taskFixture();
  return {
    dir,
    native,
    setPolicy,
    core: new NoFussCore(native, {}, dir),
    journal: new MutationJournal(dir),
  };
}
async function result(core, kind, input, key = "case") {
  return core.mutate(kind, { ...input, apply: true, request_key: key });
}
for (const input of [
  { name: "missing" },
  { ...inbox, project_id: "project" },
  { ...parent, project_id: "project" },
  { destination: { kind: "inbox", task_id: "task" }, name: "x" },
  { destination: { kind: "project", project_id: "project" }, name: "x" },
  { destination: { kind: "parent" }, name: "x" },
])
  test(
    "OFFLINE: explicit mutually exclusive create schema " +
      JSON.stringify(input),
    async (t) => {
      const { core, native } = await setup(t);
      assert.equal(TaskCreateInput.safeParse(input).success, false);
      await assert.rejects(result(core, "task.create", input), {
        code: "INVALID_MUTATION",
      });
      assert.deepEqual(native.events, []);
    },
  );
for (const input of [inbox, parent])
  test(
    "NATIVE DOUBLE: direct create preview zero setters, exact identity, hash and reuse " +
      input.destination.kind,
    async (t) => {
      const { core, native, dir, journal } = await setup(t);
      const p = await core.mutate("task.create", {
        ...input,
        due_at: "2099-01-02T12:00:00Z",
        tag_ids: ["tag-a"],
        estimated_minutes: 10,
      });
      assert.deepEqual(native.events, []);
      assert.deepEqual(await readdir(dir), ["mutation-authorization.json"]);
      const applied = await result(core, "task.create", p.apply_input);
      assert.equal(applied.items[0].outcome, "applied");
      assert.equal(applied.input_hash, p.apply_input_hash);
      const created = native.tasks.find(
        (t) => t.id.primaryKey === applied.items[0].resource.id,
      );
      assert.equal(
        created.parent?.id.primaryKey ?? null,
        input === parent ? "task" : null,
      );
      assert.equal(
        created.containingProject?.id.primaryKey ?? null,
        input === parent ? "project" : null,
      );
      const count = native.events.length;
      assert.deepEqual(
        await result(core, "task.create", p.apply_input),
        applied,
      );
      assert.equal(native.events.length, count);
      assert.equal((await journal.read("case")).lifecycle, "finalized");
      assert.equal(await journal.inspectLock(), null);
    },
  );
test("NATIVE DOUBLE: Inbox parent, inherited scheduling and exact Inbox scalar update", async (t) => {
  const { core, native } = await setup(t);
  native.task.parent = null;
  native.task.containingProject = null;
  native.task.dueDate = new Date("2099-02-03T12:00:00Z");
  native.task.deferDate = new Date("2099-02-01T12:00:00Z");
  native.task.plannedDate = new Date("2099-02-02T12:00:00Z");
  const p = await core.mutate("task.create", parent);
  assert.deepEqual(native.events, []);
  const r = await result(core, "task.create", p.apply_input);
  assert.equal(r.items[0].outcome, "applied");
  const child = native.tasks.find(
    (t) => t.id.primaryKey === r.items[0].resource.id,
  );
  assert.equal(child.containingProject, null);
  assert.equal(child.inInbox, false);
  assert.equal(child.dueDate, null);
  assert.equal(
    child.effectiveDueDate.toISOString(),
    "2099-02-03T12:00:00.000Z",
  );
  assert.equal(child.plannedDate, null);
  assert.equal(
    child.effectivePlannedDate.toISOString(),
    "2099-02-02T12:00:00.000Z",
  );
  const before = native.events.length;
  const input = {
    task_id: child.id.primaryKey,
    changes: {
      name: "triaged",
      note: "note",
      flagged: true,
      tag_ids: ["tag-b"],
      due_at: null,
      defer_at: null,
      planned_at: null,
      estimated_minutes: 12,
    },
  };
  const preview = await core.mutate("task.update", input);
  assert.equal(native.events.length, before);
  assert.equal(
    (await result(core, "task.update", preview.apply_input, "update")).items[0]
      .outcome,
    "applied",
  );
});
for (const [name, change] of [
  [
    "completed",
    (n) => {
      n.task.completed = true;
      n.task.completionDate = new Date();
    },
  ],
  ["dropped", (n) => (n.task.dropDate = new Date())],
  ["repeating", (n) => (n.task.repetitionRule = {})],
  ["repeating ancestor", (n) => (n.project.task.repetitionRule = {})],
  ["automatic parent", (n) => (n.task.completedByChildren = true)],
  ["automatic ancestor", (n) => (n.project.task.completedByChildren = true)],
  ["pending assignment", (n) => (n.task.assignedContainer = n.project)],
])
  test("NATIVE DOUBLE: parent rejects before setters " + name, async (t) => {
    const { core, native } = await setup(t);
    change(native);
    await assert.rejects(core.mutate("task.create", parent), {
      code: "INVALID_MUTATION",
    });
    assert.equal(
      (await result(core, "task.create", parent)).items[0].outcome,
      "rejected",
    );
    assert.deepEqual(native.events, []);
  });
for (const id of ["missing", "root", "project", "tag-a"])
  test("NATIVE DOUBLE: exact parent missing/wrong entity " + id, async (t) => {
    const { core, native } = await setup(t);
    assert.equal(
      (
        await result(core, "task.create", {
          ...parent,
          destination: { kind: "parent", task_id: id },
        })
      ).items[0].outcome,
      "rejected",
    );
    assert.deepEqual(native.events, []);
  });
for (const [name, policy, kind, input, inboxTarget] of [
  [
    "project does not grant Inbox",
    { ...basePolicy, allow_inbox: false },
    "task.create",
    inbox,
  ],
  [
    "Inbox does not grant project",
    { ...basePolicy, project_ids: [] },
    "task.create",
    parent,
  ],
  [
    "Inbox does not grant project update",
    { ...basePolicy, project_ids: [] },
    "task.update",
    { task_id: "task", changes: { name: "x" } },
  ],
  [
    "Inbox create scope",
    { ...basePolicy, scopes: ["task.update"] },
    "task.create",
    inbox,
  ],
  [
    "Inbox update scope",
    { ...basePolicy, scopes: ["task.create"] },
    "task.update",
    { task_id: "task", changes: { name: "x" } },
    true,
  ],
  [
    "project does not grant Inbox update",
    { ...basePolicy, allow_inbox: false },
    "task.update",
    { task_id: "task", changes: { name: "x" } },
    true,
  ],
  [
    "nested Inbox needs Inbox permission",
    { ...basePolicy, allow_inbox: false },
    "task.create",
    parent,
    true,
  ],
  [
    "malformed Inbox permission",
    { ...basePolicy, allow_inbox: "true" },
    "task.create",
    inbox,
  ],
  [
    "Inbox recurrence excluded",
    basePolicy,
    "task.update",
    { task_id: "task", changes: { recurrence: null } },
    true,
  ],
])
  test("OFFLINE/NATIVE DOUBLE: authorization " + name, async (t) => {
    const { core, native } = await setup(t, policy);
    if (inboxTarget) {
      native.task.parent = null;
      native.task.containingProject = null;
    }
    assert.equal(
      (await result(core, kind, input)).items[0].outcome,
      "rejected",
    );
    assert.deepEqual(native.events, []);
  });
for (const moment of ["after-preview", "native-recheck"])
  for (const change of [
    "parent moved",
    "parent completed",
    "ancestor date changed",
    "Inbox moved",
    "Inbox field changed",
  ])
    test("NATIVE DOUBLE: stale facts " + moment + " " + change, async (t) => {
      const { core, native } = await setup(t);
      const isUpdate = change.startsWith("Inbox");
      if (isUpdate) {
        native.task.parent = null;
        native.task.containingProject = null;
      }
      const input = isUpdate
        ? { task_id: "task", changes: { name: "x" } }
        : parent;
      const kind = isUpdate ? "task.update" : "task.create";
      const p = await core.mutate(kind, input);
      const alter = () => {
        if (change.includes("moved")) {
          native.task.parent = isUpdate ? native.project.task : null;
          native.task.containingProject = isUpdate ? native.project : null;
        }
        if (change.includes("completed")) {
          native.task.completed = true;
          native.task.completionDate = new Date();
        }
        if (change.includes("date"))
          native.project.task.dueDate = new Date("2099-02-01T00:00:00Z");
        if (change.includes("field")) native.task._name = "external";
      };
      if (moment === "after-preview") alter();
      else native.beforeApply = alter;
      const r = await result(core, kind, p.apply_input);
      assert.ok(["conflict", "rejected"].includes(r.items[0].outcome));
      assert.deepEqual(native.events, []);
    });
test("NATIVE DOUBLE: revoked Inbox authorization immediately before dispatch", async (t) => {
  const { core, native, setPolicy } = await setup(t);
  const run = native.run;
  native.run = async (op, args) => {
    const r = await run(op, args);
    if (op === "task_write_facts")
      await setPolicy({ ...basePolicy, allow_inbox: false });
    return r;
  };
  assert.equal(
    (await result(core, "task.create", inbox)).items[0].outcome,
    "rejected",
  );
  assert.deepEqual(native.events, []);
});
for (const input of [inbox, parent])
  test(
    "NATIVE DOUBLE: lost direct create ID unknown/no replay " +
      input.destination.kind,
    async (t) => {
      const { core, native, journal } = await setup(t);
      native.loseResponse = true;
      assert.equal(
        (await result(core, "task.create", input)).items[0].outcome,
        "unknown",
      );
      const count = native.events.length;
      assert.equal(
        (await result(core, "task.create", input)).items[0].outcome,
        "unknown",
      );
      assert.equal(native.events.length, count);
      assert.ok(await journal.inspectLock());
    },
  );
