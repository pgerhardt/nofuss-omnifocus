import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrdinaryTasks } from "../dist/ordinary-tasks.js";
import { NoFussCore } from "../dist/core.js";
import { runCli } from "../dist/cli-command.js";
import { mcpResult } from "../dist/service.js";
async function setup(t, kind = "task.uncomplete", projectId = "t") {
  const directory = await mkdtemp(join(tmpdir(), "nfo-ordinary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: [kind],
      project_ids: ["p"],
      allow_project_creation: true,
    }),
    { mode: 0o600 },
  );
  const before = {
    id: "t",
    root_project: null,
    rows: [
      {
        id: "t",
        name: "ordinary",
        parent_id: "p",
        project_id: "p",
        child_ids: [],
        completed: kind === "task.uncomplete",
        completion: kind === "task.uncomplete" ? "2026-01-01T00:00:00Z" : null,
        drop: kind === "task.undrop" ? "2026-01-01T00:00:00Z" : null,
        effective_completion:
          kind === "task.uncomplete" ? "2026-01-01T00:00:00Z" : null,
        effective_drop: kind === "task.undrop" ? "2026-01-01T00:00:00Z" : null,
        repeat: false,
        auto: false,
        tentative: false,
        attachments: 0,
        notifications: 0,
        due: null,
        effective_due: null,
        planned: null,
        effective_planned: null,
        defer: null,
        effective_defer: null,
        note_runs: [],
      },
    ],
    ancestors: [],
    sibling_ids: ["t"],
  };
  let state = structuredClone(before),
    count = 0,
    lose = false,
    wrong = false;
  const native = {
    snapshot: () => ({}),
    run: async (op, a) => {
      if (op === "ordinary_task_facts")
        return {
          reference: a.reference,
          facts:
            a.reference.entity === "task"
              ? structuredClone(state)
              : { id: a.reference.id, child_ids: [] },
        };
      if (op === "ordinary_task_apply") {
        count++;
        if (kind === "task.convert_to_project") {
          state.root_project = projectId;
          state.rows[0].parent_id = null;
          state.rows[0].project_id = projectId;
        } else
          Object.assign(state.rows[0], {
            completed: false,
            completion: null,
            drop: null,
            effective_completion: null,
            effective_drop: null,
          });
        if (lose) throw Error("lost receipt");
        return {
          request_key: a.request.request_key,
          input_hash: a.input_hash,
          finished: true,
          setter_count: 1,
          resource_id: wrong
            ? "other"
            : kind === "task.convert_to_project"
              ? projectId
              : "t",
          error: null,
        };
      }
      if (op === "ordinary_task_readback")
        return {
          source: structuredClone(state),
          source_order: [],
          old_ancestors: [],
          destination: { child_ids: [projectId] },
          project:
            kind === "task.convert_to_project"
              ? {
                  id: projectId,
                  root_id: "t",
                  folder_id: null,
                  status: "active",
                }
              : null,
        };
      throw Error("unexpected native operation");
    },
  };
  return {
    directory,
    native,
    writes: new OrdinaryTasks(native, directory),
    before,
    get count() {
      return count;
    },
    get state() {
      return state;
    },
    set lose(x) {
      lose = x;
    },
    set wrong(x) {
      wrong = x;
    },
  };
}
for (const op of ["task.uncomplete", "task.undrop", "task.convert_to_project"])
  test(
    "ordinary " +
      op +
      " exact state/identity proof and durable core/CLI/MCP result replay",
    async (t) => {
      const f = await setup(t, op),
        core = new NoFussCore(f.native, {}, f.directory),
        args = {
          entity: "task",
          task_id: "t",
          apply: true,
          request_key: "one",
          ...(op === "task.convert_to_project"
            ? { destination: { entity: "library", id: "library" } }
            : {}),
        };
      const r = await core.execute(op, args);
      assert.equal(r.items[0].outcome, "applied", JSON.stringify(r));
      assert.equal(
        r.items[0].resource.entity,
        op === "task.convert_to_project" ? "project" : "task",
      );
      assert.deepEqual(await core.execute(op, args), r);
      const cli = await runCli(
        [op.split(".")[1], "task", "--input", "-", "--apply"],
        core,
        async () => args,
      );
      assert.equal(cli.exitCode, 0, cli.json);
      assert.deepEqual(JSON.parse(cli.json), r);
      assert.deepEqual(mcpResult(r).structuredContent, r);
      assert.equal(f.count, 1);
    },
  );
