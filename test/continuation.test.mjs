import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ReadService } from "../dist/service.js";
import { GetInput, GetOutput, ReadError } from "../dist/contract.js";
import { encodeCursor, fieldHash } from "../dist/cursor.js";
const source = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
const Kind = { Absolute: "absolute", DueRelative: "relative" };
const ref = (id) => ({ id: { primaryKey: id } });
function setup() {
  const task = {
    ...ref("task"),
    project: null,
    active: true,
    completed: false,
    added: null,
    name: "😀\u0001".repeat(4000),
    noteText: { string: "Ω\u0002𐐀".repeat(6000) },
    tags: Array.from({ length: 1500 }, (_, i) =>
      ref("tag" + i + "x".repeat(100)),
    ),
  };
  const nativeAlarms = Array.from({ length: 240 }, (_, i) => ({
    ...ref("alarm" + i),
    task,
    kind: i % 2 ? Kind.Absolute : Kind.DueRelative,
    initialFireDate: null,
    nextFireDate: null,
    absoluteFireDate: new Date("2026-02-01T00:00:00.123Z"),
    relativeFireOffset: -600,
    repeatInterval: 0,
    isSnoozed: false,
    usesFloatingTimeZone: true,
  }));
  let reads = 0;
  task.notifications = nativeAlarms.map(
    (n) =>
      new Proxy(n, {
        get(t, k) {
          if (k === "kind") reads++;
          return t[k];
        },
      }),
  );
  const project = {
    ...ref("project"),
    tags: task.tags,
    name: task.name,
    noteText: task.noteText,
  };
  const op = vm.runInNewContext("(" + source + ")", {
    app: {
      userVersion: { versionString: "4.9.2" },
      buildVersion: { versionString: "188.3" },
    },
    Task: {
      Notification: { Kind },
      byIdentifier: (id) => (id === "task" ? task : null),
    },
    Project: { byIdentifier: (id) => (id === "project" ? project : null) },
    inbox: [task],
  });
  let calls = 0;
  const service = new ReadService(
    {
      run: async (operation, args) => {
        calls++;
        const frame = JSON.parse(
          op({ request_id: "test", op: operation, args }),
        );
        if (frame.error)
          throw new ReadError(frame.error.code, frame.error.message);
        return frame.result;
      },
      snapshot: () => ({}),
    },
    {},
  );
  return {
    service,
    task,
    project,
    nativeAlarms,
    reads: () => reads,
    calls: () => calls,
  };
}
function row(result, entity = "task") {
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  GetOutput.parse(result.structuredContent);
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent.results[0][entity];
}
async function finish(service, first, field, entity = "task") {
  const text = field === "name" || field === "note";
  let value = first[field],
    cursor = first.truncated?.[field]?.next_cursor,
    previous = 0,
    pages = 1;
  while (cursor) {
    const current = row(
      await service.get({
        entity,
        ids: [first.id],
        fields: [field],
        [text ? "text" : "collection"]: { field, cursor },
      }),
      entity,
    );
    assert.ok(current.truncated[field].offset > previous);
    previous = current.truncated[field].offset;
    value = text ? value + current[field] : value.concat(current[field]);
    cursor = current.truncated[field].next_cursor;
    assert.equal(!!cursor, current.truncated[field].next_offset !== null);
    assert.ok(++pages < 1000);
  }
  return { value, pages };
}
test("oversized selected fields remain present and reconstruct Unicode, tags and ordered notifications within the whole MCP bound", async () => {
  const { service, task, nativeAlarms } = setup();
  const first = row(
    await service.get({
      ids: ["task"],
      fields: ["name", "note", "tag_ids", "notifications"],
    }),
  );
  assert.ok(!first.unavailable);
  for (const field of ["name", "note", "tag_ids", "notifications"]) {
    assert.ok(first[field].length > 0);
    assert.ok(first.truncated[field].next_cursor);
    const { value, pages } = await finish(service, first, field);
    assert.ok(pages > 1);
    if (field === "name") assert.equal(value, task.name);
    if (field === "note") assert.equal(value, task.noteText.string);
    if (field === "tag_ids")
      assert.deepEqual(
        value,
        task.tags.map((t) => t.id.primaryKey),
      );
    if (field === "notifications")
      assert.deepEqual(
        value,
        nativeAlarms.map((n) => ({
          id: n.id.primaryKey,
          task_id: "task",
          kind: n.kind === Kind.Absolute ? "absolute" : "due_relative",
          initial_fire_at: null,
          next_fire_at: null,
          absolute_fire_at:
            n.kind === Kind.Absolute ? n.absoluteFireDate.toISOString() : null,
          relative_offset_minutes: n.kind === Kind.Absolute ? null : -10,
          repeat_interval_seconds: 0,
          is_snoozed: false,
          floating_time_zone: true,
        })),
      );
  }
});
test("query field continuations transfer to exact gets; oversized collections cannot trap record pagination", async () => {
  const { service, task } = setup();
  const result = await service.query({
    entity: "task",
    scope: "inbox_roots",
    fields: ["note", "tag_ids", "notifications"],
    limit: 1,
  });
  assert.ok(!result.structuredContent.has_more);
  assert.equal(result.structuredContent.items.length, 1);
  const tags = await finish(
    service,
    result.structuredContent.items[0],
    "tag_ids",
  );
  assert.deepEqual(
    tags.value,
    task.tags.map((t) => t.id.primaryKey),
  );
});
test("project tags reuse native-order windows; small collections, absent fields and failures remain distinct", async () => {
  const env = setup(),
    { service, project, task } = env;
  const first = row(
    await service.get({
      entity: "project",
      ids: ["project"],
      fields: ["tag_ids"],
      collection: { field: "tag_ids", limit: 17 },
    }),
    "project",
  );
  assert.equal(first.tag_ids.length, 17);
  assert.deepEqual(
    (await finish(service, first, "tag_ids", "project")).value,
    project.tags.map((t) => t.id.primaryKey),
  );
  const before = env.reads();
  row(
    await service.get({
      ids: ["task"],
      fields: ["notifications"],
      collection: { field: "notifications", limit: 2 },
    }),
  );
  assert.equal(env.reads() - before, 2, "no off-window notification getters");
  assert.deepEqual(row(await service.get({ ids: ["task"], fields: [] })), {
    id: "task",
  });
  task.tags = [];
  task.notifications = [];
  task.name = "";
  const empty = row(
    await service.get({
      ids: ["task"],
      fields: ["tag_ids", "notifications", "name"],
    }),
  );
  assert.deepEqual(empty, {
    id: "task",
    name: "",
    tag_ids: [],
    notifications: [],
  });
  task.tags = { 0: ref("host-tag"), length: 1, map: Array.prototype.map };
  assert.equal(Array.isArray(task.tags), false);
  assert.deepEqual(
    row(await service.get({ ids: ["task"], fields: ["tag_ids"] })).tag_ids,
    ["host-tag"],
  );
  task.tags = false;
  const invalid = row(
    await service.get({ ids: ["task"], fields: ["tag_ids"] }),
  );
  assert.ok(!("tag_ids" in invalid));
  assert.equal(invalid.unavailable.tag_ids.code, "NATIVE_TYPE");
  Object.defineProperty(task, "tags", {
    get() {
      throw Error("unreadable");
    },
  });
  const unavailable = row(
    await service.get({ ids: ["task"], fields: ["tag_ids"] }),
  );
  assert.ok(!("tag_ids" in unavailable));
  assert.equal(unavailable.unavailable.tag_ids.code, "NATIVE_READ_FAILED");
  assert.ok(!unavailable.truncated);
});
test("field cursors reject damage, owner/entity/field/size changes and other cursor kinds before native access", async () => {
  const env = setup(),
    { service } = env;
  const first = row(await service.get({ ids: ["task"], fields: ["tag_ids"] })),
    cursor = first.truncated.tag_ids.next_cursor;
  const good = {
    ids: ["task"],
    fields: ["tag_ids"],
    collection: { field: "tag_ids", cursor },
  };
  const before = env.calls();
  for (const [args, code] of [
    [{ ...good, ids: ["wrong"] }, "CURSOR_QUERY_MISMATCH"],
    [{ ...good, entity: "project", ids: ["project"] }, "CURSOR_QUERY_MISMATCH"],
    [
      {
        ...good,
        fields: ["notifications"],
        collection: { field: "notifications", cursor },
      },
      "CURSOR_QUERY_MISMATCH",
    ],
    [
      { ...good, collection: { field: "tag_ids", limit: 2, cursor } },
      "CURSOR_QUERY_MISMATCH",
    ],
    [
      {
        ...good,
        fields: ["note"],
        collection: undefined,
        text: { field: "note", cursor },
      },
      "CURSOR_QUERY_MISMATCH",
    ],
    [
      { ...good, collection: { field: "tag_ids", cursor: "!" } },
      "INVALID_CURSOR",
    ],
    [
      {
        ...good,
        collection: { field: "tag_ids", cursor: cursor.slice(0, -4) },
      },
      "INVALID_CURSOR",
    ],
    [
      {
        ...good,
        collection: {
          field: "tag_ids",
          cursor: encodeCursor(fieldHash("task", "task", "tag_ids"), {
            id: "task",
            created_at: null,
          }),
        },
      },
      "INVALID_CURSOR",
    ],
  ]) {
    const r = await service.get(args);
    assert.ok(r.isError);
    assert.equal(r.structuredContent.results[0].error.code, code);
  }
  assert.equal(env.calls(), before);
  for (const args of [
    { ids: ["task", "other"], collection: { field: "tag_ids" } },
    {
      entity: "project",
      ids: ["project"],
      collection: { field: "notifications" },
    },
    { ids: ["task"], collection: { field: "note" } },
    { ids: ["task"], text: { field: "note", offset: 0, cursor } },
    { ids: ["task"], collection: { field: "tag_ids", limit: 201 } },
  ])
    assert.equal(GetInput.safeParse(args).success, false);
});
test("text cursor uses the returned size and rejects owner/field/size changes; live shorter data is explicit", async () => {
  const { service, task } = setup();
  const first = row(
    await service.get({
      ids: ["task"],
      fields: ["note"],
      text: { field: "note", length: 71 },
    }),
  );
  assert.equal(
    (await finish(service, first, "note")).value,
    task.noteText.string,
  );
  const cursor = first.truncated.note.next_cursor;
  for (const more of [
    { ids: ["other"] },
    { text: { field: "name", cursor } },
    { text: { field: "note", cursor, length: 72 } },
  ]) {
    const r = await service.get({
      ids: ["task"],
      fields: ["note", "name"],
      text: { field: "note", cursor },
      ...more,
    });
    assert.equal(
      r.structuredContent.results[0].error.code,
      "CURSOR_QUERY_MISMATCH",
    );
  }
  task.noteText.string = "";
  const changed = row(
    await service.get({
      ids: ["task"],
      fields: ["note"],
      text: { field: "note", cursor },
    }),
  );
  assert.equal(changed.unavailable.note.code, "TEXT_OFFSET");
  assert.ok(!("note" in changed));
});

