import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
import { repeatingFixture } from "./repeating-fixture.mjs";
async function setup(t, allow = true) {
  const native = repeatingFixture(taskFixture()),
    dir = await mkdtemp(join(tmpdir(), "nfo-repeat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.complete"],
      project_ids: ["project"],
      allow_repeating_completion: allow,
    }),
    { mode: 0o600 },
  );
  return { native, core: new NoFussCore(native, {}, dir) };
}
const args = {
  task_id: "task",
  occurrence: "current",
  apply: true,
  request_key: "occurrence",
};
test("NATIVE-ALGORITHM DOUBLE: explicit occurrence completion returns history identity, preserves continuing identity and durably replays", async (t) => {
  const { native, core } = await setup(t),
    result = await core.mutate("task.complete", args);
  assert.equal(result.items[0].outcome, "applied");
  assert.notEqual(result.items[0].resource.id, "task");
  assert.equal(native.task.completed, false);
  assert.equal(native.task.dueDate.toISOString(), "2096-02-29T12:00:00.000Z");
  const count = native.events.length;
  assert.deepEqual(await core.mutate("task.complete", args), result);
  assert.equal(native.events.length, count);
  assert.equal(native.tasks.filter((t) => t.completed).length, 1);
});
test("NATIVE-ALGORITHM DOUBLE: host opt-in, single local anchor and native apply-time recheck protect repeating completion", async (t) => {
  const { native, core } = await setup(t, false);
  assert.equal(
    (await core.mutate("task.complete", args)).error.code,
    "WRITE_NOT_AUTHORIZED",
  );
  assert.equal(native.events.length, 0);
  const allowed = await setup(t);
  allowed.native.beforeApply = () => {
    allowed.native.task.deferDate = new Date("2096-01-30T12:00:00Z");
  };
  const result = await allowed.core.mutate("task.complete", args);
  assert.notEqual(result.items[0].outcome, "applied");
  assert.equal(allowed.native.events.length, 0);
});
test("NATIVE-ALGORITHM DOUBLE: missing generated identity and unexpected continuing date never report applied or blindly retry", async (t) => {
  const { native, core } = await setup(t);
  const complete = native.task.markComplete;
  native.task.markComplete = function () {
    const h = complete.call(this);
    this.dueDate = new Date("2096-03-01T12:00:00Z");
    return h;
  };
  const result = await core.mutate("task.complete", args);
  assert.equal(result.items[0].outcome, "partial");
  const missing = await setup(t);
  missing.native.task.markComplete = function () {
    missing.native.events.push("noop");
    return this;
  };
  const unknown = await missing.core.mutate("task.complete", args);
  assert.equal(unknown.items[0].outcome, "unknown");
  const n = missing.native.events.length;
  const replay = await missing.core.mutate("task.complete", args);
  assert.equal(replay.items[0].outcome, "unknown");
  assert.equal(replay.reconciliation_required, true);
  assert.equal(missing.native.events.length, n);
});
