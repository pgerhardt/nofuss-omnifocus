import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NoFussCore } from "../dist/core.js";
import { MutationJournal } from "../dist/mutation-journal.js";
import { readWritePolicy } from "../dist/write-authorization.js";
import { taskFixture } from "./task-write-fixture.mjs";
const policy = {
  schema_version: 1,
  scopes: ["task.create", "task.update", "task.complete"],
  project_ids: ["project"],
};
async function setup(t, authorized = true) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-task-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (authorized)
    await writeFile(
      join(dir, "mutation-authorization.json"),
      JSON.stringify(policy),
      { mode: 0o600 },
    );
  const native = taskFixture();
  return {
    dir,
    native,
    core: new NoFussCore(native, {}, dir),
    journal: new MutationJournal(dir),
  };
}
const create = {
  project_id: "project",
  name: "New Ω",
  note: "note\nΩ",
  flagged: true,
  tag_ids: ["tag-a", "tag-b"],
};
test("NATIVE-ALGORITHM DOUBLE: create preview, apply, independent readback and durable identity", async (t) => {
  const { core, native, journal, dir } = await setup(t);
  const preview = await core.mutate("task.create", create);
  assert.equal(preview.mode, "preview");
  assert.deepEqual(native.events, []);
  const input = { ...create, apply: true, request_key: "create" };
  const result = await core.mutate("task.create", input);
  assert.equal(result.items[0].outcome, "applied");
  assert.ok(result.items[0].resource.id);
  assert.equal(native.readCalls, 1);
  const saved = await journal.read("create");
  assert.equal(saved.native_receipt.task_id, result.items[0].resource.id);
  const next = new NoFussCore(
    {
      run() {
        throw Error("duplicate must not dispatch");
      },
    },
    {},
    dir,
  );
  assert.deepEqual(await next.mutate("task.create", input), result);
  assert.equal(
    (await next.mutate("task.create", { ...input, name: "different" })).error
      .code,
    "REQUEST_KEY_REUSE_MISMATCH",
  );
});
test("NATIVE-ALGORITHM DOUBLE: update preserve/set/clear with exact tag membership", async (t) => {
  const { core, native } = await setup(t);
  let r = await core.mutate("task.update", {
    task_id: "task",
    changes: {
      name: "changed",
      note: "note",
      flagged: true,
      tag_ids: ["tag-b", "tag-a"],
    },
    apply: true,
    request_key: "update",
  });
  assert.equal(r.items[0].outcome, "applied");
  assert.deepEqual(
    native.task.tags.map((t) => t.id.primaryKey),
    ["tag-b", "tag-a"],
  );
  r = await core.mutate("task.update", {
    task_id: "task",
    changes: { note: "", tag_ids: [] },
    apply: true,
    request_key: "clear",
  });
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(native.task.noteText.string, "");
  assert.equal(native.task.flagged, true);
  assert.equal(native.task.name, "changed");
  assert.deepEqual(native.task.tags, []);
});
for (const [scope, input] of [
  ["task.create", { ...create, project_id: "missing" }],
  ["task.create", { ...create, tag_ids: ["missing"] }],
  ["task.create", { ...create, tag_ids: ["task"] }],
  ["task.create", { ...create, tag_ids: ["tag-a", "tag-a"] }],
  ["task.create", { ...create, due_at: "invalid" }],
  ["task.update", { task_id: "missing", changes: { name: "x" } }],
  ["task.update", { task_id: "root", changes: { name: "x" } }],
  ["task.update", { task_id: "task", changes: { completed: true } }],
  ["task.update", { task_id: "task", changes: { note: null } }],
  ["task.update", { task_id: "task", changes: {} }],
  ["task.complete", { task_id: "task", completed: true }],
])
  test(
    "OFFLINE/NATIVE DOUBLE: invalid references/fields reject before setter " +
      JSON.stringify(input),
    async (t) => {
      const { core, native } = await setup(t);
      try {
        const r = await core.mutate(scope, {
          ...input,
          apply: true,
          request_key: "invalid",
        });
        assert.equal(r.items[0].outcome, "rejected");
      } catch (e) {
        assert.equal(e.code, "INVALID_MUTATION");
      }
      assert.deepEqual(native.events, []);
    },
  );
