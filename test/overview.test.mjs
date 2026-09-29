import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { ReadService, resultBytes } from "../dist/service.js";
import {
  OverviewInput,
  OverviewOutput,
  ReadError,
  RESPONSE_BYTES,
} from "../dist/contract.js";

const source = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const launcher = readFileSync(
  new URL("../src/native/launcher.js", import.meta.url),
  "utf8",
);
const statuses = Object.fromEntries(
  [
    "Available",
    "Next",
    "DueSoon",
    "Overdue",
    "Blocked",
    "Completed",
    "Dropped",
  ].map((k) => [k, {}]),
);
const projectStatuses = {
  Active: "active",
  OnHold: "on_hold",
  Done: "done",
  Dropped: "dropped",
};
const now = "2026-09-28T12:00:00.000Z";
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
}
function task(status, more = {}) {
  return { taskStatus: statuses[status], ...more };
}
// OmniJS collections are array-like host objects, not necessarily JS arrays.
function collection(values) {
  return Object.assign({ length: values.length }, values);
}
function project(id, tasks = [], more = {}) {
  return {
    id: { primaryKey: id },
    name: id,
    status: "active",
    nextReviewDate: null,
    flattenedTasks: collection(tasks),
    ...more,
  };
}
function unreadable(object, field) {
  Object.defineProperty(object, field, {
    configurable: true,
    get() {
      throw Error("private native detail");
    },
  });
}
function setup(projects = [], inbox = [], tags = [], extra = {}) {
  const calls = [],
    evaluations = [];
  const context = {
    Date: Clock,
    Project: {
      Status: projectStatuses,
      byIdentifier: (id) =>
        projects.find((p) => p.id.primaryKey === id) ?? null,
    },
    Task: { Status: statuses, byIdentifier: () => null },
    Tag: {
      byIdentifier: (id) => tags.find((t) => t.id.primaryKey === id) ?? null,
    },
    Folder: { byIdentifier: () => null },
    flattenedProjects: projects,
    inbox,
    get flattenedTasks() {
      throw Error("No global task scan");
    },
  };
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(extra));
  const run = vm.runInNewContext(launcher + "\nrun", {
    ObjC: { import() {}, unwrap: (v) => v },
    $: {
      NSString: { stringWithContentsOfFileEncodingError: () => source },
      NSUTF8StringEncoding: 0,
    },
    Application: () => ({
      running: () => true,
      evaluateJavascript(script) {
        evaluations.push(script);
        return vm.runInNewContext(script, context);
      },
      get defaultDocument() {
        throw Error("No native supplement for overview");
      },
    }),
  });
  const worker = {
    async run(op, args) {
      calls.push(op);
      const frame = JSON.parse(
        run(["operation.js", JSON.stringify({ request_id: "test", op, args })]),
      );
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => ({}),
  };
  return { service: new ReadService(worker, {}), worker, calls, evaluations };
}
const data = async (service) => (await service.overview({})).structuredContent;

test("overview returns every active project in one native operation, including inactive folders, without a 25-item preview", async () => {
  const ps = Array.from({ length: 40 }, (_, i) =>
    project("p" + String(i).padStart(2, "0")),
  );
  ps[0].parentFolder = { active: false }; // Local Project.Status, not effective folder state.
  ps.push(
    ...["on_hold", "done", "dropped"].map((status) =>
      project(status, [], { status }),
    ),
  );
  const { service, calls, evaluations } = setup(ps.reverse(), [
    {
      active: true,
      completed: false,
      tasks: [{ active: true, completed: false }],
    },
    { active: true, completed: true },
    { active: false, completed: false },
    { active: false, completed: true },
  ]);
  const r = await data(service);
  assert.equal(r.counts.inbox_unfinished, 1);
  assert.equal(r.counts.active_projects, 40);
  assert.deepEqual(
    r.projects.map((p) => p.id),
    Array.from({ length: 40 }, (_, i) => "p" + String(i).padStart(2, "0")),
  );
  assert.deepEqual(r.coverage, {
    returned: 40,
    complete: true,
    reason: "complete",
  });
  assert.deepEqual(calls, ["overview"]);
  assert.equal(evaluations.length, 1);
  assert.ok(r.projects.every((p) => p.work_state === "no_remaining_work"));
});