test("ordinary restoration rejects effective-only/history/repeating states and full stale snapshot before dispatch", async (t) => {
  for (const change of [
    { completed: false },
    { repeat: true },
    { auto: true },
  ]) {
    const f = await setup(t);
    Object.assign(f.state.rows[0], change);
    assert.equal(
      (
        await f.writes.execute("task.uncomplete", {
          entity: "task",
          task_id: "t",
          apply: true,
          request_key: "bad",
        })
      ).items[0].outcome,
      "rejected",
    );
    assert.equal(f.count, 0);
  }
  const f = await setup(t);
  const p = await f.writes.execute("task.uncomplete", {
    entity: "task",
    task_id: "t",
  });
  f.state.rows[0].name = "changed";
  assert.equal(
    (
      await f.writes.execute("task.uncomplete", {
        ...p.apply_input,
        apply: true,
        request_key: "stale",
      })
    ).items[0].outcome,
    "conflict",
  );
  assert.equal(f.count, 0);
});
test("lost conversion receipt and wrong restoration resource retain unknown with no blind replay", async (t) => {
  for (const kind of ["task.convert_to_project", "task.uncomplete"]) {
    const f = await setup(t, kind);
    f.lose = kind === "task.convert_to_project";
    f.wrong = !f.lose;
    const a = {
      entity: "task",
      task_id: "t",
      apply: true,
      request_key: "uncertain",
      ...(kind === "task.convert_to_project"
        ? { destination: { entity: "library", id: "library" } }
        : {}),
    };
    const r = await f.writes.execute(kind, a);
    assert.equal(r.items[0].outcome, "unknown");
    assert.equal((await f.writes.execute(kind, a)).items[0].outcome, "unknown");
    assert.equal(f.count, 1);
  }
});

test("conversion proves distinct project/root identities and rejects an unrelated receipt without exporting it", async (t) => {
  for (const wrong of [false, true]) {
    const f = await setup(t, "task.convert_to_project", "distinct-project");
    f.wrong = wrong;
    const args = {
      entity: "task",
      task_id: "t",
      destination: { entity: "library", id: "library" },
      apply: true,
      request_key: "distinct",
    };
    const result = await f.writes.execute("task.convert_to_project", args);
    assert.equal(result.items[0].outcome, wrong ? "unknown" : "applied");
    if (wrong) assert.equal(result.items[0].resource, undefined);
    else
      assert.deepEqual(result.items[0].resource, {
        entity: "project",
        id: "distinct-project",
      });
    const replay = await f.writes.execute("task.convert_to_project", args);
    if (wrong) assert.equal(replay.items[0].outcome, "unknown");
    else assert.deepEqual(replay, result);
    assert.equal(f.count, 1);
  }
});
test("conversion rejects inherited planned date before dispatch", async (t) => {
  const f = await setup(t, "task.convert_to_project");
  f.state.rows[0].effective_planned = "2026-10-02T12:00:00.000Z";
  const result = await f.writes.execute("task.convert_to_project", {
    entity: "task",
    task_id: "t",
    destination: { entity: "library", id: "library" },
    apply: true,
    request_key: "inherited-planned",
  });
  assert.equal(result.items[0].outcome, "rejected");
  assert.equal(f.count, 0);
});