test("OFFLINE: authorization absent, malformed, unsafe, revoked and scoped", async (t) => {
  const { core, native, dir } = await setup(t, false);
  const input = { ...create, apply: true, request_key: "deny" };
  assert.equal(
    (await core.mutate("task.create", input)).error.code,
    "WRITE_NOT_AUTHORIZED",
  );
  for (const content of [
    "{",
    JSON.stringify({ ...policy, schema_version: 2 }),
    JSON.stringify({ ...policy, project_ids: ["elsewhere"] }),
  ]) {
    await writeFile(join(dir, "mutation-authorization.json"), content, {
      mode: 0o600,
    });
    assert.equal(
      (await core.mutate("task.create", input)).error.code,
      "WRITE_NOT_AUTHORIZED",
    );
  }
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify(policy),
  );
  await chmod(join(dir, "mutation-authorization.json"), 0o644);
  assert.equal(await readWritePolicy(dir), null);
  assert.equal(
    (await core.mutate("task.create", input)).error.code,
    "WRITE_NOT_AUTHORIZED",
  );
  assert.equal((await core.mutate("task.create", create)).mode, "preview");
  assert.deepEqual(native.events, []);
  await assert.rejects(core.mutate("task.create", { ...create, apply: true }), {
    code: "INVALID_MUTATION",
  });
});
test("NATIVE-ALGORITHM DOUBLE: old preview preconditions and native last-moment recheck conflict", async (t) => {
  const { core, native, journal } = await setup(t);
  const input = { task_id: "task", changes: { name: "new" } };
  const p = await core.mutate("task.update", input);
  native.task._name = "external";
  assert.equal(
    (
      await core.mutate("task.update", {
        ...p.apply_input,
        apply: true,
        request_key: "old-plan",
      })
    ).items[0].outcome,
    "conflict",
  );
  assert.deepEqual(native.events, []);
  native.beforeApply = () => (native.task._name = "another-external");
  const r = await core.mutate("task.update", {
    ...input,
    apply: true,
    request_key: "native-conflict",
  });
  assert.equal(r.items[0].outcome, "conflict");
  assert.equal(r.error.code, "PRECONDITION_CONFLICT");
  assert.equal(native.task.name, "another-external");
  assert.deepEqual(native.events, []);
  assert.equal(await journal.inspectLock(), null);
});
test("NATIVE-ALGORITHM DOUBLE: ordinary completion and already-completed rejection", async (t) => {
  const { core, native } = await setup(t);
  const input = { task_id: "task", apply: true, request_key: "complete" };
  assert.equal(
    (await core.mutate("task.complete", { task_id: "task" })).mode,
    "preview",
  );
  assert.deepEqual(native.events, []);
  const result = await core.mutate("task.complete", input);
  assert.equal(result.items[0].outcome, "applied");
  assert.equal(native.task.completed, true);
  assert.ok(native.task.completionDate);
  assert.deepEqual(await core.mutate("task.complete", input), result);
  assert.deepEqual(native.events, ["complete"]);
  assert.equal(
    (await core.mutate("task.complete", { ...input, request_key: "again" }))
      .items[0].outcome,
    "rejected",
  );
  assert.deepEqual(native.events, ["complete"]);
});
test("NATIVE-ALGORITHM DOUBLE: repeat/group/auto-completion risks reject before setter", async (t) => {
  for (const flag of ["repeat", "ancestor-repeat", "children", "auto"]) {
    const { core, native } = await setup(t);
    if (flag === "repeat")
      native.task.repetitionRule = { ruleString: "FREQ=DAILY" };
    if (flag === "ancestor-repeat") native.project.task.repetitionRule = {};
    if (flag === "children") native.task.tasks.push({});
    if (flag === "auto") native.project.task.completedByChildren = true;
    const r = await core.mutate("task.complete", {
      task_id: "task",
      apply: true,
      request_key: flag,
    });
    assert.equal(r.items[0].outcome, "rejected");
    if (flag.includes("repeat"))
      assert.equal(r.error.code, "REPEATING_COMPLETION_UNSUPPORTED");
    assert.deepEqual(native.events, []);
  }
});
test("NATIVE-ALGORITHM DOUBLE: create ID lost is unknown, retains lock and never creates again", async (t) => {
  const { core, native, journal } = await setup(t);
  native.loseResponse = true;
  const input = { ...create, apply: true, request_key: "lost" };
  const result = await core.mutate("task.create", input);
  assert.equal(result.items[0].outcome, "unknown");
  assert.ok(await journal.inspectLock());
  const count = native.events.filter((x) => x === "create").length;
  assert.equal(count, 1);
  assert.equal(
    (await core.mutate("task.create", input)).items[0].outcome,
    "unknown",
  );
  assert.equal(native.events.filter((x) => x === "create").length, count);
  assert.equal((await journal.read("lost")).native_receipt, undefined);
});
test("NATIVE-ALGORITHM DOUBLE: independent readback failure never turns receipt into applied", async (t) => {
  const { core, native, journal } = await setup(t);
  native.readbackFails = true;
  const r = await core.mutate("task.create", {
    ...create,
    apply: true,
    request_key: "readfail",
  });
  assert.equal(r.items[0].outcome, "unknown");
  assert.ok((await journal.read("readfail")).native_receipt);
  assert.ok(await journal.inspectLock());
});
test("OFFLINE: authorization policy is not parsed as a mutation journal", async (t) => {
  const { core, dir } = await setup(t);
  assert.equal(
    (
      await core.mutate("task.create", {
        ...create,
        apply: true,
        request_key: "policy",
      })
    ).items[0].outcome,
    "applied",
  );
  assert.ok(
    JSON.parse(await readFile(join(dir, "mutation-authorization.json"), "utf8"))
      .scopes,
  );
});
test("NATIVE-ALGORITHM DOUBLE: preserved fields beyond independent read bounds reject", async (t) => {
  const { core, native } = await setup(t);
  native.task.noteText.string = "x".repeat(2049);
  const r = await core.mutate("task.update", {
    task_id: "task",
    changes: { flagged: true },
    apply: true,
    request_key: "large-note",
  });
  assert.equal(r.items[0].outcome, "rejected");
  assert.deepEqual(native.events, []);
});
test("NATIVE-ALGORITHM DOUBLE: native operation rejects a missing planned reference snapshot", async (t) => {
  const { core, native } = await setup(t);
  const p = await core.mutate("task.create", create);
  const request = {
    operation: { kind: "task.create", version: 1 },
    request_key: "malformed",
    items: [
      {
        item_key: "task",
        targets: [],
        references: [{ entity: "project", id: "project" }],
        changes: { name: "test" },
        preconditions: [],
        payload: { project_id: "project" },
      },
    ],
  };
  const result = await native.run("task_write_apply", {
    request,
    plan: { items: [{ ...p.plan.items[0], preconditions: [] }] },
    input_hash: "double",
    authorized_project_ids: ["project"],
  });
  assert.equal(result.setter_count, 0);
  assert.equal(result.error.code, "INVALID_MUTATION");
  assert.deepEqual(native.events, []);
});
test("NATIVE-ALGORITHM DOUBLE: preview exposes hash for the exact pinned apply input", async (t) => {
  const { core } = await setup(t);
  const p = await core.mutate("task.create", create);
  const r = await core.mutate("task.create", {
    ...p.apply_input,
    apply: true,
    request_key: "pinned",
  });
  assert.equal(r.input_hash, p.apply_input_hash);
  assert.equal(r.items[0].outcome, "applied");
});
test("NATIVE-ALGORITHM DOUBLE: setter acknowledgement plus mismatched state is partial, never applied", async (t) => {
  const { core, native, journal } = await setup(t);
  const run = native.run;
  native.run = async (op, args) => {
    const r = await run(op, args);
    if (op === "task_write_apply")
      native.task._name = "external-after-dispatch";
    return r;
  };
  const r = await core.mutate("task.update", {
    task_id: "task",
    changes: { name: "wanted", flagged: true },
    apply: true,
    request_key: "mismatch",
  });
  assert.equal(r.items[0].outcome, "partial");
  assert.equal(native.task.flagged, true);
  assert.equal(await journal.inspectLock(), null);
});
test("NATIVE-ALGORITHM DOUBLE: known create ID missing on independent read is unknown", async (t) => {
  const { core, native, journal } = await setup(t);
  const run = native.run;
  native.run = async (op, args) => {
    const r = await run(op, args);
    if (op === "task_write_apply")
      native.tasks.splice(
        native.tasks.findIndex((x) => x.id.primaryKey === r.task_id),
        1,
      );
    return r;
  };
  const input = { ...create, apply: true, request_key: "missing-created" };
  const r = await core.mutate("task.create", input);
  assert.equal(r.items[0].outcome, "unknown");
  assert.ok(await journal.inspectLock());
  const count = native.events.length;
  await core.mutate("task.create", input);
  assert.equal(native.events.length, count);
});