test("native effective task statuses classify descendants and groups without counting roots or pruning blocked ancestors", async () => {
  const ps = [
    project("empty"),
    project("inherited", [
      task("Completed", { completed: false }),
      task("Dropped", { active: true }),
    ]),
    project("sequential", [task("Next"), task("Blocked")]),
    project("nested", [
      task("Blocked", { hasChildren: true }),
      task("Available"),
    ]),
    project("deferred", [task("Blocked")]),
    project("held_tag", [task("Completed"), task("Blocked"), task("Dropped")]),
    project("group", [
      task("Available", { hasChildren: true }),
      task("Completed"),
    ]),
    ...["DueSoon", "Overdue"].map((s) => project(s, [task(s)])),
  ];
  for (const p of ps) unreadable(p, "task"); // Root availability cannot establish an action.
  const r = await data(setup(ps).service),
    rows = Object.fromEntries(r.projects.map((p) => [p.id, p]));
  assert.equal(r.counts.remaining_without_available_action, 2);
  for (const id of ["empty", "inherited"])
    assert.equal(rows[id].work_state, "no_remaining_work");
  for (const id of ["sequential", "nested", "group", "DueSoon", "Overdue"])
    assert.equal(rows[id].work_state, "available_action");
  for (const id of ["deferred", "held_tag"])
    assert.equal(rows[id].work_state, "remaining_without_available_action");
});

test("review uses one evaluation instant, inclusive due boundary, and distinct unscheduled null", async () => {
  const ps = [
    project("past", [], {
      nextReviewDate: new Date("2026-09-28T11:59:59.999Z"),
    }),
    project("equal", [], { nextReviewDate: new Date(now) }),
    project("future", [], {
      nextReviewDate: new Date("2026-09-28T12:00:00.001Z"),
    }),
    project("unscheduled"),
  ];
  const r = await data(setup(ps).service);
  assert.equal(r.evaluated_at, now);
  assert.equal(r.consistency, "live");
  assert.equal(r.counts.review_due, 2);
  assert.deepEqual(
    r.projects.map((p) => [p.id, p.review_due]),
    [
      ["equal", true],
      ["future", false],
      ["past", true],
      ["unscheduled", false],
    ],
  );
  assert.equal(r.projects[3].next_review_at, null);
});

test("failed Inbox, review and work reads return unavailable counts rather than successful zero or partial counts", async () => {
  const bad = project("bad"),
    good = project("good", [task("Blocked")], {
      nextReviewDate: new Date(now),
    });
  unreadable(bad, "nextReviewDate");
  unreadable(bad, "flattenedTasks");
  unreadable(bad, "name");
  const inbox = [{ active: true, completed: false }, {}];
  unreadable(inbox[1], "active");
  const r = await data(setup([good, bad], inbox).service);
  assert.deepEqual(r.counts, {
    inbox_unfinished: null,
    active_projects: 2,
    review_due: null,
    remaining_without_available_action: null,
  });
  for (const field of [
    "inbox_unfinished",
    "review_due",
    "remaining_without_available_action",
  ])
    assert.ok(r.unavailable[field]);
  for (const field of ["name", "next_review_at", "review_due", "work_state"]) {
    assert.ok(r.projects[0].unavailable[field]);
    assert.ok(!(field in r.projects[0]));
  }
  assert.equal(r.projects[1].review_due, true);
  assert.equal(r.projects[1].work_state, "remaining_without_available_action");
  assert.ok(!JSON.stringify(r).includes("private native detail"));
});