test("undrop scripting setter rechecks source container after OmniJS preflight", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(
    new URL("../src/native/launcher.js", import.meta.url),
    "utf8",
  );
  for (const current of ["p", "unowned", null]) {
    let setters = 0;
    const receipt = {
      request_key: "container",
      input_hash: "hash",
      finished: true,
      setter_count: 0,
      resource_id: "t",
      error: null,
    };
    const task = {
      id: () => "t",
      dropped: () => true,
      completed: () => false,
      containingProject: () =>
        current === null
          ? { class: () => "document" }
          : {
              class: () => {
                throw Error("native Project class quirk");
              },
              id: () => current,
            },
    };
    const of = {
      running: () => true,
      evaluateJavascript: () =>
        JSON.stringify({ request_id: "x", result: receipt }),
      defaultDocument: { flattenedTasks: { byId: () => task } },
      markIncomplete: () => setters++,
    };
    const context = vm.createContext({
      ObjC: { import: () => {}, unwrap: (v) => v },
      $: {
        NSUTF8StringEncoding: 4,
        NSString: { stringWithContentsOfFileEncodingError: () => "" },
      },
      Application: () => of,
    });
    vm.runInContext(source, context);
    const result = JSON.parse(
      context.run([
        "operation.js",
        JSON.stringify({
          request_id: "x",
          op: "ordinary_task_apply",
          args: {
            request: { operation: { kind: "task.undrop" } },
            plan: {
              items: [
                { payload: { baseline: { rows: [{ project_id: "p" }] } } },
              ],
            },
          },
        }),
      ]),
    );
    assert.equal(setters, current === "p" ? 1 : 0);
    assert.equal(result.result.setter_count, setters);
  }
});
test("ordinary native facts reject named styles, unreadable dates and excess UTF-8 snapshot bytes", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const source = readFileSync(
    new URL("../src/native/ordinary-task-operation.js", import.meta.url),
    "utf8",
  );
  const make = (k, note = "plain") => ({
    id: { primaryKey: k },
    parent: null,
    project: null,
    containingProject: null,
    name: "task",
    note,
    flagged: false,
    tags: [],
    dueDate: null,
    deferDate: null,
    plannedDate: null,
    effectivePlannedDate: null,
    estimatedMinutes: null,
    completed: false,
    completionDate: null,
    dropDate: null,
    effectiveCompletionDate: null,
    effectiveDropDate: null,
    effectiveDueDate: null,
    effectiveDeferDate: null,
    shouldUseFloatingTimeZone: false,
    sequential: false,
    completedByChildren: false,
    repetitionRule: null,
    assignedContainer: null,
    attachments: [],
    notifications: [],
    children: [],
    noteText: {
      attributeRuns: [
        {
          string: note,
          style: { namedStyles: [], locallyDefinedAttributes: [] },
        },
      ],
    },
  });
  for (const mode of ["named", "unknown-date", "bytes"]) {
    const t = make("t", mode === "bytes" ? "界".repeat(2000) : "plain");
    if (mode === "named") t.noteText.attributeRuns[0].style.namedStyles = [{}];
    if (mode === "unknown-date") t.effectivePlannedDate = undefined;
    if (mode === "bytes") {
      const c = make("c", "界".repeat(2000));
      c.parent = t;
      t.children = [c];
    }
    const result = JSON.parse(
      vm.runInNewContext(
        "(" +
          source +
          ")(" +
          JSON.stringify({
            request_id: "x",
            op: "ordinary_task_facts",
            args: { reference: { entity: "task", id: "t" } },
          }) +
          ")",
        {
          Task: { byIdentifier: () => t },
          inbox: [t],
          Data: { fromString: (s) => Buffer.from(s) },
          Style: { Attribute: { Link: { key: "link" } } },
        },
      ),
    );
    assert.ok(result.error, mode);
  }
});
test("rejected conversion does not report an uncreated project resource", async (t) => {
  const f = await setup(t, "task.convert_to_project");
  const run = f.native.run;
  f.native.run = async (op, args) =>
    op === "ordinary_task_apply"
      ? {
          request_key: args.request.request_key,
          input_hash: args.input_hash,
          finished: true,
          setter_count: 0,
          resource_id: "t",
          error: { code: "WRITE_NOT_AUTHORIZED", message: "revoked" },
        }
      : run(op, args);
  const result = await f.writes.execute("task.convert_to_project", {
    entity: "task",
    task_id: "t",
    destination: { entity: "library", id: "library" },
    apply: true,
    request_key: "rejected-conversion",
  });
  assert.equal(result.items[0].outcome, "rejected");
  assert.equal(result.items[0].resource, undefined);
  assert.equal(f.count, 0);
});
