import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
import { taskFixture } from "./task-write-fixture.mjs";
import { repeatingFixture } from "./repeating-fixture.mjs";
process.env.TZ = "America/Denver";
async function setup(t, anchor = "due", instant = "2026-09-20T20:00:00Z") {
  let now = instant;
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return Date.parse(now);
    }
  }
  const native = repeatingFixture(taskFixture(Clock));
  const key = anchor === "due" ? "dueDate" : "deferDate";
  native.task.dueDate = null;
  native.task[key] = new Date("2026-01-15T09:12:34.567-07:00");
  native.task.repetitionRule = {
    ruleString: "FREQ=DAILY;INTERVAL=1",
    scheduleType: "FromCompletion",
    anchorDateKey: anchor === "due" ? "DueDate" : "DeferDate",
    catchUpAutomatically: false,
    firstDateAfterDate(base) {
      // Native calendar algorithm double, not a completion oracle.
      const next = new Date(base);
      next.setDate(next.getDate() + 1);
      next.setSeconds(0, 0);
      return next;
    },
  };
  const clone = native.task.markComplete;
  native.task.markComplete = function (completion) {
    const history = clone.call(this);
    history.completionDate = completion;
    // Pinned evidence expected value is independent of the predictor.
    this[key] = new Date("2026-09-21T15:12:00Z");
    if (anchor === "defer") this.dueDate = null;
    return history;
  };
  const dir = await mkdtemp(join(tmpdir(), "nfo-clock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.complete"],
      project_ids: ["project"],
      allow_repeating_completion: true,
    }),
    { mode: 0o600 },
  );
  return {
    native,
    core: new NoFussCore(native, {}, dir),
    setClock: (value) => {
      now = value;
    },
  };
}
const args = {
  task_id: "task",
  occurrence: "current",
  apply: true,
  request_key: "clock",
};
test("NATIVE-EVIDENCE DOUBLE: due/start-again preserve old local clock, minute precision and exact history identities", async (t) => {
  for (const anchor of ["due", "defer"]) {
    const { native, core } = await setup(t, anchor);
    const result = await core.mutate("task.complete", args);
    assert.equal(result.items[0].outcome, "applied");
    assert.notEqual(result.items[0].resource.id, "task");
    assert.equal(
      native.task[anchor === "due" ? "dueDate" : "deferDate"].toISOString(),
      "2026-09-21T15:12:00.000Z",
    );
    const count = native.events.length;
    assert.deepEqual(await core.mutate("task.complete", args), result);
    assert.equal(native.events.length, count);
  }
});
test("NATIVE-EVIDENCE DOUBLE: missing spring clock normalizes on completion day before calendar advance", async (t) => {
  const { native, core } = await setup(t, "due", "2026-03-08T20:00:00Z");
  native.task.dueDate = new Date("2026-01-15T02:30:00-07:00");
  const complete = native.task.markComplete;
  native.task.markComplete = function (date) {
    const h = complete.call(this, date);
    this.dueDate = new Date("2026-03-09T09:30:00Z");
    return h;
  };
  assert.equal(
    (await core.mutate("task.complete", args)).items[0].outcome,
    "applied",
  );
});
test("NATIVE-EVIDENCE DOUBLE: completion day rollover conflicts before mutation; floating and custom selectors reject", async (t) => {
  const { native, core, setClock } = await setup(t);
  native.beforeApply = () => setClock("2026-09-21T20:00:00Z");
  const result = await core.mutate("task.complete", args);
  assert.equal(result.items[0].outcome, "conflict");
  assert.equal(native.events.length, 0);
  for (const kind of ["floating", "selector"]) {
    const fixture = await setup(t);
    if (kind === "floating")
      fixture.native.task.shouldUseFloatingTimeZone = true;
    else
      fixture.native.task.repetitionRule.ruleString =
        "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR";
    const rejected = await fixture.core.mutate("task.complete", args);
    assert.equal(rejected.error.code, "REPEATING_COMPLETION_UNSUPPORTED");
    assert.equal(fixture.native.events.length, 0);
  }
});