test("unknown project status or identity fails membership; unknown task status makes classification unavailable", async () => {
  for (const p of [
    project("bad", [], { status: "new" }),
    project("bad", [], { id: {} }),
  ])
    await assert.rejects(data(setup([p]).service));
  const p = project("bad");
  unreadable(p, "status");
  await assert.rejects(data(setup([p]).service), {
    code: "NATIVE_READ_FAILED",
  });
  await assert.rejects(
    data(setup([project("same"), project("same")]).service),
    { code: "NATIVE_STRUCTURE" },
  );
  const r = await data(setup([project("bad", [{ taskStatus: {} }])]).service);
  assert.equal(r.counts.remaining_without_available_action, null);
  assert.equal(r.projects[0].unavailable.work_state.code, "NATIVE_STATUS");
});

test("empty library and Inbox produce complete zero counts, not missing facts", async () => {
  const r = await data(setup().service);
  assert.deepEqual(r.counts, {
    inbox_unfinished: 0,
    active_projects: 0,
    review_due: 0,
    remaining_without_available_action: 0,
  });
  assert.deepEqual(r.projects, []);
  assert.deepEqual(r.coverage, {
    returned: 0,
    complete: true,
    reason: "complete",
  });
  assert.ok(!r.unavailable);
});

test("overview reads required facts once, short-circuits proven availability, and avoids output-only metadata", async () => {
  const reads = {},
    p = project("p");
  for (const [key, value] of Object.entries(p))
    Object.defineProperty(p, key, {
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
      },
      configurable: true,
    });
  const first = task("Available"),
    second = {};
  unreadable(second, "taskStatus");
  Object.defineProperty(p, "flattenedTasks", {
    get() {
      reads.flattenedTasks = (reads.flattenedTasks ?? 0) + 1;
      return collection([first, second]);
    },
  });
  for (const key of [
    "noteText",
    "tags",
    "task",
    "reviewInterval",
    "lastReviewDate",
    "numberOfAvailableTasks",
    "tasks",
    "sequential",
    "containsSingletonActions",
  ])
    unreadable(p, key);
  const r = await data(setup([p]).service);
  assert.equal(r.projects[0].work_state, "available_action");
  assert.ok(!r.unavailable);
  assert.deepEqual(reads, {
    status: 1,
    id: 1,
    nextReviewDate: 1,
    flattenedTasks: 1,
    name: 1,
  });
});

test("byte-limited lists retain full-scope counts and usable drilldown without creating continuation pages", async () => {
  const ps = Array.from({ length: 180 }, (_, i) =>
    project("p" + String(i).padStart(3, "0"), [task("Blocked")], {
      name: '😀\\"'.repeat(300),
      nextReviewDate: new Date(now),
    }),
  );
  const { service } = setup(ps);
  const r = await data(service);
  assert.equal(r.counts.active_projects, 180);
  assert.equal(r.counts.review_due, 180);
  assert.equal(r.counts.remaining_without_available_action, 180);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.reason, "response_bytes");
  assert.ok(r.coverage.drilldown.includes("nofuss_get"));
  assert.equal(r.coverage.returned, r.projects.length);
  assert.ok(r.projects.length > 0 && r.projects.length < 180);
  assert.ok(resultBytes(r) <= RESPONSE_BYTES);
  assert.ok(!("next_cursor" in r));
  const row = r.projects[0];
  assert.ok(row.truncated.name.next_cursor);
  const next = (
    await service.get({
      entity: "project",
      ids: [row.id],
      fields: ["name"],
      text: { field: "name", cursor: row.truncated.name.next_cursor },
    })
  ).structuredContent.results[0].project;
  assert.equal(next.truncated.name.offset, row.truncated.name.next_offset);
  assert.equal(row.name + next.name, ps[0].name);
});

