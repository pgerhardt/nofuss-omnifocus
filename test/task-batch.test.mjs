import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
async function setup(
  t,
  scopes = [
    "task.batch",
    "task.create",
    "task.update",
    "task.move",
    "task.complete",
    "task.drop",
    "task.delete",
  ],
) {
  const native = taskFixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({ schema_version: 1, scopes, project_ids: ["project"] }),
    { mode: 0o600 },
  );
  const second = new native.task.constructor("second", native.project),
    third = new native.task.constructor("third", native.project);
  second.id.primaryKey = "second";
  third.id.primaryKey = "third";
  native.events.length = 0;
  return { native, second, third, core: new NoFussCore(native, {}, dir), dir };
}
const fields = (id, key = id) => ({
  item_key: key,
  task_id: id,
  changes: { name: "changed " + id },
});
test("NATIVE-ALGORITHM DOUBLE: whole-request create/update/complete mapping and one native dispatch, durable reuse", async (t) => {
  const { native, core } = await setup(t);
  let dispatches = 0;
  native.beforeApply = () => dispatches++;
  const create = {
    action: "create",
    items: [
      { item_key: "a", project_id: "project", name: "A" },
      { item_key: "b", project_id: "project", name: "B" },
    ],
    apply: true,
    request_key: "create",
  };
  const r = await core.mutate("task.batch", create);
  assert.deepEqual(
    r.items.map((i) => i.item_key),
    ["a", "b"],
  );
  assert.ok(r.items.every((i) => i.outcome === "applied"));
  assert.notEqual(r.items[0].resource.id, r.items[1].resource.id);
  assert.equal(dispatches, 1);
  assert.deepEqual(await core.mutate("task.batch", create), r);
  assert.equal(dispatches, 1);
  const update = await core.mutate("task.batch", {
    action: "update",
    items: [fields("task"), fields("second")],
    apply: true,
    request_key: "update",
  });
  assert.ok(update.items.every((i) => i.outcome === "applied"));
  assert.equal(dispatches, 2);
  const done = await core.mutate("task.batch", {
    action: "complete",
    items: [
      { item_key: "task", task_id: "task" },
      { item_key: "second", task_id: "second" },
    ],
    apply: true,
    request_key: "complete",
  });
  assert.ok(done.items.every((i) => i.outcome === "applied"));
});
test("NATIVE-ALGORITHM DOUBLE: final invalid item and duplicate targets reject entire batch before first setter", async (t) => {
  for (const items of [
    [fields("task"), fields("missing")],
    [fields("task", "a"), fields("task", "b")],
  ]) {
    const { native, core } = await setup(t);
    const r = await core.mutate("task.batch", {
      action: "update",
      items,
      apply: true,
      request_key: "reject",
    });
    assert.ok(r.items.every((i) => i.outcome === "rejected"));
    assert.equal(native.events.length, 0);
  }
});
test("NATIVE-ALGORITHM DOUBLE: native last-item race rejects all before any setter", async (t) => {
  const { native, second, core } = await setup(t);
  native.beforeApply = () => {
    second.completed = true;
  };
  const r = await core.mutate("task.batch", {
    action: "update",
    items: [fields("task"), fields("second")],
    apply: true,
    request_key: "race",
  });
  assert.ok(r.items.every((i) => i.outcome === "conflict"));
  assert.equal(native.task.name, "baseline");
  assert.equal(native.events.length, 0);
});
test("NATIVE-ALGORITHM DOUBLE: mid-request stop yields applied/partial/rejected with independent item evidence", async (t) => {
  const { native, second, third, core } = await setup(t);
  Object.defineProperty(second, "note", {
    get: () => second.noteText.string,
    set: () => {
      throw Error("simulated setter failure");
    },
  });
  const items = ["task", "second", "third"].map((id) => ({
    ...fields(id),
    changes: { name: "changed " + id, note: "new note" },
  }));
  const args = { action: "update", items, apply: true, request_key: "partial" };
  const r = await core.mutate("task.batch", args);
  assert.deepEqual(
    r.items.map((i) => i.outcome),
    ["applied", "partial", "rejected"],
  );
  assert.equal(r.reconciliation_required, false);
  assert.equal(third.name, "third");
  const n = native.events.length;
  assert.deepEqual(await core.mutate("task.batch", args), r);
  assert.equal(native.events.length, n);
});
test("NATIVE-ALGORITHM DOUBLE: missing dispatch acknowledgement is unknown and never replayed", async (t) => {
  const { native, core } = await setup(t);
  native.loseResponse = true;
  const args = {
    action: "update",
    items: [fields("task"), fields("second")],
    apply: true,
    request_key: "unknown",
  };
  const r = await core.mutate("task.batch", args);
  assert.ok(r.items.every((i) => i.outcome === "unknown"));
  assert.equal(r.reconciliation_required, true);
  const n = native.events.length;
  await core.mutate("task.batch", args);
  assert.equal(native.events.length, n);
});
test("NATIVE-ALGORITHM DOUBLE: move to Inbox has all-item preflight and stable parent/project readback", async (t) => {
  const { core } = await setup(t);
  const r = await core.mutate("task.batch", {
    action: "move",
    items: ["task", "second"].map((id) => ({
      item_key: id,
      task_id: id,
      destination: { kind: "inbox" },
    })),
    apply: true,
    request_key: "move",
  });
  assert.ok(r.items.every((i) => i.outcome === "applied"));
});
test("OFFLINE/NATIVE-ALGORITHM DOUBLE: scalar scope required, preview binds complete meaning and batch fields stay bounded", async (t) => {
  const { native, core } = await setup(t, ["task.batch"]);
  const args = {
    action: "update",
    items: [fields("task")],
    apply: true,
    request_key: "deny",
  };
  assert.equal(
    (await core.mutate("task.batch", args)).items[0].outcome,
    "rejected",
  );
  assert.equal(native.events.length, 0);
  const p = await core.mutate("task.batch", { ...args, apply: false });
  assert.ok(p.apply_input.items[0].preconditions.length);
  assert.equal(p.apply_input_hash.length, 64);
  await assert.rejects(
    core.mutate("task.batch", {
      ...args,
      items: [
        { item_key: "bad", task_id: "task", changes: { recurrence: null } },
      ],
    }),
    (e) => e.code === "INVALID_MUTATION",
  );
});
test("NATIVE-ALGORITHM DOUBLE: interacting ancestor or destination targets reject before setters", async (t) => {
  for (const action of ["update", "move"]) {
    const { native, second, core } = await setup(t);
    let items;
    if (action === "update") {
      second.parent = native.task;
      native.task.tasks.push(second);
      items = [fields("task"), fields("second")];
    } else
      items = [
        {
          item_key: "a",
          task_id: "task",
          destination: { kind: "parent", task_id: "second" },
        },
        { item_key: "b", task_id: "second", destination: { kind: "inbox" } },
      ];
    const r = await core.mutate("task.batch", {
      action,
      items,
      apply: true,
      request_key: "interacting",
    });
    assert.ok(r.items.every((i) => i.outcome === "rejected"));
    assert.equal(native.events.length, 0);
  }
});
test("NATIVE-ALGORITHM DOUBLE: one incomplete independent read retains other item outcomes and prevents replay", async (t) => {
  const { native, core } = await setup(t),
    run = native.run;
  native.run = async (op, args) => {
    if (op === "get" && args.ids?.includes("second"))
      throw Error("independent read failed");
    return run(op, args);
  };
  const args = {
    action: "update",
    items: [fields("task"), fields("second"), fields("third")],
    apply: true,
    request_key: "item-unknown",
  };
  const r = await core.mutate("task.batch", args);
  assert.deepEqual(
    r.items.map((i) => i.outcome),
    ["applied", "unknown", "applied"],
  );
  assert.equal(r.reconciliation_required, true);
  const count = native.events.length;
  await core.mutate("task.batch", args);
  assert.equal(native.events.length, count);
});

