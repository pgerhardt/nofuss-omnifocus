import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePrimitives } from "../dist/native-primitives.js";
import { NoFussCore } from "../dist/core.js";
import { runCli } from "../dist/cli-command.js";
import { mcpResult } from "../dist/service.js";
async function setup(t, scope) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-primitive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policy = {
    schema_version: 1,
    scopes: [scope],
    project_ids: ["p"],
    tag_ids: ["tag"],
    allow_preferences: true,
  };
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify(policy),
    { mode: 0o600 },
  );
  const states = {
    document: {
      id: "doc",
      forecast_tag_id: null,
      forecast_value: "",
      forecast_override: false,
    },
    tag: {
      id: "tag",
      name: "Tag",
      parent_id: null,
      active: true,
      allows_next_action: true,
    },
    project: {
      id: "p",
      name: "Project",
      active: true,
      repeat: false,
      tentative: false,
      last_review_at: "2026-10-01T06:00:00.000Z",
      next_review_at: "2026-10-08T06:00:00.000Z",
      next_review_date: "2026-10-08",
      next_review_midnight: true,
      review_interval: { unit: "week", steps: 1, fixed: false },
      reset_date: "2026-10-08",
    },
  };
  let count = 0,
    lose = false;
  const native = {
    snapshot: () => ({}),
    run: async (op, a) => {
      if (op === "primitive_facts")
        return {
          reference: a.reference,
          facts: structuredClone(states[a.reference.entity]),
        };
      if (op === "primitive_preferences")
        return {
          document_id: "doc",
          forecast_tag_id: states.document.forecast_tag_id,
          tag: a.tag_id
            ? { id: "tag", allows_next_action: states.tag.allows_next_action }
            : null,
          observed_at: new Date().toISOString(),
        };
      if (op === "primitive_apply") {
        count++;
        const item = a.request.items[0],
          s = states[item.targets[0].entity],
          c = item.changes;
        if ("tag_id" in c)
          Object.assign(s, {
            forecast_tag_id: c.tag_id,
            forecast_value: c.tag_id ?? "",
            forecast_override: c.tag_id !== null,
          });
        else if ("allows_next_action" in c)
          s.allows_next_action = c.allows_next_action;
        else
          Object.assign(s, {
            next_review_date: c.date ?? s.reset_date,
            next_review_at: (c.date ?? s.reset_date) + "T07:00:00.000Z",
          });
        if (lose) throw Error("lost primitive receipt");
        return {
          request_key: a.request.request_key,
          input_hash: a.input_hash,
          finished: true,
          setter_count: 1,
          resource_id: item.targets[0].id,
          error: null,
        };
      }
      throw Error("unexpected op");
    },
  };
  return {
    dir,
    native,
    states,
    policy,
    writes: new NativePrimitives(native, dir),
    get count() {
      return count;
    },
    set lose(v) {
      lose = v;
    },
  };
}
for (const [scope, args] of [
  [
    "document.set_forecast_tag",
    { entity: "document", document_id: "doc", tag_id: "tag" },
  ],
  [
    "tag.set_allows_next_action",
    { entity: "tag", tag_id: "tag", allows_next_action: false },
  ],
  [
    "project.set_next_review_date",
    { entity: "project", project_id: "p", date: "2027-01-05" },
  ],
])
  test(
    "bounded " + scope + " preserves other fields and core/CLI/MCP replay",
    async (t) => {
      const f = await setup(t, scope),
        core = new NoFussCore(f.native, {}, f.dir),
        a = { ...args, apply: true, request_key: "one" },
        r = await core.execute(scope, a);
      assert.equal(r.items[0].outcome, "applied", JSON.stringify(r));
      assert.deepEqual(await core.execute(scope, a), r);
      const cli = await runCli(
        [scope.split(".")[1], args.entity, "--input", "-", "--apply"],
        core,
        async () => a,
      );
      assert.equal(cli.exitCode, 0, cli.json);
      assert.deepEqual(JSON.parse(cli.json), r);
      assert.deepEqual(mcpResult(r).structuredContent, r);
      assert.equal(f.count, 1);
    },
  );
test("native preferences are strict; document privilege and calendar validation fail closed", async (t) => {
  const f = await setup(t, "document.set_forecast_tag");
  assert.equal(
    (await f.writes.preferences({ tag_id: "tag" })).tag.allows_next_action,
    true,
  );
  await assert.rejects(() => f.writes.preferences({ raw_key: "anything" }));
  await writeFile(
    join(f.dir, "mutation-authorization.json"),
    JSON.stringify({ ...f.policy, allow_preferences: false }),
    { mode: 0o600 },
  );
  assert.equal(
    (
      await f.writes.execute("document.set_forecast_tag", {
        entity: "document",
        document_id: "doc",
        tag_id: null,
        apply: true,
        request_key: "denied",
      })
    ).items[0].outcome,
    "rejected",
  );
  assert.equal(f.count, 0);
  for (const date of ["2026-02-30", "2026-10-01T10:00:00Z", "today"])
    await assert.rejects(
      () =>
        f.writes.execute("project.set_next_review_date", {
          entity: "project",
          project_id: "p",
          date,
        }),
      (e) => e.code === "INVALID_MUTATION",
    );
});
test("review reset lacks an implicit unscheduled state; unsupported schedule rejects and lost receipt never replays", async (t) => {
  const f = await setup(t, "project.set_next_review_date");
  f.states.project.reset_date = null;
  const a = {
    entity: "project",
    project_id: "p",
    date: null,
    apply: true,
    request_key: "reset",
  };
  assert.equal(
    (await f.writes.execute("project.set_next_review_date", a)).items[0]
      .outcome,
    "rejected",
  );
  assert.equal(f.count, 0);
  const lost = await setup(t, "tag.set_allows_next_action");
  lost.lose = true;
  const b = {
    entity: "tag",
    tag_id: "tag",
    allows_next_action: false,
    apply: true,
    request_key: "lost",
  };
  assert.equal(
    (await lost.writes.execute("tag.set_allows_next_action", b)).items[0]
      .outcome,
    "unknown",
  );
  assert.equal(
    (await lost.writes.execute("tag.set_allows_next_action", b)).items[0]
      .outcome,
    "unknown",
  );
  assert.equal(lost.count, 1);
});