test("classification continues beyond the native list bound and late failures invalidate whole-scope counts", async () => {
  const ps = Array.from({ length: 500 }, (_, i) =>
    project("p" + String(i).padStart(3, "0"), [], { name: "x".repeat(512) }),
  );
  unreadable(ps.at(-1), "nextReviewDate");
  unreadable(ps.at(-1), "flattenedTasks");
  unreadable(ps.at(-1), "name");
  const r = await data(setup(ps).service);
  assert.equal(r.counts.active_projects, 500);
  assert.equal(r.counts.review_due, null);
  assert.equal(r.counts.remaining_without_available_action, null);
  assert.equal(r.coverage.complete, false);
  assert.ok(r.projects.every((p) => !p.unavailable));
  assert.ok(resultBytes(r) <= RESPONSE_BYTES);
});

test("overview input/output schemas stay strict and malformed native associations are rejected", async () => {
  for (const input of [
    { limit: 25 },
    { cursor: "x" },
    { view: "detail" },
    { waiting_tag_ids: [] },
    { entity: "project" },
  ])
    assert.equal(OverviewInput.safeParse(input).success, false);
  const good = await data(setup([project("p")]).service);
  const validate = new AjvJsonSchemaValidator().getValidator(
    z.toJSONSchema(OverviewOutput, { target: "draft-7", io: "output" }),
  );
  assert.equal(validate(good).valid, true);
  for (const change of [
    (r) => (r.counts.active_projects = -1),
    (r) => (r.projects[0].work_state = "waiting"),
    (r) => (r.projects[0].note = "private"),
    (r) => (r.unknown = 1),
  ]) {
    const r = structuredClone(good);
    change(r);
    assert.equal(validate(r).valid, false);
    assert.equal(OverviewOutput.safeParse(r).success, false);
  }
  for (const change of [
    (r) => (r.coverage.returned = 0),
    (r) => (r.counts.active_projects = 0),
    (r) => (r.counts.review_due = 2),
    (r) => (r.counts.review_due = null),
    (r) => delete r.projects[0].name,
    (r) => {
      r.projects.push({ ...r.projects[0] });
      r.counts.active_projects = 2;
      r.coverage.returned = 2;
    },
    (r) => {
      r.coverage.complete = false;
      r.coverage.reason = "response_bytes";
    },
  ]) {
    const r = structuredClone(good);
    change(r);
    const service = new ReadService(
      { run: async () => r, snapshot: () => ({}) },
      {},
    );
    await assert.rejects(data(service), { code: "INVALID_NATIVE_OUTPUT" });
  }
});

// Waiting fixtures are test-only; they do not create or alter native data.
const tag = (id) => ({ id: { primaryKey: id } });
function tagged(id, status, tags = [], owner = null, more = {}) {
  return task(status, {
    id: { primaryKey: id },
    tags: collection(tags),
    project: null,
    containingProject: owner === null ? null : { id: { primaryKey: owner } },
    parent: owner === null ? null : { id: { primaryKey: owner } },
    inInbox: owner === null,
    active: true,
    completed: false,
    ...more,
  });
}
const configured = async (service, ids = ["wait"]) =>
  (await service.overview({ waiting_tag_ids: ids })).structuredContent;

