import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
async function setup(
  t,
  scopes = ["task.drop", "task.duplicate", "task.delete"],
) {
  const native = taskFixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-task-life-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({ schema_version: 1, scopes, project_ids: ["project"] }),
    { mode: 0o600 },
  );
  return { native, core: new NoFussCore(native, {}, dir) };
}
test("NATIVE-ALGORITHM DOUBLE: ordinary leaf drop has native date/status readback and durable reuse", async (t) => {
  const { native, core } = await setup(t),
    args = { task_id: "task", apply: true, request_key: "drop" };
  const r = await core.mutate("task.drop", args);
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(native.task.active, false);
  assert.ok(native.task.dropDate);
  assert.equal(native.task.name, "baseline");
  const n = native.events.length;
  assert.deepEqual(await core.mutate("task.drop", args), r);
  assert.equal(native.events.length, n);
});
test("NATIVE-ALGORITHM DOUBLE: duplicate generated identity preserves original and copied fields", async (t) => {
  const { native, core } = await setup(t);
  native.task.note = "copy me";
  native.task.dueDate = new Date("2099-01-01T12:34:56.789Z");
  native.events.length = 0;
  const r = await core.mutate("task.duplicate", {
    task_id: "task",
    apply: true,
    request_key: "duplicate",
  });
  assert.equal(r.items[0].outcome, "applied");
  const copy = native.tasks.find(
    (t) => t.id.primaryKey === r.items[0].resource.id,
  );
  assert.notEqual(copy, native.task);
  assert.equal(copy.note, native.task.note);
  assert.equal(copy.dueDate.toISOString(), native.task.dueDate.toISOString());
  assert.equal(copy.parent, native.task.parent);
  assert.equal(native.task.name, "baseline");
});
test("NATIVE-ALGORITHM DOUBLE: exact delete absence, unchanged siblings, retry never replays", async (t) => {
  const { native, core } = await setup(t);
  const sibling = native.tasks.find((t) => t.project !== null);
  const args = { task_id: "task", apply: true, request_key: "delete" };
  const r = await core.mutate("task.delete", args);
  assert.equal(r.items[0].outcome, "applied");
  assert.ok(!native.tasks.includes(native.task));
  assert.ok(native.tasks.includes(sibling));
  const n = native.events.length;
  assert.deepEqual(await core.mutate("task.delete", args), r);
  assert.equal(native.events.length, n);
});
test("NATIVE-ALGORITHM DOUBLE: groups/repeating/automatic ancestors and copy attachments/notifications reject before setter", async (t) => {
  for (const shape of [
    "group",
    "repeat",
    "automatic",
    "attachment",
    "notification",
  ]) {
    const { native, core } = await setup(t);
    if (shape === "group")
      native.task.tasks.push({ id: { primaryKey: "child" } });
    if (shape === "repeat") native.task.repetitionRule = {};
    if (shape === "automatic") native.project.task.completedByChildren = true;
    if (shape === "attachment") native.task.attachments.push({});
    if (shape === "notification")
      native.task.notifications.push({ id: { primaryKey: "alarm" } });
    native.events.length = 0;
    const result = await core.mutate("task.duplicate", {
      task_id: "task",
      apply: true,
      request_key: shape,
    });
    assert.equal(result.items[0].outcome, "rejected");
    assert.equal(native.events.length, 0);
  }
});
test("NATIVE-ALGORITHM DOUBLE: hard delete requires its own scope and root task cannot be targeted", async (t) => {
  const { native, core } = await setup(t, ["task.drop"]);
  const rejected = await core.mutate("task.delete", {
    task_id: "task",
    apply: true,
    request_key: "denied",
  });
  assert.equal(rejected.error.code, "WRITE_NOT_AUTHORIZED");
  const wrong = await core.mutate("task.drop", {
    task_id: "root",
    apply: true,
    request_key: "root",
  });
  assert.equal(wrong.items[0].outcome, "rejected");
  assert.equal(native.events.length, 0);
});
