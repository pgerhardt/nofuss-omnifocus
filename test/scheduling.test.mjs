import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-scheduling-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.create", "task.update"],
      project_ids: ["project"],
    }),
    { mode: 0o600 },
  );
  const native = taskFixture();
  return { native, core: new NoFussCore(native, {}, dir) };
}
const due = "2099-03-03T12:34:56.789Z";
const defer = "2099-03-02T12:34:56.123Z";
test("NATIVE-ALGORITHM DOUBLE: scheduling create/change/clear, fractional precision, zero estimate and durable retry", async (t) => {
  const { native, core } = await setup(t);
  const created = await core.mutate("task.create", {
    project_id: "project",
    name: "scheduled",
    due_at: due,
    defer_at: defer,
    planned_at: defer,
    estimated_minutes: 0,
    apply: true,
    request_key: "create",
  });
  assert.equal(created.items[0].outcome, "applied");
  const id = created.items[0].resource.id;
  for (const [key, changes] of [
    [
      "change",
      {
        due_at: "2099-03-05T00:00:00Z",
        defer_at: "2099-03-04T00:00:00Z",
        planned_at: due,
        estimated_minutes: 1,
      },
    ],
    [
      "clear",
      {
        due_at: null,
        defer_at: null,
        planned_at: null,
        estimated_minutes: null,
      },
    ],
  ]) {
    const input = { task_id: id, changes, apply: true, request_key: key };
    const result = await core.mutate("task.update", input);
    assert.equal(result.items[0].outcome, "applied");
    const before = native.events.length;
    assert.deepEqual(await core.mutate("task.update", input), result);
    assert.equal(native.events.length, before);
  }
  const task = native.tasks.find((t) => t.id.primaryKey === id);
  assert.equal(task.dueDate, null);
  assert.equal(task.deferDate, null);
  assert.equal(task.plannedDate, null);
  assert.equal(task.estimatedMinutes, null);
});
test("NATIVE-ALGORITHM DOUBLE: whole scheduling request rejects before setters; merged pair and native race", async (t) => {
  const { native, core } = await setup(t);
  for (const changes of [
    { estimated_minutes: -1 },
    { estimated_minutes: 1.25 },
    { due_at: "tomorrow" },
  ]) {
    await assert.rejects(
      core.mutate("task.update", {
        task_id: "task",
        changes,
        apply: true,
        request_key: "invalid",
      }),
      { code: "INVALID_MUTATION" },
    );
    assert.deepEqual(native.events, []);
  }
  for (const changes of [{ due_at: defer, defer_at: due }]) {
    const result = await core.mutate("task.update", {
      task_id: "task",
      changes,
      apply: true,
      request_key: JSON.stringify(changes),
    });
    assert.equal(result.items[0].outcome, "rejected");
    assert.deepEqual(native.events, []);
  }
  native.task.deferDate = new Date(due);
  const invalid = await core.mutate("task.update", {
    task_id: "task",
    changes: { due_at: defer },
    apply: true,
    request_key: "merged",
  });
  assert.equal(invalid.items[0].outcome, "rejected");
  assert.deepEqual(native.events, []);
  native.task.deferDate = null;
  const preview = await core.mutate("task.update", {
    task_id: "task",
    changes: { due_at: due },
  });
  native.beforeApply = () => {
    native.task.deferDate = new Date(defer);
  };
  const race = await core.mutate("task.update", {
    ...preview.apply_input,
    apply: true,
    request_key: "race",
  });
  assert.equal(race.items[0].outcome, "conflict");
  assert.deepEqual(native.events, []);
});