test("waiting matches any exact associated tag, deduplicates IDs/items, includes groups, and scans beyond available actions", async () => {
  const a = tag("wait"),
    b = tag("other"),
    reads = [];
  const tasks = [
    tagged("first", "Next", [], "p"),
    tagged("group", "Blocked", [a, b], "p", { hasChildren: true }),
    tagged("child", "Available", [b], "p", {
      parent: { id: { primaryKey: "group" } },
    }),
    tagged("both", "Available", [a, b], "p"),
  ];
  const p = project("p", tasks);
  const { service, calls, evaluations } = setup(
    [p],
    [tagged("inbox", "Blocked", [a, b])],
    [a, b],
    {
      Tag: {
        byIdentifier(id) {
          reads.push(id);
          return id === "wait" ? a : b;
        },
      },
    },
  );
  const r = await configured(service, ["wait", "other", "wait"]);
  assert.deepEqual(reads, ["other", "wait"]);
  assert.deepEqual(calls, ["overview"]);
  assert.equal(evaluations.length, 1);
  assert.equal(r.projects[0].work_state, "available_action");
  assert.equal(r.counts.remaining_without_available_action, 0);
  assert.equal(r.projects[0].waiting_count, 3);
  assert.equal(r.waiting.count, 4);
  assert.equal(r.waiting.inbox_count, 1);
  assert.deepEqual(r.waiting.items, [
    { id: "inbox", project_id: null },
    { id: "group", project_id: "p" },
    { id: "child", project_id: "p" },
    { id: "both", project_id: "p" },
  ]);
  assert.deepEqual(r.waiting.coverage, {
    returned: 4,
    complete: true,
    reason: "complete",
  });
});

test("waiting uses local Inbox eligibility and effective project descendant eligibility without ancestor or tag-subtree expansion", async () => {
  const a = tag("wait"),
    b = tag("child_tag");
  a.tags = collection([b]);
  const parent = tagged("group", "Blocked", [a], "p", { hasChildren: true });
  const child = tagged("child", "Available", [], "p", { parent });
  const tasks = [
    parent,
    child,
    tagged("tagchild", "Available", [b], "p"),
    tagged("completed", "Completed", [a], "p", { completed: false }),
    tagged("dropped", "Dropped", [a], "p", { active: true }),
  ];
  for (const t of tasks.slice(3)) unreadable(t, "tags");
  const omitted = project("hold", [tagged("held", "Blocked", [a], "hold")], {
    status: "on_hold",
  });
  unreadable(omitted, "flattenedTasks");
  const inbox = [
    tagged("root", "Blocked", [a], null, {
      tasks: [tagged("nested", "Available", [a])],
    }),
    tagged("done", "Completed", [a], null, { completed: true }),
    tagged("drop", "Dropped", [a], null, { active: false }),
  ];
  const r = await configured(
    setup([project("p", tasks), omitted], inbox, [a, b]).service,
  );
  assert.equal(r.waiting.count, 2);
  assert.equal(r.waiting.inbox_count, 1);
  assert.deepEqual(
    r.waiting.items.map((t) => t.id),
    ["root", "group"],
  );
});

test("omitted waiting performs no tag lookup, tag reads or extra task-status scans and returns no configured zeros", async () => {
  const a = tagged("a", "Available", [], "p"),
    b = tagged("b", "Blocked", [], "p");
  unreadable(a, "tags");
  unreadable(b, "taskStatus");
  const root = tagged("root", "Blocked");
  unreadable(root, "tags");
  const { service } = setup([project("p", [a, b])], [root], [], {
    get Tag() {
      throw Error("Unrequested tags");
    },
  });
  const r = await data(service);
  assert.ok(!("waiting" in r));
  assert.ok(r.projects.every((p) => !("waiting_count" in p)));
  assert.equal(r.projects[0].work_state, "available_action");
});

test("all waiting IDs resolve before aggregation; absent, wrong-entity and mismatched native IDs fail explicitly", async () => {
  for (const extra of [
    {},
    { Task: { Status: statuses, byIdentifier: () => ({}) } },
    { Folder: { byIdentifier: () => ({}) } },
  ]) {
    const { service } = setup([], [], [tag("wait")], {
      ...extra,
      get flattenedProjects() {
        throw Error("Must validate first");
      },
      get inbox() {
        throw Error("Must validate first");
      },
    });
    await assert.rejects(configured(service, ["wait", "missing"]), {
      code: Object.keys(extra).length ? "WRONG_ENTITY" : "TAG_NOT_FOUND",
    });
  }
  await assert.rejects(
    configured(setup([project("p")], [], []).service, ["p"]),
    { code: "WRONG_ENTITY" },
  );
  await assert.rejects(
    configured(
      setup([], [], [], { Tag: { byIdentifier: () => tag("wrong") } }).service,
    ),
    { code: "NATIVE_STRUCTURE" },
  );
  await assert.rejects(
    configured(
      setup([], [], [], {
        Tag: {
          byIdentifier() {
            throw Error("private");
          },
        },
      }).service,
    ),
    { code: "NATIVE_READ_FAILED" },
  );
  for (const input of [
    { waiting_tag_ids: [] },
    { waiting_tag_ids: Array(21).fill("wait") },
    { waiting_tag_ids: [""] },
    { waiting_tag_ids: [1] },
    { waiting_tag_ids: ["wait"], match: "all" },
  ])
    assert.equal(OverviewInput.safeParse(input).success, false);
});

