import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWrites } from "../dist/project-writes.js";
import { reviewFixture } from "./review-write-fixture.mjs";
async function setup(t) {
  const f = reviewFixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["project.set_review_interval", "project.mark_reviewed"],
      project_ids: [f.p.id.primaryKey],
    }),
    { mode: 0o600 },
  );
  return { ...f, writes: new ProjectWrites(f.native, f.core, dir) };
}
test("NATIVE-ALGORITHM DOUBLE: calendar interval/fixed record roundtrip, distinct operation and durable retry", async (t) => {
  const f = await setup(t);
  for (const fixed of [false, true]) {
    const args = {
      entity: "project",
      project_id: f.p.id.primaryKey,
      action: "set_interval",
      review_interval: { unit: "days", steps: 2, fixed },
      apply: true,
      request_key: "set-" + fixed,
    };
    const r = await f.writes.execute("project.set_review_interval", args);
    assert.equal(r.items[0].outcome, "applied");
    assert.deepEqual(f.p._interval, args.review_interval);
    const count = f.counters.setters;
    assert.deepEqual(
      await f.writes.execute("project.set_review_interval", args),
      r,
    );
    assert.equal(f.counters.setters, count);
  }
  assert.equal(f.p.lastReviewDate, null);
});
test("NATIVE-ALGORITHM DOUBLE: mark-reviewed uses last setter only, next derived and interval preserved", async (t) => {
  const f = await setup(t),
    interval = { ...f.p._interval };
  const count = f.counters.setters;
  const r = await f.writes.execute("project.mark_reviewed", {
    entity: "project",
    project_id: f.p.id.primaryKey,
    action: "mark_reviewed",
    apply: true,
    request_key: "mark",
  });
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(f.counters.setters, count + 1);
  assert.ok(f.p.lastReviewDate);
  assert.ok(f.p.nextReviewDate > f.p.lastReviewDate);
  assert.deepEqual(f.p._interval, interval);
});
test("NATIVE-ALGORITHM DOUBLE: null/reset/sub-day setters reject and existing sub-day marking has no effect", async (t) => {
  const f = await setup(t);
  for (const review_interval of [
    null,
    { unit: "hours", steps: 2, fixed: true },
    { unit: "days", steps: 0, fixed: true },
  ])
    await assert.rejects(
      f.writes.execute("project.set_review_interval", {
        entity: "project",
        project_id: f.p.id.primaryKey,
        action: "set_interval",
        review_interval,
      }),
      { code: "INVALID_MUTATION" },
    );
  f.p._interval.unit = "hours";
  const before = f.counters.setters;
  const r = await f.writes.execute("project.mark_reviewed", {
    entity: "project",
    project_id: f.p.id.primaryKey,
    action: "mark_reviewed",
    apply: true,
    request_key: "sub-day",
  });
  assert.equal(r.items[0].outcome, "rejected");
  assert.equal(f.counters.setters, before);
});
test("NATIVE-ALGORITHM DOUBLE: fixed-flag stale snapshot conflicts before setter", async (t) => {
  const f = await setup(t);
  const args = {
    entity: "project",
    project_id: f.p.id.primaryKey,
    action: "set_interval",
    review_interval: { unit: "months", steps: 3, fixed: false },
  };
  const preview = await f.writes.execute("project.set_review_interval", args);
  f.p._interval.fixed = false;
  const before = f.counters.setters;
  const r = await f.writes.execute("project.set_review_interval", {
    ...preview.apply_input,
    apply: true,
    request_key: "stale",
  });
  assert.equal(r.items[0].outcome, "conflict");
  assert.equal(f.counters.setters, before);
});