test("service rejects nonadvancing or inconsistent native field metadata", async () => {
  for (const patch of [
    { returned: 0, next_offset: 0 },
    { returned: 1, next_offset: 0 },
    { returned: 1, total: 0 },
    { returned: 1, next_offset: 1, next_cursor: "native-token" },
  ]) {
    const service = new ReadService(
      {
        run: async () => ({
          read_at: new Date().toISOString(),
          results: [
            {
              id: "t",
              status: "ok",
              task: {
                id: "t",
                tag_ids: patch.returned === 0 ? [] : ["tag"],
                truncated: {
                  tag_ids: {
                    offset: 0,
                    returned: 1,
                    total: 3,
                    next_offset: 1,
                    reason: "collection_window",
                    ...patch,
                  },
                },
              },
            },
          ],
        }),
        snapshot: () => ({}),
      },
      {},
    );
    const r = await service.get({ ids: ["t"], fields: ["tag_ids"] });
    assert.equal(
      r.structuredContent.results[0].error.code,
      "INVALID_NATIVE_OUTPUT",
    );
  }
});

test("record cursors advance across oversized fields without missing or duplicate owners", async () => {
  const tags = Array.from({ length: 500 }, (_, i) => ref("tag" + i));
  const tasks = ["a", "b", "c"].map((id) => ({
    ...ref(id),
    active: true,
    completed: false,
    added: null,
    tags,
  }));
  const op = vm.runInNewContext("(" + source + ")", { inbox: tasks });
  const service = new ReadService(
    {
      run: async (opName, args) =>
        JSON.parse(op({ request_id: "test", op: opName, args })).result,
      snapshot: () => ({}),
    },
    {},
  );
  let cursor,
    owners = [];
  do {
    const r = await service.query({
      entity: "task",
      scope: "inbox_roots",
      fields: ["tag_ids"],
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 65536);
    const page = r.structuredContent;
    assert.equal(page.returned, 1);
    assert.ok(page.items[0].truncated.tag_ids.next_cursor);
    owners.push(page.items[0].id);
    cursor = page.next_cursor;
    assert.ok(owners.length <= 3);
  } while (cursor);
  assert.deepEqual(owners, ["a", "b", "c"]);
});
