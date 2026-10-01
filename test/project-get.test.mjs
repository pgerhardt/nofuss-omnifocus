import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { ReadService } from "../dist/service.js";
import {
  GetInput,
  GetOutput,
  FIELDS,
  PROJECT_FIELDS,
  RESPONSE_BYTES,
  ReadError,
} from "../dist/contract.js";

const operation = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const launcher = readFileSync(
  new URL("../src/native/launcher.js", import.meta.url),
  "utf8",
);
const Status = Object.fromEntries(
  ["Active", "OnHold", "Done", "Dropped"].map((s) => [s, {}]),
);
const date = new Date("2026-01-02T03:04:05.678Z");
function project(id = "p", overrides = {}) {
  const p = {
    id: { primaryKey: id },
    name: "Project Ω 😀",
    status: Status.Active,
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
    nextReviewDate: date,
    ...overrides,
  };
  p.task = { id: p.id, added: date, modified: null, project: p };
  for (const property of ["tasks", "flattenedTasks"])
    Object.defineProperty(p, property, {
      get() {
        throw Error("Metadata must not traverse children");
      },
    });
  return p;
}
function setup(projects = [project()], supplements = {}, tasks = []) {
  const reads = [];
  const byId = new Map(projects.map((p) => [p.id.primaryKey, p]));
  const taskById = new Map(
    [...tasks, ...projects.map((p) => p.task)].map((t) => [t.id.primaryKey, t]),
  );
  const nativeContext = {
    Project: { Status, byIdentifier: (id) => byId.get(id) ?? null },
    Task: { byIdentifier: (id) => taskById.get(id) ?? null },
    get flattenedProjects() {
      throw Error("No global project enumeration");
    },
    get flattenedTasks() {
      throw Error("No global task enumeration");
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
        return vm.runInNewContext(script, nativeContext);
      },
      defaultDocument: {
        flattenedProjects: {
          byId(id) {
            reads.push([id, "lookup"]);
            if (!byId.has(id)) throw Error("Unknown native project");
            const values = {
              id,
              numberOfTasks: 3,
              numberOfCompletedTasks: 1,
              reviewInterval: { unit: "month", steps: 2, fixed: false },
              ...supplements[id],
            };
            return Object.fromEntries(
              Object.entries(values).map(([field, v]) => [
                field,
                () => {
                  reads.push([id, field]);
                  if (v instanceof Error) throw v;
                  return v;
                },
              ]),
            );
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
  return { service: new ReadService(worker, {}), reads, worker };
}
const get = (more = {}) => ({ entity: "project", ids: ["p"], ...more });
const row = (result) => result.structuredContent.results[0].project;

test("project metadata preserves all types/states, exact ordering, duplicates and per-ID outcomes", async () => {
  const projects = [
    project(),
    project("hold", { status: Status.OnHold, sequential: true }),
    project("done", {
      status: Status.Done,
      containsSingletonActions: true,
      sequential: true,
    }),
    project("drop", { status: Status.Dropped }),
  ];
  const task = { id: { primaryKey: "task" }, name: "Ordinary", project: null };
  const { service, reads } = setup(projects, {}, [task]);
  const result = await service.get(
    get({ ids: ["drop", "missing", "hold", "task", "done", "p", "drop"] }),
  );
  assert.equal(result.isError, true);
  const rs = result.structuredContent.results;
  assert.deepEqual(
    rs.map((r) => r.status),
    ["ok", "not_found", "ok", "error", "ok", "ok", "ok"],
  );
  assert.equal(rs[1].error.code, "NOT_FOUND");
  assert.equal(rs[3].error.code, "WRONG_ENTITY");
  assert.deepEqual(
    rs.filter((r) => r.project).map((r) => [r.project.status, r.project.type]),
    [
      ["dropped", "parallel"],
      ["on_hold", "sequential"],
      ["done", "single_actions"],
      ["active", "parallel"],
      ["dropped", "parallel"],
    ],
  );
  assert.deepEqual(rs[0], rs[6]);
  assert.deepEqual(reads, []);
  const legacy = await service.get({ ids: ["task"], fields: ["name"] });
  assert.deepEqual(
    legacy.structuredContent.results,
    (await service.get({ entity: "task", ids: ["task"], fields: ["name"] }))
      .structuredContent.results,
  );
  assert.deepEqual(legacy.structuredContent.results[0].task, {
    id: "task",
    name: "Ordinary",
  });
  assert.equal(
    (await service.get({ ids: ["p"] })).structuredContent.results[0].error.code,
    "PROJECT_ROOT_EXCLUDED",
  );
});
test("project metadata reuses projections, native precision, calendar review units and direct counters", async () => {
  const p = project("p", {
    parentFolder: { id: { primaryKey: "folder" } },
    tags: [{ id: { primaryKey: "tag" } }],
    dropDate: date,
  });
  const { service, reads } = setup([p]);
  const brief = row(await service.get(get()));
  const detail = row(
    await service.get(get({ view: "detail", ids: ["p", "p"] })),
  );
  for (const [key, value] of Object.entries(brief))
    assert.deepEqual(detail[key], value);
  assert.equal(detail.created_at, "2026-01-02T03:04:05.678Z");
  assert.equal(detail.dropped_at, detail.created_at);
  assert.equal(detail.completed_at, null);
  assert.equal(detail.floating_time_zone, false);
  assert.deepEqual(detail.tag_ids, ["tag"]);
  assert.deepEqual(detail.review_interval, {
    unit: "months",
    steps: 2,
    fixed: false,
  });
  assert.equal(detail.direct_task_count, 3);
  assert.equal(detail.direct_completed_task_count, 1);
  assert.equal(detail.note, "");
  assert.ok(!detail.unavailable);
  assert.equal(reads.filter(([, field]) => field === "lookup").length, 1);
  assert.equal(
    reads.filter(([, field]) => field === "reviewInterval").length,
    1,
  );
});
test("project metadata reads only selected details and supplements; request-local deduplication is not a cache", async () => {
  const p = project();
  let notes = 0;
  Object.defineProperty(p, "noteText", {
    get() {
      notes++;
      throw Error("Should be unselected");
    },
  });
  const supplements = { p: { numberOfTasks: 0 } };
  const { service, reads } = setup([p], supplements);
  assert.deepEqual(row(await service.get(get({ fields: [] }))), { id: "p" });
  await service.get(get());
  assert.deepEqual(reads, []);
  assert.equal(notes, 0);
  assert.equal(
    row(await service.get(get({ fields: ["direct_task_count"] })))
      .direct_task_count,
    0,
  );
  assert.deepEqual(
    reads.map(([, f]) => f),
    ["lookup", "id", "numberOfTasks"],
  );
  supplements.p.numberOfTasks = 7;
  assert.equal(
    row(await service.get(get({ fields: ["direct_task_count"] })))
      .direct_task_count,
    7,
  );
  const failed = row(await service.get(get({ fields: ["note"] })));
  assert.equal(failed.unavailable.note.code, "NATIVE_READ_FAILED");
  assert.ok(!("note" in failed));
});
test("project metadata supplement failures, mismatched IDs and unknown review data never become false values", async () => {
  for (const [supplement, code] of [
    [{ reviewInterval: new Error("unavailable") }, "NATIVE_READ_FAILED"],
    [{ reviewInterval: { unit: "week", steps: 1 } }, "NATIVE_UNAVAILABLE"],
    [
      { reviewInterval: { unit: "fortnight", steps: 1, fixed: true } },
      "NATIVE_REVIEW_UNIT",
    ],
    [
      { reviewInterval: { unit: "week", steps: 0, fixed: true } },
      "NATIVE_TYPE",
    ],
    [{ id: "wrong" }, "SUPPLEMENT_MISMATCH"],
  ]) {
    const { service } = setup([project()], { p: supplement });
    const t = row(
      await service.get(get({ fields: ["review_interval", "name"] })),
    );
    assert.equal(t.unavailable.review_interval.code, code);
    assert.ok(!("review_interval" in t));
    assert.equal(t.name, "Project Ω 😀");
  }
  const { service } = setup([project()], {
    p: {
      numberOfTasks: -1,
      numberOfCompletedTasks: new Error("counter failed"),
    },
  });
  const t = row(await service.get(get({ view: "detail" })));
  assert.equal(t.unavailable.direct_task_count.code, "NATIVE_TYPE");
  assert.equal(
    t.unavailable.direct_completed_task_count.code,
    "NATIVE_READ_FAILED",
  );
});
test("project metadata enforces entity field sets, old batch/selection bounds and strict per-ID records", async () => {
  for (const args of [
    get({ ids: [] }),
    get({ ids: Array(21).fill("p") }),
    get({ fields: ["available"] }),
    { ids: ["p"], fields: ["review_interval"] },
    get({ fields: ["descendant_task_count"] }),
    get({ fields: ["direct_available_task_count"] }),
    get({ tree: true }),
    { ids: ["p"], fields: Array(FIELDS.length + 1).fill("id") },
    get({ fields: Array(PROJECT_FIELDS.length + 1).fill("id") }),
  ])
    assert.equal(GetInput.safeParse(args).success, false);
  const { service } = setup();
  await assert.rejects(
    service.get(get({ fields: [], text: { field: "note", offset: 0 } })),
    /named field/,
  );
  for (const result of [
    { id: "p", status: "ok", task: { id: "p" }, project: { id: "p" } },
    { id: "p", status: "ok", project: { id: "different" } },
    { id: "p", status: "error" },
    { id: "p", status: "ok", project: { id: "p", type: "bogus" } },
    {
      id: "p",
      status: "ok",
      project: { id: "p", review_interval: { unit: "months", steps: 1 } },
    },
  ])
    assert.equal(
      GetOutput.safeParse({ results: [result], read_at: null }).success,
      false,
    );
});
test("project metadata text continuation and bounded batches preserve every requested outcome", async () => {
  const note = "😀\u0000".repeat(1800);
  const projects = Array.from({ length: 20 }, (_, i) =>
    project("p" + i, { noteText: { string: note } }),
  );
  const { service } = setup(projects);
  const result = await service.get(
    get({ ids: projects.map((p) => p.id.primaryKey), view: "detail" }),
  );
  assert.equal(result.structuredContent.results.length, 20);
  assert.ok(result.isError);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= RESPONSE_BYTES);
  assert.ok(
    result.structuredContent.results.some(
      (r) => r.error?.code === "RESPONSE_LIMIT",
    ),
  );
  let offset = 0,
    reconstructed = "";
  do {
    const t = row(
      await service.get(
        get({
          ids: ["p0"],
          fields: ["note"],
          text: { field: "note", offset, length: 1000 },
        }),
      ),
    );
    reconstructed += t.note;
    offset = t.truncated?.note.next_offset ?? null;
  } while (offset !== null);
  assert.equal(reconstructed, note);
});
test("project metadata shared output definitions validate both entities without weakening field types", async () => {
  const schema = z.toJSONSchema(GetOutput, { target: "draft-7", io: "output" });
  assert.deepEqual(Object.keys(schema.definitions).sort(), [
    "FieldTruncation",
    "FieldUnavailable",
    "FolderRecord",
    "NullableTimestamp",
    "PerspectiveArchiveJson",
    "PerspectiveRecord",
    "ProjectRecord",
    "TagRecord",
    "TaskRecord",
  ]);
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  const { service } = setup();
  const valid = (await service.get(get({ view: "detail" }))).structuredContent;
  assert.equal(validate(valid).valid, true);
  for (const [key, value] of [
    ["due_at", "bad-date"],
    ["unavailable", { note: { code: 0, reason: "bad" } }],
    [
      "truncated",
      {
        note: {
          offset: 0,
          returned: "wrong",
          total: 10,
          next_offset: null,
          reason: "text_window",
        },
      },
    ],
  ]) {
    const invalid = structuredClone(valid);
    invalid.results[0].project[key] = value;
    assert.equal(validate(invalid).valid, false, key);
  }
});