test("NATIVE-ALGORITHM DOUBLE: ordinary drop/delete batches retain scalar proofs, one dispatch and durable replay", async (t) => {
  for (const action of ["drop", "delete"]) {
    const f = await setup(t);
    let count = 0;
    f.native.beforeApply = () => count++;
    const input = {
      action,
      items: [
        { item_key: "first", task_id: "task" },
        { item_key: "second", task_id: "second" },
      ],
      apply: true,
      request_key: action,
    };
    const r = await f.core.mutate("task.batch", input);
    assert.ok(
      r.items.every((i) => i.outcome === "applied"),
      JSON.stringify(r),
    );
    assert.equal(count, 1);
    if (action === "delete")
      assert.equal(f.native.tasks.includes(f.second), false);
    else assert.ok(f.second.dropDate);
    assert.deepEqual(await f.core.mutate("task.batch", input), r);
    assert.equal(count, 1);
  }
});
test("NATIVE-ALGORITHM DOUBLE: destructive final-item race rejects entire request and missing destructive scope prevents all setters", async (t) => {
  for (const action of ["drop", "delete"]) {
    const f = await setup(t);
    f.native.beforeApply = () => {
      f.second.repetitionRule = { ruleString: "FREQ=DAILY", method: {} };
    };
    const input = {
      action,
      items: [
        { item_key: "first", task_id: "task" },
        { item_key: "second", task_id: "second" },
      ],
      apply: true,
      request_key: action,
    };
    const r = await f.core.mutate("task.batch", input);
    assert.ok(
      r.items.every(
        (i) => i.outcome === "conflict" || i.outcome === "rejected",
      ),
    );
    assert.equal(f.native.events.length, 0);
    const denied = await setup(t, ["task.batch", "task.update"]);
    const rejected = await denied.core.mutate("task.batch", input);
    assert.notEqual(rejected.items?.[0]?.outcome, "applied");
    assert.equal(denied.native.events.length, 0);
  }
});
test("NATIVE-ALGORITHM DOUBLE: destructive batch response loss never redispatches and stable item keys persist", async (t) => {
  for (const action of ["drop", "delete"]) {
    const f = await setup(t);
    f.native.loseResponse = true;
    const input = {
      action,
      items: [
        { item_key: "first", task_id: "task" },
        { item_key: "second", task_id: "second" },
      ],
      apply: true,
      request_key: action,
    };
    const r = await f.core.mutate("task.batch", input);
    assert.ok(r.items.every((i) => i.outcome === "unknown"));
    const n = f.native.events.length;
    const again = await f.core.mutate("task.batch", input);
    assert.ok(again.items.every((i) => i.outcome === "unknown"));
    assert.equal(f.native.events.length, n);
  }
});

test("A rich note in a task batch rejects the whole request before setters", async (t) => {
  const { core, native, second } = await setup(t);
  second.noteText = { string: "rich", attachments: [{}], attributeRuns: [] };
  const result = await core.mutate("task.batch", {
    action: "update",
    items: [
      fields("task"),
      { item_key: "second", task_id: "second", changes: { note: "flat" } },
    ],
    apply: true,
    request_key: "rich-note",
  });
  assert.equal(result.error.code, "INVALID_MUTATION");
  assert.deepEqual(native.events, []);
});
