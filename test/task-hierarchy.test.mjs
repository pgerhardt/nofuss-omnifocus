import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
async function setup(
  t,
  scopes = [
    "task.duplicate",
    "task.delete",
    "task.drop",
    "task.complete",
    "task.reorder",
  ],
) {
  const native = taskFixture();
  native.project.task.tasks = native.project.tasks;
  const C = native.task.constructor;
  const child = new C("same", native.task),
    grandchild = new C("same", child),
    peer = new C("same", native.project);
  native.events.length = 0;
  const dir = await mkdtemp(join(tmpdir(), "nfo-hierarchy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({ schema_version: 1, scopes, project_ids: ["project"] }),
    { mode: 0o600 },
  );
  return {
    native,
    child,
    grandchild,
    peer,
    core: new NoFussCore(native, {}, dir),
  };
}
const args = {
  task_id: "task",
  subtree: true,
  apply: true,
  request_key: "tree",
};
test("NATIVE-HIERARCHY DOUBLE: all returned-root descendants are independently verified, original unchanged, durable replay", async (t) => {
  const { core, native } = await setup(t);
  const result = await core.mutate("task.duplicate", args);
  assert.equal(result.items[0].outcome, "applied");
  assert.notEqual(result.items[0].resource.id, "task");
  assert.equal(native.tasks.length, 8);
  const count = native.events.length;
  assert.deepEqual(await core.mutate("task.duplicate", args), result);
  assert.equal(native.events.length, count);
});
test("NATIVE-HIERARCHY DOUBLE: delete proves descendant absence; group complete/drop inherit effective state without local descendant setters", async (t) => {
  for (const op of ["delete", "drop", "complete"]) {
    const { core, native, child, grandchild } = await setup(t);
    const result = await core.mutate("task." + op, args);
    assert.equal(result.items[0].outcome, "applied");
    if (op === "delete") {
      assert.equal(native.tasks.includes(child), false);
      assert.equal(native.tasks.includes(grandchild), false);
    } else if (op === "drop") {
      assert.equal(child.dropDate, null);
      assert.ok(child.effectiveDropDate);
    } else {
      assert.equal(child.completed, false);
      assert.ok(child.effectiveCompletionDate);
    }
  }
});
test("NATIVE-HIERARCHY DOUBLE: exact reorder keeps container and descendants; wrong-container/stale sibling snapshots reject before setters", async (t) => {
  const f = await setup(t);
  const input = {
    task_id: f.peer.id.primaryKey,
    container: { kind: "project", project_id: "project" },
    position: "before",
    peer_id: "task",
    apply: true,
    request_key: "order",
  };
  const r = await f.core.mutate("task.reorder", input);
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(f.native.project.tasks[0], f.peer);
  const wrong = await setup(t);
  const rejected = await wrong.core.mutate("task.reorder", {
    ...input,
    peer_id: wrong.child.id.primaryKey,
  });
  assert.equal(rejected.error.code, "INVALID_MUTATION");
  assert.equal(wrong.native.events.length, 0);
  const stale = await setup(t);
  const preview = await stale.core.mutate("task.reorder", {
    ...input,
    apply: false,
  });
  stale.native.project.tasks.reverse();
  const result = await stale.core.mutate("task.reorder", {
    ...preview.apply_input,
    apply: true,
  });
  assert.notEqual(result.items?.[0]?.outcome, "applied");
  assert.equal(stale.native.events.length, 0);
});
test("NATIVE-HIERARCHY DOUBLE: dangerous descendant and revoked scope block the whole subtree", async (t) => {
  const f = await setup(t);
  f.grandchild.completedByChildren = true;
  assert.equal(
    (await f.core.mutate("task.delete", args)).error.code,
    "INVALID_MUTATION",
  );
  assert.equal(f.native.events.length, 0);
  const denied = await setup(t, []);
  assert.equal(
    (await denied.core.mutate("task.delete", args)).error.code,
    "WRITE_NOT_AUTHORIZED",
  );
  assert.equal(denied.native.events.length, 0);
});

test("REVIEW REGRESSION: a setter attempt without an independently observed effect remains unknown and never replays", async (t) => {
  const f = await setup(t);
  f.native.task.drop = () => {
    throw Error("before native effect");
  };
  const input = { ...args, request_key: "failed-drop" };
  const result = await f.core.mutate("task.drop", input);
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
  const count = f.native.events.length;
  assert.equal(
    (await f.core.mutate("task.drop", input)).items[0].outcome,
    "unknown",
  );
  assert.equal(f.native.events.length, count);
});

test("REVIEW REGRESSION: small subtree deletion reads only exact absence and parent order even when the surviving parent exceeds tree bounds", async (t) => {
  const f = await setup(t);
  const C = f.native.task.constructor;
  for (let i = 0; i < 55; i++) new C("unrelated", f.native.task);
  // Delete the small grandchild tree; its parent stays inside a large ancestor hierarchy.
  for (let i = 0; i < 55; i++) new C("sibling", f.child);
  const calls = [];
  const run = f.native.run;
  f.native.run = async (op, args) => {
    calls.push({ op, args });
    return run(op, args);
  };
  const result = await f.core.mutate("task.delete", {
    ...args,
    task_id: f.grandchild.id.primaryKey,
    request_key: "large-parent",
  });
  assert.equal(result.items[0].outcome, "applied", JSON.stringify(result));
  assert.equal(f.native.tasks.includes(f.grandchild), false);
  assert.equal(f.child.tasks.length, 55);
  assert.equal(calls.filter((c) => c.op === "get").length, 1);
});

test("REVIEW REGRESSION: a mismatched ordinary receipt cannot substitute another persistent resource for the requested target", async (t) => {
  const f = await setup(t),
    run = f.native.run;
  f.native.run = async (op, input) => {
    const r = await run(op, input);
    if (op === "task_hierarchy_apply") r.task_id = f.peer.id.primaryKey;
    return r;
  };
  const result = await f.core.mutate("task.drop", {
    ...args,
    request_key: "wrong-receipt",
  });
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
  assert.equal(result.items[0].resource, undefined);
});
