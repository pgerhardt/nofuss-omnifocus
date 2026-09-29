import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { ReadService, resultBytes } from "../dist/service.js";
import {
  GetInput,
  GetOutput,
  RESPONSE_BYTES,
  ReadError,
  QueryInput,
} from "../dist/contract.js";
import { treeHash, encodeCursor, queryHash } from "../dist/cursor.js";

const source = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const states = Object.fromEntries(
  [
    "Available",
    "Blocked",
    "Completed",
    "Dropped",
    "Next",
    "DueSoon",
    "Overdue",
  ].map((k) => [k, {}]),
);
function setup() {
  const p = {
    id: { primaryKey: "p" },
    name: "Project",
    status: "active",
    sequential: true,
    containsSingletonActions: false,
    parentFolder: null,
    noteText: { string: "project note" },
    tasks: [],
  };
  p.task = { id: p.id, project: p, tasks: p.tasks };
  const all = new Map([["p", p.task]]);
  function add(id, parent = p.task, more = {}) {
    const t = {
      id: { primaryKey: id },
      parent,
      containingProject: p,
      project: null,
      tasks: [],
      name: id,
      inInbox: false,
      active: true,
      effectiveActive: true,
      completed: false,
      effectiveCompletionDate: null,
      flagged: false,
      taskStatus: states.Available,
      added: new Date("2020-01-01T00:00:00.123Z"),
      modified: null,
      completionDate: null,
      dropDate: null,
      dueDate: null,
      deferDate: null,
      effectiveDueDate: null,
      effectiveDeferDate: null,
      noteText: { string: "" },
      tags: [],
      estimatedMinutes: 0,
      sequential: false,
      completedByChildren: false,
      shouldUseFloatingTimeZone: false,
      notifications: [],
      ...more,
    };
    parent.tasks.push(t);
    all.set(id, t);
    return t;
  }
  const op = vm.runInNewContext("(" + source + ")", {
    Project: {
      Status: {
        Active: "active",
        OnHold: "hold",
        Done: "done",
        Dropped: "drop",
      },
      byIdentifier: (id) => (id === "p" ? p : null),
    },
    Task: { Status: states, byIdentifier: (id) => all.get(id) ?? null },
    get flattenedTasks() {
      throw Error("No global scan");
    },
  });
  let calls = 0;
  const worker = {
    run: async (name, args) => {
      calls++;
      const frame = JSON.parse(op({ request_id: "test", op: name, args }));
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => ({}),
  };
  return {
    p,
    all,
    add,
    worker,
    service: new ReadService(worker, {}),
    calls: () => calls,
  };
}
const request = (tree = {}, more = {}) => ({
  entity: "project",
  ids: ["p"],
  fields: [],
  tree,
  ...more,
});
const item = (r) => r.structuredContent.results[0];
async function walk(service, args) {
  const rows = [],
    pages = [];
  let cursor;
  do {
    const r = await service.get({
      ...args,
      tree: { ...args.tree, ...(cursor ? { cursor } : {}) },
    });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.ok(resultBytes(r.structuredContent) <= RESPONSE_BYTES);
    const t = item(r).tree;
    assert.equal(t.returned, t.items.length);
    assert.equal(t.has_more, !!t.next_cursor);
    rows.push(...t.items);
    pages.push(t);
    cursor = t.next_cursor;
    assert.ok(pages.length < 100);
  } while (cursor);
  assert.equal(new Set(rows.map((t) => t.id)).size, rows.length);
  return { rows, pages };
}
test("tree preserves native sibling preorder and all local/ancestor states across tiny pages", async () => {
  const { p, add, service } = setup();
  p.status = "hold";
  const z = add("z", undefined, {
    completed: true,
    taskStatus: states.Completed,
    added: new Date("2025-01-01Z"),
  });
  const a = add("a", z, {
    active: false,
    effectiveActive: false,
    taskStatus: states.Dropped,
  });
  add("c", a, {
    effectiveActive: false,
    effectiveCompletionDate: new Date("2020-01-01Z"),
  });
  add("b");
  const { rows, pages } = await walk(service, request({ limit: 1 }));
  assert.deepEqual(
    rows.map((t) => t.id),
    ["z", "a", "c", "b"],
  );
  assert.deepEqual(
    rows.map((t) => t.parent_id),
    ["p", "z", "a", "p"],
  );
  assert.ok(rows.every((t) => t.project_id === "p"));
  assert.equal(pages.length, 4);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[1].dropped, true);
  assert.equal(rows[2].completed, false);
  assert.equal(rows[2].effective_completed, true);
  assert.equal(rows[2].dropped, false);
  assert.equal(rows[2].effective_dropped, true);
  assert.ok(rows.every((t) => !("note" in t) && !("notifications" in t)));
  for (const r of rows)
    assert.deepEqual(r, item(await service.get({ ids: [r.id] })).task);
});
test("tree projections are independent, retain structure, and avoid off-page or unselected expensive getters", async () => {
  const { add, service } = setup();
  const a = add("a"),
    b = add("b");
  let notes = 0;
  Object.defineProperty(b, "noteText", {
    get() {
      notes++;
      return { string: "next" };
    },
  });
  const first = item(
    await service.get(
      request(
        { view: "detail", fields: ["note"], limit: 1 },
        { fields: ["note"] },
      ),
    ),
  );
  assert.deepEqual(first.project, { id: "p", note: "project note" });
  assert.deepEqual(first.tree.items, [
    { id: "a", note: "", parent_id: "p", project_id: "p" },
  ]);
  assert.equal(notes, 0);
  const minimal = await walk(service, request({ fields: [] }));
  assert.deepEqual(Object.keys(minimal.rows[0]).sort(), [
    "id",
    "parent_id",
    "project_id",
  ]);
  assert.equal(notes, 0);
  Object.defineProperty(a, "noteText", {
    get() {
      throw Error("native gap");
    },
  });
  const unavailable = item(await service.get(request({ fields: ["note"] })))
    .tree.items[0];
  assert.equal(unavailable.unavailable.note.code, "NATIVE_READ_FAILED");
  assert.ok(!("note" in unavailable));
});
test("tree handles empty projects and deep hierarchies without a hierarchy cutoff", async () => {
  const { add, service, p } = setup();
  const empty = item(await service.get(request())).tree;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.has_more, false);
  assert.equal(empty.next_cursor, null);
  let parent = p.task;
  for (let i = 0; i < 2500; i++) parent = add("deep" + i, parent);
  const { rows, pages } = await walk(
    service,
    request({ fields: [], limit: 200 }),
  );
  assert.equal(rows.length, 2500);
  assert.equal(pages.length, 13);
  assert.equal(rows.at(-1).parent_id, "deep2498");
});
test("tree byte continuation preserves Unicode text and all nodes within the full MCP budget", async () => {
  const { add, service, p } = setup();
  const note = '😀Ω"\\\n'.repeat(800);
  p.noteText = { string: note };
  for (let i = 0; i < 20; i++)
    add("n" + i, undefined, { noteText: { string: note } });
  const { rows, pages } = await walk(
    service,
    request({ fields: ["note"], limit: 200 }, { fields: ["note"] }),
  );
  assert.equal(rows.length, 20);
  assert.ok(pages.length > 1);
  assert.ok(
    pages.slice(0, -1).every((t) => t.stop_reason === "response_bytes"),
  );
  assert.equal(rows[0].truncated.note.total, Array.from(note).length);
  let full = "",
    offset = 0;
  do {
    const r = item(
      await service.get({
        ids: ["n0"],
        fields: ["note"],
        text: { field: "note", offset, length: 700 },
      }),
    ).task;
    full += r.note;
    offset = r.truncated?.note.next_offset ?? null;
  } while (offset !== null);
  assert.equal(full, note);
});
test("tree cursor validates bindings and damage before reads; equivalent selected sets normalize", async () => {
  const { add, service, calls } = setup();
  add("a");
  add("b");
  const args = request({ fields: ["name"], limit: 1 });
  const cursor = item(await service.get(args)).tree.next_cursor;
  const before = calls();
  async function cursorError(input, code) {
    const result = await service.get(input);
    assert.equal(result.isError, true);
    assert.equal(item(result).error.code, code);
    assert.equal(result.structuredContent.read_at, null);
    GetOutput.parse(result.structuredContent);
    const validate = new AjvJsonSchemaValidator().getValidator(
      z.toJSONSchema(GetOutput, { target: "draft-7", io: "output" }),
    );
    assert.equal(validate(result.structuredContent).valid, true);
  }
  for (const changed of [
    request({ fields: ["note"], limit: 1 }),
    request({ fields: ["name"], limit: 2 }),
    request({ fields: ["name"], limit: 1, view: "detail" }),
    request(args.tree, { ids: ["other"] }),
    request(args.tree, { fields: ["name"] }),
    request(args.tree, { view: "detail" }),
    request(args.tree, {
      fields: ["note"],
      text: { field: "note", offset: 0 },
    }),
  ]) {
    await cursorError(
      { ...changed, tree: { ...changed.tree, cursor } },
      "CURSOR_QUERY_MISMATCH",
    );
  }
  for (const bad of [
    "!",
    cursor + "=",
    Buffer.from("{}").toString("base64url"),
    encodeCursor(treeHash(GetInput.parse(args)), { id: "a", created_at: null }),
  ]) {
    await cursorError(
      { ...args, tree: { ...args.tree, cursor: bad } },
      "INVALID_CURSOR",
    );
  }
  const queryCursor = encodeCursor(
    queryHash(QueryInput.parse({ entity: "task", scope: "inbox_roots" })),
    { id: "a", created_at: null },
  );
  await cursorError(
    { ...args, tree: { ...args.tree, cursor: queryCursor } },
    "INVALID_CURSOR",
  );
  assert.equal(calls(), before);
  const next = item(
    await service.get({
      ...args,
      tree: {
        fields: ["parent_id", "name", "id", "name", "project_id"],
        limit: 1,
        cursor,
      },
    }),
  ).tree;
  assert.equal(next.items[0].id, "b");
  assert.equal(next.has_more, false);
});
test("tree continuation observes fresh changes and fails explicitly for a removed anchor", async () => {
  const { p, add, service } = setup();
  add("a");
  const b = add("b");
  const args = request({ limit: 1 });
  const cursor = item(await service.get(args)).tree.next_cursor;
  b.name = "fresh";
  add("c");
  assert.equal(
    item(await service.get({ ...args, tree: { ...args.tree, cursor } })).tree
      .items[0].name,
    "fresh",
  );
  p.tasks.shift();
  const r = await service.get({ ...args, tree: { ...args.tree, cursor } });
  assert.equal(r.isError, true);
  assert.equal(item(r).error.code, "CURSOR_STALE");
  assert.ok(!item(r).tree);
});
test("tree rejects invalid modes and exact missing/wrong entities, preserving ordinary batches", async () => {
  const { add, service, calls } = setup();
  add("task");
  for (const args of [
    request({}, { ids: ["p", "p"] }),
    request({}, { entity: "task" }),
    request({ depth: 1 }),
    request({ fields: ["review_interval"] }),
    request({ limit: 0 }),
    request({ limit: 201 }),
  ]) {
    await assert.rejects(service.get(args));
  }
  assert.equal(calls(), 0);
  for (const [id, status, code] of [
    ["missing", "not_found", "NOT_FOUND"],
    ["task", "error", "WRONG_ENTITY"],
  ]) {
    const r = item(await service.get(request({}, { ids: [id] })));
    assert.equal(r.status, status);
    assert.equal(r.error.code, code);
    assert.ok(!r.tree);
  }
  const batch = await service.get({
    entity: "project",
    ids: ["p", "missing", "p"],
    fields: [],
  });
  assert.deepEqual(
    batch.structuredContent.results.map((t) => t.status),
    ["ok", "not_found", "ok"],
  );
  assert.equal(
    item(await service.get({ ids: ["p"] })).error.code,
    "PROJECT_ROOT_EXCLUDED",
  );
});
test("tree fails inconsistent or unavailable structural ownership and duplicate native membership", async () => {
  for (const mutate of [
    (t) => {
      t.parent = null;
    },
    (t) => {
      t.containingProject = null;
    },
    (t) => {
      Object.defineProperty(t, "parent", {
        get() {
          throw Error();
        },
      });
    },
    (t) => {
      t.tasks.push(t);
    },
  ]) {
    const { add, service } = setup();
    mutate(add("a"));
    const r = await service.get(request({ fields: [] }));
    assert.equal(r.isError, true);
    assert.equal(item(r).error.code, "NATIVE_STRUCTURE");
  }
});
test("tree output shares strict typed task schema and mandatory structural fields", async () => {
  const { add, service } = setup();
  add("a");
  const valid = (await service.get(request({ view: "detail" })))
    .structuredContent;
  const schema = z.toJSONSchema(GetOutput, { target: "draft-7", io: "output" });
  assert.ok(schema.definitions.TaskRecord);
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  assert.equal(validate(valid).valid, true);
  for (const [field, value] of [
    ["parent_id", null],
    ["project_id", null],
    ["due_at", "bad"],
    ["notifications", [{}]],
    ["invented", true],
  ]) {
    const invalid = structuredClone(valid);
    invalid.results[0].tree.items[0][field] = value;
    assert.equal(validate(invalid).valid, false, field);
    assert.equal(GetOutput.safeParse(invalid).success, false);
  }
  const missing = structuredClone(valid);
  delete missing.results[0].tree.items[0].parent_id;
  assert.equal(validate(missing).valid, false);
});
test("service rejects inconsistent tree envelopes and enforces final wire budget after cursor serialization", async () => {
  const { add, service } = setup();
  add("a");
  add("b");
  const valid = (await service.get(request())).structuredContent;
  for (const mutate of [
    (t) => {
      t.returned = 0;
    },
    (t) => {
      t.has_more = true;
    },
    (t) => {
      t.items[0].project_id = "foreign";
    },
    (t) => {
      t.items[0].id = t.root_id;
    },
    (t) => {
      t.items.push(t.items[0]);
      t.returned++;
    },
    (t) => {
      t.items[0].parent_id = t.items[0].id;
    },
    (t) => {
      t.items = [];
      t.returned = 0;
      t.has_more = true;
      t.stop_reason = "page_limit";
    },
  ]) {
    const bad = structuredClone(valid);
    mutate(bad.results[0].tree);
    const svc = new ReadService(
      { run: async () => bad, snapshot: () => ({}) },
      {},
    );
    assert.equal(
      item(await svc.get(request())).error.code,
      "INVALID_NATIVE_OUTPUT",
    );
  }
  const huge = structuredClone(valid);
  huge.results[0].tree.items.forEach((t) => {
    t.note = '"'.repeat(8000);
  });
  const svc = new ReadService(
    { run: async () => huge, snapshot: () => ({}) },
    {},
  );
  const trimmed = await svc.get(request());
  assert.ok(!trimmed.isError);
  assert.ok(resultBytes(trimmed.structuredContent) <= RESPONSE_BYTES);
  assert.equal(item(trimmed).tree.items.length, 1);
  assert.equal(item(trimmed).tree.stop_reason, "response_bytes");
  huge.results[0].project.note = '"'.repeat(25000);
  const impossible = await svc.get(request());
  assert.equal(item(impossible).error.code, "RESPONSE_LIMIT");
  assert.ok(!item(impossible).tree);
  assert.ok(!item(impossible).project);
});
