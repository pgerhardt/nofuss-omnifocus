import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
const rule = {
  frequency: "daily",
  interval: 2,
  schedule: "regularly",
  anchor: "due",
  catch_up: true,
};
async function setup(t) {
  const native = taskFixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-recurrence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.update"],
      project_ids: ["project"],
    }),
    { mode: 0o600 },
  );
  native.task.dueDate = new Date("2099-02-02T12:34:56.789Z");
  native.task.deferDate = new Date("2099-02-01T12:34:56.123Z");
  return { native, core: new NoFussCore(native, {}, dir) };
}
test("NATIVE-ALGORITHM DOUBLE: typed recurrence set/replace/clear with independent reads and durable reuse", async (t) => {
  const { native, core } = await setup(t);
  for (const [i, value] of [
    rule,
    {
      ...rule,
      frequency: "weekly",
      schedule: "from_completion",
      anchor: "defer",
      catch_up: false,
    },
    null,
  ].entries()) {
    const args = {
      task_id: "task",
      changes: { recurrence: value },
      apply: true,
      request_key: "rule-" + i,
    };
    const r = await core.mutate("task.update", args);
    assert.equal(r.items[0].outcome, "applied");
    assert.deepEqual(await core.mutate("task.update", args), r);
    assert.deepEqual(
      (await core.get({ ids: ["task"], fields: ["recurrence"] })).results[0]
        .task.recurrence,
      value,
    );
  }
  assert.equal(native.task.repetitionRule, null);
});
test("NATIVE-ALGORITHM DOUBLE: alarm replacement compares semantic multiset, seconds-to-minutes and generated IDs", async (t) => {
  const { native, core } = await setup(t);
  const notifications = [
    { kind: "absolute", fire_at: "2099-02-03T01:02:03.456Z" },
    { kind: "due_relative", relative_offset_minutes: -10 },
  ];
  const result = await core.mutate("task.update", {
    task_id: "task",
    changes: { notifications },
    apply: true,
    request_key: "alarms",
  });
  assert.equal(result.items[0].outcome, "applied");
  assert.equal(native.task.notifications[0].relativeFireOffset, -600);
  const old = native.task.notifications.map((n) => n.id.primaryKey);
  const clear = await core.mutate("task.update", {
    task_id: "task",
    changes: { notifications: [] },
    apply: true,
    request_key: "clear",
  });
  assert.equal(clear.items[0].outcome, "applied");
  assert.deepEqual(native.task.notifications, []);
  assert.equal(old.length, 2);
});
test("NATIVE-ALGORITHM DOUBLE: bad anchors/mixed dates/groups/unsupported shapes reject all fields before first setter", async (t) => {
  for (const changes of [
    { name: "unsafe", recurrence: rule, due_at: null },
    {
      name: "unsafe",
      notifications: [{ kind: "defer_relative", relative_offset_minutes: 1 }],
    },
    { name: "unsafe", recurrence: { ...rule, schedule: "from_completion" } },
    { name: "unsafe", recurrence: rule },
  ]) {
    const { native, core } = await setup(t);
    if (Object.keys(changes).length === 2 && changes.recurrence === rule)
      native.task.dueDate = null;
    native.events.length = 0;
    try {
      const r = await core.mutate("task.update", {
        task_id: "task",
        changes,
        apply: true,
        request_key: "reject",
      });
      assert.equal(r.items[0].outcome, "rejected");
    } catch (e) {
      assert.equal(e.code, "INVALID_MUTATION");
    }
    assert.equal(native.events.length, 0);
    assert.equal(native.task.name, "baseline");
  }
});
test("NATIVE-ALGORITHM DOUBLE: recurrence silent no-op is rejected from independent state, never applied", async (t) => {
  const { native, core } = await setup(t);
  Object.defineProperty(native.task, "repetitionRule", {
    get: () => null,
    set: () => {},
  });
  const r = await core.mutate("task.update", {
    task_id: "task",
    changes: { recurrence: rule },
    apply: true,
    request_key: "noop",
  });
  assert.notEqual(r.items[0].outcome, "applied");
  assert.equal(r.items[0].some_effects, undefined);
});
test("NATIVE-ALGORITHM DOUBLE: generated sibling identity prevents an applied claim", async (t) => {
  const { native, core } = await setup(t);
  let value = null;
  Object.defineProperty(native.task, "repetitionRule", {
    get: () => value,
    set: (v) => {
      value = v;
      native.project.task.tasks.push({
        id: { primaryKey: "unexpected-generated" },
      });
    },
  });
  const r = await core.mutate("task.update", {
    task_id: "task",
    changes: { recurrence: rule },
    apply: true,
    request_key: "generated",
  });
  assert.equal(r.items[0].outcome, "partial");
});
test("NATIVE-ALGORITHM DOUBLE: unsupported recurrence read is explicit unavailable, never null or truncated rule", async (t) => {
  const { native, core } = await setup(t);
  native.task.repetitionRule = {
    ruleString: "FREQ=MONTHLY;BYDAY=MO",
    scheduleType: "Regularly",
    anchorDateKey: "DueDate",
    catchUpAutomatically: false,
  };
  const row = (
    await core.get({ ids: ["task"], fields: ["name", "recurrence"] })
  ).results[0].task;
  assert.equal(row.name, "baseline");
  assert.equal(row.recurrence, undefined);
  assert.equal(row.unavailable.recurrence.code, "RECURRENCE_UNSUPPORTED");
});