test("waiting failures do not corrupt core counts or proven availability, and unavailable is never a nonmatch", async () => {
  const a = tag("wait"),
    bad = tagged("bad", "Blocked", [], "p"),
    unknown = tagged("unknown", "Available", [a], "p");
  unreadable(bad, "tags");
  unreadable(unknown, "taskStatus");
  const root = tagged("inbox", "Blocked");
  unreadable(root, "tags");
  const r = await configured(
    setup(
      [
        project("p", [
          tagged("first", "Available", [a], "p"),
          bad,
          unknown,
          tagged("last", "Blocked", [a], "p"),
        ]),
      ],
      [root],
      [a],
    ).service,
  );
  assert.equal(r.counts.inbox_unfinished, 1);
  assert.equal(r.projects[0].work_state, "available_action");
  assert.equal(r.counts.remaining_without_available_action, 0);
  assert.equal(r.waiting.count, null);
  assert.equal(r.waiting.inbox_count, null);
  assert.ok(r.waiting.unavailable.count);
  assert.ok(r.waiting.unavailable.inbox_count);
  assert.ok(r.projects[0].unavailable.waiting_count);
  assert.ok(!("waiting_count" in r.projects[0]));
  assert.deepEqual(
    r.waiting.items.map((t) => t.id),
    ["first", "last"],
  );
  assert.equal(r.waiting.coverage.reason, "unavailable");
  assert.equal(r.waiting.coverage.complete, false);
  assert.ok(r.waiting.coverage.drilldown.includes("tag_ids"));
  assert.ok(!JSON.stringify(r).includes("private"));
});

test("waiting keeps earlier core failures explicit even when a later task is available", async () => {
  const a = tag("wait"),
    bad = tagged("bad", "Blocked", [], "p");
  unreadable(bad, "taskStatus");
  const r = await configured(
    setup(
      [project("p", [bad, tagged("later", "Available", [a], "p")])],
      [],
      [a],
    ).service,
  );
  assert.equal(r.counts.remaining_without_available_action, null);
  assert.ok(r.projects[0].unavailable.work_state);
  assert.equal(r.waiting.count, null);
  assert.equal(r.waiting.items.length, 1);
});

test("waiting association failures reject project-root leakage, wrong owners and duplicate native matches", async () => {
  const a = tag("wait");
  for (const tasks of [
    [tagged("p", "Available", [a], "p", { project: {} })],
    [tagged("wrong", "Available", [a], "other")],
    [
      tagged("same", "Available", [a], "p"),
      tagged("same", "Blocked", [a], "p"),
    ],
  ]) {
    const r = await configured(setup([project("p", tasks)], [], [a]).service);
    assert.equal(r.waiting.count, null);
    assert.equal(
      r.projects[0].unavailable.waiting_count.code,
      "NATIVE_STRUCTURE",
    );
    assert.equal(r.waiting.coverage.complete, false);
  }
  const root = tagged("nested", "Available", [a], null, {
    parent: { id: { primaryKey: "root" } },
  });
  const r = await configured(setup([], [root], [a]).service);
  assert.equal(r.waiting.inbox_count, null);
  assert.equal(r.waiting.items.length, 0);
});

