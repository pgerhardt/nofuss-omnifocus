import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
async function setup(t, task_ids = ["task"]) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-move-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.move"],
      project_ids: ["project"],
      task_ids,
    }),
    { mode: 0o600 },
  );
  const native = taskFixture();
  return { native, core: new NoFussCore(native, {}, dir) };
}
test("NATIVE-ALGORITHM DOUBLE: project / parent / Inbox move readback, preserve fields and durable reuse", async (t) => {
  const { native, core } = await setup(t);
  const parent = new native.task.constructor("parent", native.project);
  for (const destination of [
    { kind: "parent", task_id: parent.id.primaryKey },
    { kind: "project", project_id: "project" },
    { kind: "inbox" },
    { kind: "project", project_id: "project" },
  ]) {
    const input = {
      task_id: "task",
      destination,
      apply: true,
      request_key: "move" + JSON.stringify(destination) + native.events.length,
    };
    const result = await core.mutate("task.move", input);
    assert.equal(result.items[0].outcome, "applied");
    const before = native.events.length;
    assert.deepEqual(await core.mutate("task.move", input), result);
    assert.equal(native.events.length, before);
    assert.equal(native.task.name, "baseline");
    assert.equal(
      native.task.parent,
      destination.kind === "inbox"
        ? null
        : destination.kind === "parent"
          ? parent
          : native.project.task,
    );
  }
});
test("NATIVE-ALGORITHM DOUBLE: self / descendant cycle, inactive destination, invalid parent reject before setters", async (t) => {
  const { native, core } = await setup(t);
  const child = new native.task.constructor("child", native.project);
  child.parent = native.task;
  native.task.tasks.push(child);
  native.events.length = 0;
  for (const task_id of ["task", child.id.primaryKey]) {
    const result = await core.mutate("task.move", {
      task_id: "task",
      destination: { kind: "parent", task_id },
      apply: true,
      request_key: "cycle" + task_id,
    });
    assert.equal(result.items[0].outcome, "rejected");
    assert.deepEqual(native.events, []);
  }
  child.parent = native.project.task;
  native.task.tasks = [];
  child.completed = true;
  let result = await core.mutate("task.move", {
    task_id: "task",
    destination: { kind: "parent", task_id: child.id.primaryKey },
    apply: true,
    request_key: "completed",
  });
  assert.equal(result.items[0].outcome, "rejected");
  assert.deepEqual(native.events, []);
  native.project.status = "OnHold";
  result = await core.mutate("task.move", {
    task_id: "task",
    destination: { kind: "project", project_id: "project" },
    apply: true,
    request_key: "inactive",
  });
  assert.equal(result.items[0].outcome, "rejected");
  assert.deepEqual(native.events, []);
});
test("NATIVE-ALGORITHM DOUBLE: Inbox task requires explicit exact task authorization", async (t) => {
  const { native, core } = await setup(t, []);
  native.task.parent = null;
  native.task.containingProject = null;
  native.events.length = 0;
  const result = await core.mutate("task.move", {
    task_id: "task",
    destination: { kind: "project", project_id: "project" },
    apply: true,
    request_key: "denied",
  });
  assert.equal(result.items[0].outcome, "rejected");
  assert.equal(result.error.code, "WRITE_NOT_AUTHORIZED");
  assert.deepEqual(native.events, []);
});
