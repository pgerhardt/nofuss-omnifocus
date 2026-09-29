import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ReadService, resultBytes } from "../dist/service.js";
import {
  GetInput,
  QueryInput,
  selectedFields,
  RESPONSE_BYTES,
  ReadError,
} from "../dist/contract.js";
import { queryHash, encodeCursor, decodeCursor } from "../dist/cursor.js";

const source = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const Status = Object.fromEntries(
  [
    "Available",
    "Blocked",
    "Completed",
    "Dropped",
    "DueSoon",
    "Next",
    "Overdue",
  ].map((s) => [s, { name: s }]),
);
const Kind = { Absolute: {}, DueRelative: {}, Unknown: {} };
function task(id, overrides = {}) {
  return {
    id: { primaryKey: id },
    name: "Task Ω 😀 ’",
    project: null,
    containingProject: null,
    parent: null,
    active: true,
    effectiveActive: true,
    inInbox: true,
    completed: false,
    effectiveCompletionDate: null,
    flagged: false,
    taskStatus: Status.Available,
    added: new Date("2026-01-01T00:00:00.123Z"),
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
    ...overrides,
  };
}
function reader(
  tasks,
  projects = [],
  nativeApp = {
    userVersion: { versionString: "4.9.2" },
    buildVersion: { versionString: "188.3" },
  },
) {
  const op = vm.runInNewContext("(" + source + ")", {
    Project: {
      byIdentifier: (id) =>
        projects.find((p) => p.id.primaryKey === id) ?? null,
    },
    Task: {
      Status,
      Notification: { Kind },
      byIdentifier: (id) => tasks.find((t) => t.id.primaryKey === id) ?? null,
    },
    inbox: tasks.filter((t) => t.inInbox),
    get flattenedTasks() {
      throw Error("Global task scanning is forbidden");
    },
    app: nativeApp,
  });
  return {
    run: async (operation, args) => {
      const frame = JSON.parse(op({ request_id: "test", op: operation, args }));
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => ({}),
  };
}
const q = (more = {}) => ({ entity: "task", scope: "inbox_roots", ...more });
test("local state stays distinct under inherited completion/drop; native API gaps are explicit", async () => {
  const t = task("child", {
    completed: false,
    active: true,
    effectiveActive: false,
    effectiveCompletionDate: new Date("2026-01-01Z"),
    taskStatus: Status.Completed,
  });
  const service = new ReadService(reader([t]), {});
  const row = (
    await service.get({
      ids: ["child"],
      fields: [
        "completed",
        "dropped",
        "effective_completed",
        "effective_dropped",
        "available",
        "planned_at",
      ],
    })
  ).structuredContent.results[0].task;
  assert.equal(row.completed, false);
  assert.equal(row.dropped, false);
  assert.equal(row.effective_completed, true);
  assert.equal(row.effective_dropped, true);
  assert.equal(row.available, false);
  assert.equal(row.unavailable.planned_at.code, "NATIVE_UNAVAILABLE");
  assert.ok(!("planned_at" in row));
});
test("live algorithm: local unfinished roots retain blocked/deferred tasks; completed and dropped filtering is explicit", async () => {
  const service = new ReadService(
    reader([
      task("a", {
        taskStatus: Status.Blocked,
        deferDate: new Date("2099-01-01Z"),
      }),
      task("b", { completed: true }),
      task("c", { active: false }),
      task("child", { inInbox: false, parent: { id: { primaryKey: "a" } } }),
    ]),
    {},
  );
  let p = (await service.query(q())).structuredContent;
  assert.deepEqual(
    p.items.map((t) => t.id),
    ["a"],
  );
  assert.equal(p.items[0].available, false);
  assert.equal(p.items[0].blocked, true);
  p = (await service.query(q({ include_completed: true }))).structuredContent;
  assert.deepEqual(
    p.items.map((t) => t.id),
    ["a", "b"],
  );
});
test("exact IDs include dots, maintain batch association, exclude project roots and never substitute names", async () => {
  const service = new ReadService(
    reader([
      task("repeat.1"),
      task("root", { project: { id: { primaryKey: "project" } } }),
    ]),
    {},
  );
  const r = await service.get({
    ids: ["repeat.1", "missing", "root", "repeat.1"],
  });
  assert.equal(r.isError, true);
  assert.deepEqual(
    r.structuredContent.results.map((x) => x.status),
    ["ok", "not_found", "error", "ok"],
  );
  assert.equal(
    r.structuredContent.results[2].error.code,
    "PROJECT_ROOT_EXCLUDED",
  );
});
test("projection preserves false, zero, null and empty; unselected expensive getters are not touched", async () => {
  const t = task("a");
  Object.defineProperty(t, "noteText", {
    get() {
      throw Error("unavailable");
    },
  });
  const service = new ReadService(reader([t]), {});
  const brief = (await service.get({ ids: ["a"] })).structuredContent.results[0]
    .task;
  assert.equal(brief.flagged, false);
  assert.equal(brief.parent_id, null);
  assert.ok(!("note" in brief));
  assert.ok(!brief.unavailable);
  const detail = (await service.get({ ids: ["a"], view: "detail" }))
    .structuredContent.results[0].task;
  assert.equal(detail.estimated_minutes, 0);
  assert.deepEqual(detail.notifications, []);
  assert.deepEqual(detail.tag_ids, []);
  assert.equal(detail.modified_at, null);
  assert.ok(!("note" in detail));
  assert.equal(detail.unavailable.note.code, "NATIVE_READ_FAILED");
  const selected = (await service.get({ ids: ["a"], fields: [] }))
    .structuredContent.results[0].task;
  assert.deepEqual(selected, { id: "a" });
});
test("text windows preserve Unicode and provide complete targeted continuation", async () => {
  const text = "Ω😀’".repeat(1600);
  const service = new ReadService(
    reader([task("a", { noteText: { string: text } })]),
    {},
  );
  let offset = 0,
    reconstructed = "";
  do {
    const t = (
      await service.get({
        ids: ["a"],
        fields: ["note"],
        text: { field: "note", offset, length: 101 },
      })
    ).structuredContent.results[0].task;
    reconstructed += t.note;
    offset = t.truncated?.note.next_offset ?? null;
  } while (offset !== null);
  assert.equal(reconstructed, text);
  await assert.rejects(
    service.get({ ids: ["a"], fields: [], text: { field: "note", offset: 0 } }),
    /named field selected/,
  );
});
test("complete keyset traversal handles null dates, fractional dates, timestamp ties and query binding", async () => {
  const tasks = [
    task("z"),
    task("b"),
    task("a"),
    task("n", { added: null }),
    task("early", { added: new Date("2026-01-01T00:00:00.122Z") }),
  ];
  const service = new ReadService(reader(tasks), {});
  let cursor,
    ids = [];
  do {
    const p = (
      await service.query(q({ limit: 2, ...(cursor ? { cursor } : {}) }))
    ).structuredContent;
    ids.push(...p.items.map((t) => t.id));
    cursor = p.next_cursor;
    assert.equal(p.has_more, !!cursor);
  } while (cursor);
  assert.deepEqual(ids, ["n", "early", "a", "b", "z"]);
  const first = (await service.query(q({ limit: 2 }))).structuredContent;
  await assert.rejects(
    service.query(
      q({ limit: 2, include_completed: true, cursor: first.next_cursor }),
    ),
    /another query/,
  );
  await assert.rejects(
    service.query(q({ limit: 2, fields: ["note"], cursor: first.next_cursor })),
    /another query/,
  );
});
test("malformed, corrupt and mismatched cursors fail before native reads", () => {
  const args = QueryInput.parse(q()),
    h = queryHash(args);
  for (const s of [
    "%",
    "not-a-cursor",
    Buffer.from("{}").toString("base64url"),
  ])
    assert.throws(() => decodeCursor(s, h), /malformed/);
  const c = encodeCursor(h, { created_at: null, id: "a" });
  assert.deepEqual(decodeCursor(c, h), { created_at: null, id: "a" });
  const broken = JSON.parse(Buffer.from(c, "base64url"));
  broken.after.id = "b";
  assert.throws(
    () =>
      decodeCursor(
        Buffer.from(JSON.stringify(broken)).toString("base64url"),
        h,
      ),
    /malformed/,
  );
});
test("unsupported entities, filters, fields, types and batches reject", () => {
  for (const args of [
    q({ entity: "project" }),
    q({ scope: "all" }),
    q({ available: true }),
    q({ limit: 201 }),
    q({ include_completed: "yes" }),
    q({ fields: ["note_html"] }),
    q({ sort: "name" }),
  ])
    assert.equal(QueryInput.safeParse(args).success, false);
  for (const args of [
    { ids: [] },
    { ids: Array(21).fill("a") },
    { ids: ["a"], tree: true },
    { ids: ["a"], fields: ["repetition"] },
  ])
    assert.equal(GetInput.safeParse(args).success, false);
});
test("response limits yield complete JSON with continuation and retrieve every record", async () => {
  const tasks = Array.from({ length: 25 }, (_, i) =>
    task("t" + String(i).padStart(2, "0"), {
      noteText: { string: "😀\u0000".repeat(1024) },
    }),
  );
  const service = new ReadService(reader(tasks), {});
  let cursor,
    all = [];
  let stops = [];
  do {
    const p = (
      await service.query(
        q({ view: "detail", limit: 200, ...(cursor ? { cursor } : {}) }),
      )
    ).structuredContent;
    assert.ok(resultBytes(p) <= RESPONSE_BYTES);
    all.push(...p.items.map((t) => t.id));
    stops.push(p.stop_reason);
    cursor = p.next_cursor;
  } while (cursor);
  assert.equal(new Set(all).size, 25);
  assert.equal(all.length, 25);
  assert.ok(stops.includes("response_bytes"));
  const get = await service.get({
    ids: tasks.slice(0, 20).map((t) => t.id.primaryKey),
    view: "detail",
  });
  assert.equal(get.structuredContent.results.length, 20);
  assert.ok(get.isError);
  assert.ok(Buffer.byteLength(JSON.stringify(get)) <= RESPONSE_BYTES);
});
test("notifications preserve kind/owner/order and zero metadata; unknown kind is unavailable", async () => {
  const n = {
    id: { primaryKey: "alarm" },
    task: { id: { primaryKey: "a" } },
    kind: Kind.DueRelative,
    initialFireDate: new Date("2026-01-01Z"),
    nextFireDate: null,
    relativeFireOffset: 0,
    repeatInterval: 0,
    isSnoozed: false,
    usesFloatingTimeZone: false,
  };
  const t = task("a", { notifications: [n] });
  const service = new ReadService(reader([t]), {});
  let row = (await service.get({ ids: ["a"], fields: ["notifications"] }))
    .structuredContent.results[0].task;
  assert.equal(row.notifications[0].relative_offset_minutes, 0);
  assert.equal(row.notifications[0].task_id, "a");
  assert.equal(row.notifications[0].absolute_fire_at, null);
  n.kind = Kind.Unknown;
  row = (await service.get({ ids: ["a"], fields: ["notifications"] }))
    .structuredContent.results[0].task;
  assert.equal(row.unavailable.notifications.code, "NATIVE_NOTIFICATION_KIND");
  assert.ok(!("notifications" in row));
});
test("failed selection is an error, not an empty query; worker failure has per-ID outcomes", async () => {
  const t = task("a");
  Object.defineProperty(t, "active", {
    get() {
      throw Error("native failure");
    },
  });
  await assert.rejects(new ReadService(reader([t]), {}).query(q()));
  const service = new ReadService(
    {
      run: async () => {
        throw Error("native down");
      },
      snapshot: () => ({}),
    },
    {},
  );
  const r = await service.get({ ids: ["a", "b"] });
  assert.equal(r.isError, true);
  assert.deepEqual(
    r.structuredContent.results.map((x) => x.status),
    ["error", "error"],
  );
});
test("shared projection fields are stable and detail excludes unsupported recurrence", () => {
  assert.ok(
    selectedFields(GetInput.parse({ ids: ["a"], view: "detail" })).includes(
      "floating_time_zone",
    ),
  );
  assert.ok(
    !selectedFields(GetInput.parse({ ids: ["a"], view: "detail" })).includes(
      "planned_at",
    ),
  );
});

const projectQuery = (more = {}) => ({
  entity: "task",
  scope: "project",
  project_id: "project.1",
  ...more,
});
function projectFixture() {
  const project = { id: { primaryKey: "project.1" }, name: "Same name" };
  const root = task("project.1", { project, inInbox: false });
  const member = (id, overrides = {}) =>
    task(id, {
      inInbox: false,
      containingProject: project,
      parent: root,
      ...overrides,
    });
  const group = member("group");
  const nested = member("nested", {
    parent: group,
    added: new Date("2026-01-01T00:00:00.122Z"),
  });
  const direct = member("direct", { added: null });
  project.task = root;
  project.tasks = [group, direct];
  project.flattenedTasks = [group, nested, direct];
  const other = {
    id: { primaryKey: "project.2" },
    name: "Same name",
    tasks: [],
    flattenedTasks: [],
  };
  const tasks = [root, group, nested, direct, task("unrelated")];
  return { project, other, root, group, nested, direct, tasks, member };
}
test("project exact scope uses native direct/descendant collections, keeps flat groups and excludes roots", async () => {
  const f = projectFixture();
  const service = new ReadService(reader(f.tasks, [f.project, f.other]), {});
  const descendants = (await service.query(projectQuery())).structuredContent;
  assert.deepEqual(
    descendants.items.map((t) => t.id),
    ["direct", "nested", "group"],
  );
  assert.equal(descendants.items[1].parent_id, "group");
  assert.equal(descendants.items[2].parent_id, "project.1");
  assert.ok(descendants.items.every((t) => t.project_id === "project.1"));
  Object.defineProperty(f.project, "flattenedTasks", {
    get() {
      throw Error("Direct scope must not walk descendants");
    },
  });
  const direct = (await service.query(projectQuery({ depth: "direct" })))
    .structuredContent;
  assert.deepEqual(
    direct.items.map((t) => t.id),
    ["direct", "group"],
  );
  const empty = (await service.query(projectQuery({ project_id: "project.2" })))
    .structuredContent;
  assert.equal(empty.returned, 0);
  assert.equal(empty.has_more, false);
  assert.equal(empty.stop_reason, "complete");
  for (const project_id of ["missing", "nested", "Same-name"])
    await assert.rejects(
      service.query(projectQuery({ project_id })),
      (error) =>
        error instanceof ReadError && error.code === "PROJECT_NOT_FOUND",
    );
});
test("project local completion/drop filters do not prune descendants or infer project status", async () => {
  const f = projectFixture();
  f.project.status = "Dropped";
  f.group.completed = true;
  f.nested.effectiveCompletionDate = new Date("2026-01-01Z");
  f.nested.taskStatus = Status.Completed;
  const dropped = f.member("dropped-group", {
    active: false,
    effectiveActive: false,
  });
  const inherited = f.member("inherited-drop", {
    parent: dropped,
    effectiveActive: false,
    taskStatus: Status.Dropped,
  });
  f.project.flattenedTasks.push(dropped, inherited);
  const service = new ReadService(reader(f.tasks, [f.project]), {});
  const unfinished = (await service.query(projectQuery())).structuredContent
    .items;
  assert.deepEqual(
    unfinished.map((t) => t.id),
    ["direct", "nested", "inherited-drop"],
  );
  assert.equal(unfinished[1].completed, false);
  assert.equal(unfinished[1].effective_completed, true);
  assert.equal(unfinished[2].dropped, false);
  assert.equal(unfinished[2].effective_dropped, true);
  assert.ok(unfinished.slice(1).every((t) => !t.available));
  const included = (
    await service.query(projectQuery({ include_completed: true }))
  ).structuredContent.items;
  assert.deepEqual(
    included.map((t) => t.id),
    ["direct", "nested", "group", "inherited-drop"],
  );
});
test("project pages preserve ordering, projection parity, query binding and fresh membership", async () => {
  const f = projectFixture();
  const worker = reader(f.tasks, [f.project, f.other]);
  let reads = 0;
  const run = worker.run;
  worker.run = (...args) => {
    reads++;
    return run(...args);
  };
  const service = new ReadService(worker, {});
  const args = projectQuery({ limit: 1 });
  let cursor,
    items = [];
  do {
    const p = (await service.query({ ...args, ...(cursor ? { cursor } : {}) }))
      .structuredContent;
    assert.equal(p.returned, 1);
    assert.equal(p.has_more, !!p.next_cursor);
    items.push(...p.items);
    cursor = p.next_cursor;
  } while (cursor);
  assert.deepEqual(
    items.map((t) => t.id),
    ["direct", "nested", "group"],
  );
  const detail = (await service.query(projectQuery({ view: "detail" })))
    .structuredContent.items;
  const exact = (
    await service.get({ ids: items.map((t) => t.id), view: "detail" })
  ).structuredContent.results;
  assert.deepEqual(
    detail,
    exact.map((r) => r.task),
  );
  for (const [i, brief] of items.entries())
    for (const [key, value] of Object.entries(brief))
      assert.deepEqual(detail[i][key], value);
  const first = (await service.query(args)).structuredContent;
  const count = reads;
  for (const changed of [
    { ...args, project_id: "project.2" },
    { ...args, depth: "direct" },
    q({ limit: 1 }),
    { ...args, include_completed: true },
    { ...args, limit: 2 },
    { ...args, view: "detail" },
    { ...args, fields: [] },
  ])
    await assert.rejects(
      service.query({ ...changed, cursor: first.next_cursor }),
      /another query/,
    );
  assert.equal(reads, count);
  const next = (
    await service.query({
      ...args,
      depth: "descendants",
      cursor: first.next_cursor,
    })
  ).structuredContent;
  assert.equal(next.items[0].id, "nested");
  f.project.flattenedTasks.push(f.member("new"));
  const fresh = (await service.query(projectQuery({ fields: [] })))
    .structuredContent.items;
  assert.deepEqual(
    fresh,
    ["direct", "nested", "group", "new"].map((id) => ({ id })),
  );
});
test("project inputs are conditional and the original Inbox cursor binding is unchanged", () => {
  for (const args of [
    { entity: "task", scope: "project" },
    projectQuery({ project_id: "" }),
    projectQuery({ project_id: null }),
    projectQuery({ depth: "tree" }),
    q({ project_id: "project.1" }),
    q({ depth: "direct" }),
    projectQuery({ name: "Same name" }),
    projectQuery({ include_dropped: true }),
  ])
    assert.equal(QueryInput.safeParse(args).success, false);
  assert.equal(
    queryHash(QueryInput.parse(q())),
    "2f7522aef60b8348324ed2042fc8e9689b2506f94d025da8fd678cd5114b231f",
  );
  assert.equal(
    queryHash(QueryInput.parse(projectQuery())),
    queryHash(QueryInput.parse(projectQuery({ depth: "descendants" }))),
  );
});
test("project selection failures propagate while selected field failures stay explicit", async () => {
  const f = projectFixture();
  Object.defineProperty(f.nested, "noteText", {
    get() {
      throw Error("note unavailable");
    },
  });
  const service = new ReadService(reader(f.tasks, [f.project]), {});
  const selected = (
    await service.query(projectQuery({ fields: ["note", "planned_at"] }))
  ).structuredContent.items;
  assert.equal(selected[1].unavailable.note.code, "NATIVE_READ_FAILED");
  assert.ok(!("note" in selected[1]));
  assert.equal(selected[1].unavailable.planned_at.code, "NATIVE_UNAVAILABLE");
  Object.defineProperty(f.project, "flattenedTasks", {
    get() {
      throw Error("collection unavailable");
    },
  });
  await assert.rejects(
    service.query(projectQuery()),
    (error) =>
      error instanceof ReadError && error.code === "NATIVE_READ_FAILED",
  );
});
test("project pagination serializes only page-selected records and unselected fields stay unread", async () => {
  const f = projectFixture();
  let nameReads = 0,
    noteReads = 0;
  Object.defineProperty(f.group, "name", {
    get() {
      nameReads++;
      return "group";
    },
  });
  Object.defineProperty(f.direct, "noteText", {
    get() {
      noteReads++;
      return { string: "note" };
    },
  });
  const service = new ReadService(reader(f.tasks, [f.project]), {});
  await service.query(projectQuery({ limit: 1 }));
  assert.equal(nameReads, 0);
  assert.equal(noteReads, 0);
  f.group.completed = true;
  await service.query(projectQuery());
  assert.equal(nameReads, 0);
});
test("project response budgets and Unicode text windows retain every page-selected ID", async () => {
  const f = projectFixture();
  const note = "😀\u0000".repeat(2000);
  f.project.flattenedTasks = Array.from({ length: 8 }, (_, i) =>
    f.member("large" + i, { noteText: { string: note } }),
  );
  const service = new ReadService(reader(f.tasks, [f.project]), {});
  let cursor,
    ids = [],
    stops = [];
  do {
    const r = await service.query(
      projectQuery({
        view: "detail",
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= RESPONSE_BYTES);
    const p = r.structuredContent;
    for (const t of p.items) {
      assert.equal(t.note, Array.from(note).slice(0, 2048).join(""));
      assert.equal(t.truncated.note.next_offset, 2048);
    }
    ids.push(...p.items.map((t) => t.id));
    stops.push(p.stop_reason);
    cursor = p.next_cursor;
  } while (cursor);
  assert.deepEqual(
    ids,
    f.project.flattenedTasks.map((t) => t.id.primaryKey),
  );
  assert.ok(stops.includes("response_bytes"));
});

test("notification minute normalization is version-independent, fractional and unavailable on failed reads", async () => {
  const n = {
    id: { primaryKey: "relative" },
    task: { id: { primaryKey: "a" } },
    kind: Kind.DueRelative,
    initialFireDate: null,
    nextFireDate: null,
    relativeFireOffset: -1800,
    repeatInterval: 0,
    isSnoozed: false,
    usesFloatingTimeZone: false,
    get absoluteFireDate() {
      throw Error("Nonapplicable getter accessed");
    },
  };
  const t = task("a", { notifications: [n] });
  const nativeApp = {
    userVersion: { versionString: "4.9.2" },
    buildVersion: { versionString: "188.3" },
  };
  const service = new ReadService(reader([t], [], nativeApp), {});
  const get = async () =>
    (await service.get({ ids: ["a"], fields: ["notifications"] }))
      .structuredContent.results[0].task;
  for (const [raw, minutes] of [
    [-1800, -30],
    [900, 15],
    [0, 0],
    [-1, -1 / 60],
    [1, 1 / 60],
    [59, 59 / 60],
    [60, 1],
    [61, 61 / 60],
    [Number.MAX_VALUE, Number.MAX_VALUE / 60],
  ]) {
    n.relativeFireOffset = raw;
    const row = await get();
    assert.equal(row.notifications[0].relative_offset_minutes, minutes);
    assert.equal(row.notifications[0].absolute_fire_at, null);
  }
  for (const raw of [Number.MIN_VALUE, NaN, Infinity, undefined]) {
    n.relativeFireOffset = raw;
    const row = await get();
    assert.ok(row.unavailable.notifications);
    assert.ok(!Object.hasOwn(row, "notifications"));
  }
  n.relativeFireOffset = -1800;
  for (const [version, build] of [
    ["4.9.2", "188.4"],
    ["4.9.3", "188.3"],
    [undefined, undefined],
  ]) {
    nativeApp.userVersion.versionString = version;
    nativeApp.buildVersion.versionString = build;
    assert.equal((await get()).notifications[0].relative_offset_minutes, -30);
  }
  // Absolute-only windows do not depend on runtime relative units.
  t.notifications = [
    {
      id: n.id,
      task: n.task,
      kind: Kind.Absolute,
      initialFireDate: null,
      nextFireDate: null,
      absoluteFireDate: null,
      repeatInterval: 0,
      isSnoozed: false,
      usesFloatingTimeZone: false,
    },
  ];
  Object.defineProperty(t.notifications[0], "relativeFireOffset", {
    get() {
      throw Error("Nonapplicable");
    },
  });
  assert.equal((await get()).notifications[0].relative_offset_minutes, null);
  t.notifications = [n];
  nativeApp.userVersion.versionString = "4.9.2";
  nativeApp.buildVersion.versionString = "188.3";
  Object.defineProperty(n, "relativeFireOffset", {
    get() {
      throw Error("Native getter unavailable");
    },
  });
  assert.ok((await get()).unavailable.notifications);
  n.kind = Kind.Unknown;
  assert.equal(
    (await get()).unavailable.notifications.code,
    "NATIVE_NOTIFICATION_KIND",
  );
});