test("configured empty matches are complete zeros; oversized match lists keep exact counts and useful core rows", async () => {
  const a = tag("wait");
  const empty = await configured(setup([project("p")], [], [a]).service);
  assert.equal(empty.waiting.count, 0);
  assert.equal(empty.projects[0].waiting_count, 0);
  assert.equal(empty.waiting.coverage.complete, true);
  const tasks = Array.from({ length: 1800 }, (_, i) =>
    tagged("task-" + String(i).padStart(5, "0"), "Available", [a], "p"),
  );
  const r = await configured(setup([project("p", tasks)], [], [a]).service);
  assert.equal(r.waiting.count, 1800);
  assert.equal(r.projects[0].waiting_count, 1800);
  assert.equal(r.waiting.inbox_count, 0);
  assert.equal(r.coverage.complete, true);
  assert.equal(r.waiting.coverage.complete, false);
  assert.equal(r.waiting.coverage.reason, "response_bytes");
  assert.equal(r.waiting.coverage.returned, r.waiting.items.length);
  assert.ok(r.waiting.items.length > 25 && r.waiting.items.length < 1800);
  assert.ok(resultBytes(r) <= RESPONSE_BYTES);
  assert.ok(r.waiting.coverage.drilldown.includes("nofuss_query"));
  assert.deepEqual(
    r.waiting.items.map((t) => t.id),
    tasks.slice(0, r.waiting.items.length).map((t) => t.id.primaryKey),
  );
});

test("waiting counts survive byte-limited project rows and native failures after both list bounds", async () => {
  const a = tag("wait");
  const ps = Array.from({ length: 300 }, (_, i) =>
    project(
      "p" + String(i).padStart(3, "0"),
      [tagged("task" + i, "Available", [a], "p" + String(i).padStart(3, "0"))],
      { name: "n".repeat(512) },
    ),
  );
  const r = await configured(setup(ps, [], [a]).service);
  assert.equal(r.counts.active_projects, 300);
  assert.equal(r.waiting.count, 300);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.waiting.coverage.complete, false);
  assert.equal(r.waiting.items.length, 0);
  assert.ok(resultBytes(r) <= RESPONSE_BYTES);
  unreadable(ps.at(-1), "flattenedTasks");
  const failed = await configured(setup(ps, [], [a]).service);
  assert.equal(failed.waiting.count, null);
  assert.equal(failed.waiting.coverage.reason, "unavailable");
  assert.ok(failed.projects.every((p) => p.waiting_count === 1));
});

test("service validates configured scope, deduplication, unknown owners and waiting count/list consistency", async () => {
  const a = tag("wait"),
    good = await configured(
      setup([project("p", [tagged("t", "Available", [a], "p")])], [], [a])
        .service,
    );
  for (const change of [
    (r) => delete r.waiting,
    (r) => (r.waiting.tag_ids = ["other"]),
    (r) => (r.waiting.count = 0),
    (r) => (r.waiting.count = null),
    (r) => (r.waiting.inbox_count = 2),
    (r) => delete r.projects[0].waiting_count,
    (r) => (r.waiting.items[0].project_id = "unknown"),
    (r) => r.waiting.items.push(r.waiting.items[0]),
    (r) => (r.waiting.coverage.returned = 0),
    (r) => (r.waiting.coverage.reason = "unavailable"),
    (r) => (r.waiting.items[0].id = "p"),
  ]) {
    const r = structuredClone(good);
    change(r);
    const service = new ReadService(
      { run: async () => r, snapshot: () => ({}) },
      {},
    );
    await assert.rejects(configured(service), {
      code: "INVALID_NATIVE_OUTPUT",
    });
  }
  const service = new ReadService(
    { run: async () => good, snapshot: () => ({}) },
    {},
  );
  await assert.rejects(data(service), { code: "INVALID_NATIVE_OUTPUT" });
});
