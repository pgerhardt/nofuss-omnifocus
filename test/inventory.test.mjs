import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { ReadService, resultBytes } from "../dist/service.js";
import {
  QueryInput,
  QueryOutput,
  GetOutput,
  ReadError,
  RESPONSE_BYTES,
} from "../dist/contract.js";
const operation = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const launcher = readFileSync(
  new URL("../src/native/launcher.js", import.meta.url),
  "utf8",
);
const Status = {
  Active: "active",
  OnHold: "on_hold",
  Done: "done",
  Dropped: "dropped",
};
function project(id, status = "active", flagged = false) {
  const p = {
    id: { primaryKey: id },
    name: id,
    status,
    flagged,
    sequential: false,
    containsSingletonActions: false,
    parentFolder: null,
    noteText: { string: "" },
    tags: [],
    dueDate: null,
    deferDate: null,
    effectiveDueDate: null,
    effectiveDeferDate: null,
    completionDate: null,
    dropDate: null,
    plannedDate: null,
    shouldUseFloatingTimeZone: false,
    lastReviewDate: null,
    nextReviewDate: null,
  };
  p.task = {
    id: p.id,
    project: p,
    added: new Date("2026-01-01T00:00:00.123Z"),
    modified: null,
  };
  for (const key of ["tasks", "flattenedTasks"])
    Object.defineProperty(p, key, {
      get() {
        throw Error("No child walks for counts");
      },
    });
  return p;
}
function setup(projects, options = {}) {
  const reads = [],
    evaluations = [];
  let vectorCalls = 0;
  const context = {
    Project: {
      Status,
      byIdentifier: (id) =>
        projects.find((p) => p.id.primaryKey === id) ?? null,
    },
    Task: { byIdentifier: () => null },
    get flattenedProjects() {
      reads.push("inventory");
      return projects;
    },
  };
  const run = vm.runInNewContext(launcher + "\nrun", {
    ObjC: { import() {}, unwrap: (v) => v },
    $: {
      NSString: { stringWithContentsOfFileEncodingError: () => operation },
      NSUTF8StringEncoding: 0,
    },
    Application: () => ({
      running: () => true,
      evaluateJavascript: (script) => {
        evaluations.push(
          script.includes("project_select") ? "native" : "native",
        );
        return vm.runInNewContext(script, context);
      },
      defaultDocument: {
        flattenedProjects: {
          whose(predicate) {
            const wanted = predicate._or.map((p) => p.id);
            reads.push(["selection", wanted]);
            // Deliberately reverse JXA order: the independent OmniJS order must not be used for joins.
            const ps = projects
              .filter((p) => wanted.includes(p.id.primaryKey))
              .slice()
              .reverse();
            function ids() {
              vectorCalls++;
              return options.changedIds && vectorCalls > 1
                ? []
                : ps.map((p) => p.id.primaryKey);
            }
            const collection = { id: ids };
            for (const field of [
              "numberOfTasks",
              "numberOfCompletedTasks",
              "reviewInterval",
            ])
              collection[field] = () => {
                reads.push(field);
                if (options.failed === field) throw Error("native failure");
                const values = ps.map((p) =>
                  field === "reviewInterval"
                    ? { unit: "month", steps: 2, fixed: false }
                    : field === "numberOfTasks"
                      ? Number(p.id.primaryKey.slice(1)) || 0
                      : 0,
                );
                return options.shortVector ? values.slice(1) : values;
              };
            if (options.onSelection) options.onSelection(ps);
            return collection;
          },
          byId() {
            throw Error("Inventory must not use per-project native getters");
          },
          properties() {
            throw Error("No full property records");
          },
        },
      },
    }),
  });
  const worker = {
    run: async (op, args) => {
      const frame = JSON.parse(
        run(["operation.js", JSON.stringify({ request_id: "test", op, args })]),
      );
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => ({}),
  };
  return { service: new ReadService(worker, {}), reads, evaluations };
}
const q = (more = {}) => ({ entity: "project", scope: "library", ...more });
async function walk(service, args) {
  let cursor,
    rows = [],
    pages = [];
  do {
    const r = await service.query({ ...args, ...(cursor ? { cursor } : {}) });
    assert.ok(resultBytes(r.structuredContent) <= RESPONSE_BYTES);
    const p = r.structuredContent;
    assert.equal(p.returned, p.items.length);
    assert.equal(p.has_more, !!p.next_cursor);
    assert.equal(p.has_more, p.stop_reason !== "complete");
    rows.push(...p.items);
    pages.push(p);
    cursor = p.next_cursor;
    assert.ok(pages.length < 100);
  } while (cursor);
  assert.equal(new Set(rows.map((p) => p.id)).size, rows.length);
  return { rows, pages };
}
test("inventory includes every status/type/folder and distinguishes omitted, false and combined filters", async () => {
  const ps = Object.values(Status).flatMap((s, i) => [
    project("p" + i * 2, s, false),
    project("p" + (i * 2 + 1), s, true),
  ]);
  ps[0].sequential = true;
  ps[1].containsSingletonActions = true;
  ps[2].parentFolder = { id: { primaryKey: "nested" } };
  const { service } = setup(ps);
  assert.equal((await walk(service, q())).rows.length, 8);
  for (const status of Object.values(Status))
    for (const flagged of [undefined, false, true]) {
      const args = q({
        status,
        ...(flagged === undefined ? {} : { flagged }),
        fields: ["status", "flagged", "folder_id", "type"],
        limit: 1,
      });
      const r = await walk(service, args);
      assert.deepEqual(
        r.rows.map((p) => p.id),
        ps
          .filter(
            (p) =>
              p.status === status &&
              (flagged === undefined || p.flagged === flagged),
          )
          .map((p) => p.id.primaryKey),
      );
    }
  assert.equal((await walk(service, q({ flagged: false }))).rows.length, 4);
  const rows = (await walk(service, q())).rows;
  assert.equal(rows[0].type, "sequential");
  assert.equal(rows[1].type, "single_actions");
  assert.equal(rows[2].folder_id, "nested");
  assert.ok(rows.every((p) => !("flagged" in p))); // Existing project defaults stay unchanged.
});
test("inventory sorts full precision/null/tied dates and traverses small pages without duplicates", async () => {
  const ps = ["z", "a", "n", "x"].map((id) => project(id));
  ps[2].task.added = null;
  ps[3].task.added = new Date("2026-01-01T00:00:00.124Z");
  const { service } = setup(ps);
  const { rows, pages } = await walk(
    service,
    q({ fields: ["created_at"], limit: 1 }),
  );
  assert.deepEqual(
    rows.map((p) => p.id),
    ["n", "a", "z", "x"],
  );
  assert.equal(pages.length, 4);
  assert.equal(rows[3].created_at, "2026-01-01T00:00:00.124Z");
});
test("predicates precede serialization; brief and empty selections avoid supplements and expensive getters", async () => {
  const rejected = project("p0", "done"),
    selected = project("p1"),
    offpage = project("p2");
  let notes = 0;
  for (const p of [rejected, selected, offpage])
    Object.defineProperty(p, "noteText", {
      get() {
        notes++;
        if (p !== selected) throw Error("Off-page detail read");
        return { string: "" };
      },
    });
  const { service, reads } = setup([rejected, selected, offpage]);
  const r = await service.query(
    q({ status: "active", fields: ["note"], limit: 1 }),
  );
  assert.equal(r.structuredContent.items[0].note, "");
  assert.equal(notes, 1);
  assert.ok(!reads.some(Array.isArray));
  const empty = await walk(service, q({ status: "on_hold", view: "detail" }));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.pages.length, 1);
  assert.ok(!reads.some(Array.isArray));
  const brief = await walk(service, q({ status: "active", fields: [] }));
  assert.deepEqual(brief.rows, [{ id: "p1" }, { id: "p2" }]);
  assert.equal(notes, 1);
});
test("requested supplements use bounded same-collection vectors with persistent-ID joins and shared mapping", async () => {
  const { service, reads, evaluations } = setup([
    project("p3"),
    project("p1"),
    project("p2"),
  ]);
  const r = await service.query(
    q({ fields: ["direct_task_count", "review_interval"], limit: 2 }),
  );
  assert.deepEqual(r.structuredContent.items, [
    {
      id: "p1",
      direct_task_count: 1,
      review_interval: { unit: "months", steps: 2, fixed: false },
    },
    {
      id: "p2",
      direct_task_count: 2,
      review_interval: { unit: "months", steps: 2, fixed: false },
    },
  ]);
  assert.equal(evaluations.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(reads.filter(Array.isArray))), [
    ["selection", ["p1", "p2"]],
  ]);
  assert.equal(reads.filter((x) => x === "numberOfTasks").length, 1);
  assert.equal(reads.filter((x) => x === "reviewInterval").length, 1);
  assert.ok(!reads.includes("numberOfCompletedTasks"));
  const zero = await walk(
    setup([project("p0")]).service,
    q({ fields: ["direct_task_count", "direct_completed_task_count"] }),
  );
  assert.deepEqual(zero.rows, [
    { id: "p0", direct_completed_task_count: 0, direct_task_count: 0 },
  ]);
});
test("failed predicates and sort keys fail the inventory; failed output-only fields remain explicitly unavailable", async () => {
  for (const [key, args] of [
    ["status", { status: "active" }],
    ["flagged", { flagged: false }],
  ]) {
    const p = project("p1");
    Object.defineProperty(p, key, {
      get() {
        throw Error("unreadable");
      },
    });
    await assert.rejects(setup([p]).service.query(q(args)), {
      code: "NATIVE_READ_FAILED",
    });
  }
  const bad = project("bad");
  bad.task.added = undefined;
  await assert.rejects(setup([bad]).service.query(q()), {
    code: "NATIVE_UNAVAILABLE",
  });
  const p = project("p1");
  Object.defineProperty(p, "noteText", {
    get() {
      throw Error("missing");
    },
  });
  const r = (await walk(setup([p]).service, q({ fields: ["note"] }))).rows[0];
  assert.ok(!("note" in r));
  assert.equal(r.unavailable.note.code, "NATIVE_READ_FAILED");
});
test("failed or misaligned bulk supplement columns never fabricate counts or empty review records", async () => {
  for (const options of [
    { failed: "numberOfTasks" },
    { changedIds: true },
    { shortVector: true },
  ]) {
    const r = (
      await walk(
        setup([project("p1")], options).service,
        q({ fields: ["direct_task_count", "review_interval"] }),
      )
    ).rows[0];
    assert.equal(r.unavailable.direct_task_count.code, "NATIVE_READ_FAILED");
    assert.ok(!("direct_task_count" in r));
    if (options.failed) assert.equal(r.review_interval.fixed, false);
    else assert.ok(!("review_interval" in r));
  }
  const { service } = setup([project("p1")], {
    onSelection: (ps) => {
      ps[0].status = "done";
    },
  });
  await assert.rejects(
    service.query(q({ status: "active", fields: ["direct_task_count"] })),
    { code: "INVENTORY_CHANGED" },
  );
});
test("project cursors bind entity, scope, filters, fields, view and limit; fresh pages observe changes", async () => {
  const ps = [project("p1"), project("p2")],
    { service } = setup(ps),
    args = q({ limit: 1 });
  const cursor = (await service.query(args)).structuredContent.next_cursor;
  for (const change of [
    { status: "active" },
    { flagged: false },
    { flagged: true },
    { view: "detail" },
    { fields: [] },
    { limit: 2 },
  ])
    await assert.rejects(service.query({ ...args, ...change, cursor }), {
      code: "CURSOR_QUERY_MISMATCH",
    });
  await assert.rejects(
    service.query({ entity: "task", scope: "inbox_roots", limit: 1, cursor }),
    { code: "CURSOR_QUERY_MISMATCH" },
  );
  await assert.rejects(service.query({ ...args, cursor: "!" }), {
    code: "INVALID_CURSOR",
  });
  ps[1].name = "new value";
  assert.equal(
    (await service.query({ ...args, cursor })).structuredContent.items[0].name,
    "new value",
  );
});
test("project byte continuation retains Unicode notes and complete membership", async () => {
  const ps = Array.from({ length: 18 }, (_, i) => project("p" + i));
  for (const p of ps) p.noteText = { string: '😀Ω\"'.repeat(1800) };
  const { rows, pages } = await walk(
    setup(ps).service,
    q({ view: "detail", limit: 200 }),
  );
  assert.equal(rows.length, 18);
  assert.ok(pages.length > 1);
  assert.ok(
    pages.slice(0, -1).every((p) => p.stop_reason === "response_bytes"),
  );
  assert.ok(rows.every((r) => r.truncated.note.next_offset === 2048));
  assert.equal(
    rows[0].note,
    Array.from(ps[0].noteText.string).slice(0, 2048).join(""),
  );
});
test("conditional inputs and shared project output references preserve strict field validation", async () => {
  for (const more of [
    { scope: "project" },
    { scope: "inbox_roots" },
    { include_completed: false },
    { depth: "direct" },
    { project_id: "p" },
    { fields: ["notifications"] },
    { fields: ["parent_id"] },
    { status: "completed" },
    { flagged: null },
    { unknown: 1 },
  ])
    assert.equal(QueryInput.safeParse(q(more)).success, false);
  for (const more of [
    { status: "active" },
    { flagged: "false" },
    { fields: ["review_interval"] },
  ])
    assert.equal(
      QueryInput.safeParse({ entity: "task", scope: "inbox_roots", ...more })
        .success,
      false,
    );
  const schema = z.toJSONSchema(QueryOutput, {
    target: "draft-7",
    io: "output",
  });
  assert.ok(schema.definitions.ProjectRecord);
  assert.ok(schema.definitions.TaskRecord);
  const validate = new AjvJsonSchemaValidator().getValidator(schema),
    r = (await setup([project("p1")]).service.query(q({ view: "detail" })))
      .structuredContent;
  assert.equal(validate(r).valid, true);
  for (const [field, value] of [
    ["flagged", 0],
    ["review_interval", { unit: "days", steps: 1, fixed: null }],
    ["direct_task_count", -1],
    ["invented", true],
  ]) {
    const bad = structuredClone(r);
    bad.items[0][field] = value;
    assert.equal(validate(bad).valid, false, field);
    assert.equal(QueryOutput.safeParse(bad).success, false);
  }
  const exact = await setup([project("p1")]).service.get({
    entity: "project",
    ids: ["p1"],
    fields: ["flagged"],
  });
  GetOutput.parse(exact.structuredContent);
  assert.equal(exact.structuredContent.results[0].project.flagged, false);
});

test("byte-selected base records bound supplement rows and reuse output reads without weakening ID safeguards", async () => {
  const ps = Array.from({ length: 100 }, (_, i) => project("p" + i));
  let noteReads = 0;
  for (const p of ps)
    Object.defineProperty(p, "noteText", {
      get() {
        noteReads++;
        return { string: "n".repeat(1000) };
      },
    });
  const { service, reads } = setup(ps);
  const page = (await service.query(q({ view: "detail", limit: 200 })))
    .structuredContent;
  const prepared = reads.find(
    (r) => Array.isArray(r) && r[0] === "selection",
  )[1];
  assert.ok(
    prepared.length < ps.length / 2,
    "supplements are byte-selected, not all item-limit candidates",
  );
  assert.ok(prepared.length >= page.returned);
  assert.equal(
    noteReads,
    prepared.length + 1,
    "base records and one byte lookahead are read once; final pass reuses them",
  );
  assert.equal(page.stop_reason, "response_bytes");
  assert.ok(page.next_cursor);
  assert.ok(
    page.items.every((p) => p.note === "n".repeat(1000) && !p.unavailable),
  );
});
