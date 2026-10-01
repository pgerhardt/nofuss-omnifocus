import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NoFussCore } from "../dist/core.js";
import {
  QueryInput,
  GetInput,
  QueryOutput,
  GetOutput,
  RESPONSE_BYTES,
} from "../dist/contract.js";
import { resultBytes } from "../dist/service.js";
import { parseCommand } from "../dist/cli-command.js";
import { discoveryFixture, stamp } from "./discovery-fixture.mjs";
const q = (more) => ({ entity: "task", scope: "library", fields: [], ...more });
const setup = () => {
  const fixture = discoveryFixture();
  return { fixture, core: new NoFussCore(fixture, {}) };
};
const ids = (result) => result.items.map((r) => r.id);

test("library excludes project roots, includes groups and does not prune inherited states", async () => {
  const { core, fixture } = setup();
  fixture.tasks[0].tasks = [fixture.tasks[1]];
  fixture.tasks[1].parent = fixture.tasks[0];
  fixture.tasks[1].effectiveActive = false;
  assert.deepEqual(ids(await core.query(q())), [
    "task.0",
    "task.1",
    "task.2",
    "task.3",
    "task.4",
  ]);
  assert.equal(
    (await core.query(q({ include_completed: true, include_dropped: true })))
      .returned,
    7,
  );
  assert.deepEqual(ids(await core.query(q({ status: "completed" }))), [
    "task.5",
  ]);
  assert.deepEqual(ids(await core.query(q({ status: "dropped" }))), ["task.6"]);
  assert.deepEqual(ids(await core.query(q({ available: true }))), [
    "task.0",
    "task.1",
    "task.2",
    "task.3",
  ]);
  assert.deepEqual(ids(await core.query(q({ available: false }))), ["task.4"]);
  assert.deepEqual(ids(await core.query(q({ flagged: true }))), ["task.0"]);
  assert.equal((await core.query(q({ flagged: false }))).returned, 4);
  for (const status of [
    "available",
    "next",
    "due_soon",
    "overdue",
    "blocked",
    "completed",
    "dropped",
  ])
    assert.equal((await core.query(q({ status }))).returned, 1, status);
});
test("native date windows are half-open; estimates include zero and exclude null", async () => {
  const { core } = setup();
  for (const field of [
    "due_at",
    "defer_at",
    "planned_at",
    "effective_due_at",
    "effective_defer_at",
  ]) {
    assert.deepEqual(
      ids(
        await core.query(
          q({ [field]: { from: stamp, before: "2026-10-02T00:00:00Z" } }),
        ),
      ),
      ["task.1"],
      field,
    );
    assert.deepEqual(
      ids(await core.query(q({ [field]: { before: stamp } }))),
      [],
      field,
    );
  }
  assert.deepEqual(
    ids(await core.query(q({ estimated_minutes: { min: 0, max: 0 } }))),
    ["task.0"],
  );
  assert.deepEqual(
    ids(await core.query(q({ estimated_minutes: { min: 30, max: 60 } }))),
    ["task.1", "task.2"],
  );
  assert.deepEqual(
    ids(
      await core.query(
        q({
          flagged: false,
          due_at: { from: stamp },
          estimated_minutes: { max: 30 },
        }),
      ),
    ),
    ["task.1"],
  );
});
test("exact tags match any assigned ID, never ancestors; missing IDs and predicate failures are explicit", async () => {
  const { core, fixture } = setup();
  assert.deepEqual(ids(await core.query(q({ tag_ids: ["tag.root"] }))), []);
  assert.deepEqual(
    ids(await core.query(q({ tag_ids: ["tag.leaf", "tag.root", "tag.leaf"] }))),
    ["task.0"],
  );
  await assert.rejects(core.query(q({ tag_ids: ["missing"], flagged: true })), {
    code: "TAG_NOT_FOUND",
  });
  Object.defineProperty(fixture.tasks[0], "flagged", {
    get() {
      throw Error("unreadable");
    },
  });
  assert.equal(
    (await core.query(q())).returned,
    5,
    "unselected, unused getter is untouched",
  );
  await assert.rejects(core.query(q({ flagged: true })), {
    code: "NATIVE_READ_FAILED",
  });
  fixture.context.app.getTypeScriptDeclarations = () =>
    "declare class Task {\n}\n";
  await assert.rejects(
    core.query(q({ planned_at: { from: stamp }, status: "completed" })),
    { code: "UNSUPPORTED_FILTER" },
  );
});
test("every predicate and scope is cursor-bound; tag ordering and duplicates are normalized", async () => {
  const { core } = setup();
  const base = q({ limit: 1 });
  const first = await core.query(base);
  for (const extra of [
    { status: "next" },
    { available: true },
    { flagged: false },
    { tag_ids: ["tag.root"] },
    { include_completed: true },
    { include_dropped: true },
    { due_at: { from: stamp } },
    { defer_at: { from: stamp } },
    { planned_at: { from: stamp } },
    { effective_due_at: { from: stamp } },
    { effective_defer_at: { from: stamp } },
    { estimated_minutes: { min: 0 } },
    { scope: "inbox_roots" },
    { fields: ["name"] },
  ])
    await assert.rejects(
      core.query({ ...base, ...extra, cursor: first.next_cursor }),
      { code: "CURSOR_QUERY_MISMATCH" },
    );
  const tags = q({ tag_ids: ["tag.root", "tag.leaf", "tag.root"], limit: 1 });
  // Supply a second exact-tag match so this query has a continuation.
  const a = setup();
  a.fixture.tasks[1].tags = [a.fixture.tags[2]];
  const page = await a.core.query(tags);
  assert.equal(
    (
      await a.core.query({
        ...tags,
        tag_ids: ["tag.leaf", "tag.root"],
        cursor: page.next_cursor,
      })
    ).returned,
    1,
  );
});
test("taxonomy identity, hierarchy and native status survive inventories and ordered duplicate gets", async () => {
  const { core } = setup();
  for (const entity of ["tag", "folder"]) {
    const all = await core.query({ entity, scope: "library", view: "detail" });
    assert.equal(all.returned, 3);
    const map = new Map(all.items.map((r) => [r.id, r]));
    assert.equal(map.get(entity + ".root").parent_id, null);
    assert.equal(map.get(entity + ".leaf").parent_id, entity + ".child");
    assert.deepEqual(map.get(entity + ".child").child_ids, [entity + ".leaf"]);
    const result = await core.get({
      entity,
      ids: [entity + ".leaf", "missing", entity + ".leaf"],
      view: "detail",
    });
    assert.deepEqual(
      result.results.map((r) => r.status),
      ["ok", "not_found", "ok"],
    );
    assert.deepEqual(result.results[0][entity], map.get(entity + ".leaf"));
    assert.deepEqual(result.results[0], result.results[2]);
  }
  const folder = (
    await core.get({ entity: "folder", ids: ["folder.leaf"], view: "detail" })
  ).results[0].folder;
  assert.deepEqual(folder.project_ids, ["project"]);
  assert.equal(folder.active, true);
  assert.equal(folder.effective_active, false);
  assert.deepEqual(
    ids(
      await core.query({
        entity: "tag",
        scope: "library",
        status: "on_hold",
        fields: [],
      }),
    ),
    ["tag.child"],
  );
});
test("taxonomy text and child collections continue with exact owner binding and byte bounds", async () => {
  const { core, fixture } = setup();
  const root = fixture.tags[0];
  root.name = "😀".repeat(2100);
  root.tags = Array.from({ length: 205 }, (_, i) => ({
    id: { primaryKey: "child." + i },
  }));
  const first = await core.get({
    entity: "tag",
    ids: ["tag.root"],
    view: "detail",
  });
  assert.ok(resultBytes(first) <= RESPONSE_BYTES);
  const row = first.results[0].tag;
  assert.equal(row.child_ids.length, 100);
  const children = [...row.child_ids];
  let cursor = row.truncated.child_ids.next_cursor;
  while (cursor) {
    const r = (
      await core.get({
        entity: "tag",
        ids: ["tag.root"],
        fields: ["child_ids"],
        collection: { field: "child_ids", cursor },
      })
    ).results[0].tag;
    children.push(...r.child_ids);
    cursor = r.truncated?.child_ids.next_cursor;
  }
  assert.equal(new Set(children).size, 205);
  const mismatch = await core.get({
    entity: "folder",
    ids: ["folder.root"],
    fields: ["child_ids"],
    collection: {
      field: "child_ids",
      cursor: row.truncated.child_ids.next_cursor,
    },
  });
  assert.equal(mismatch.results[0].error.code, "CURSOR_QUERY_MISMATCH");
  const next = await core.get({
    entity: "tag",
    ids: ["tag.root"],
    fields: ["name"],
    text: { field: "name", cursor: row.truncated.name.next_cursor },
  });
  assert.equal(Array.from(next.results[0].tag.name).length, 512);
  Object.defineProperty(root, "parent", {
    get() {
      throw Error("missing");
    },
  });
  const missing = (
    await core.get({ entity: "tag", ids: ["tag.root"], fields: ["parent_id"] })
  ).results[0].tag;
  assert.ok(missing.unavailable.parent_id);
  assert.equal(missing.parent_id, undefined);
});
test("strict input rejects cross-entity fields, ambiguous state gates, invalid bounds and overlong tag lists", () => {
  for (const extra of [
    { status: "active" },
    { status: "completed", include_completed: true },
    { include_dropped: null },
    { due_at: {} },
    { due_at: { from: stamp, before: stamp } },
    { due_at: { from: "2026-10-01" } },
    { estimated_minutes: {} },
    { estimated_minutes: { min: 2, max: 1 } },
    { estimated_minutes: { min: -1 } },
    { tag_ids: [] },
    { tag_ids: Array(21).fill("a") },
    { project_id: "p" },
    { depth: "direct" },
  ])
    assert.equal(
      QueryInput.safeParse(q(extra)).success,
      false,
      JSON.stringify(extra),
    );
  for (const entity of ["tag", "folder", "project"])
    for (const extra of [
      { scope: "project", project_id: "p" },
      { available: true },
      { tag_ids: ["a"] },
      { due_at: { from: stamp } },
      { include_dropped: true },
    ])
      assert.equal(
        QueryInput.safeParse({ entity, scope: "library", ...extra }).success,
        false,
      );
  assert.equal(
    GetInput.safeParse({
      entity: "tag",
      ids: ["a"],
      collection: { field: "tag_ids" },
    }).success,
    false,
  );
  assert.equal(
    GetInput.safeParse({ entity: "folder", ids: ["a"], fields: ["note"] })
      .success,
    false,
  );
});
test("new records are strict under both Zod and advertised MCP JSON schema", async () => {
  const { core } = setup();
  for (const [schema, value] of [
    [
      QueryOutput,
      await core.query({ entity: "folder", scope: "library", view: "detail" }),
    ],
    [
      GetOutput,
      await core.get({ entity: "tag", ids: ["tag.child"], view: "detail" }),
    ],
  ]) {
    const validate = new AjvJsonSchemaValidator().getValidator(
      z.toJSONSchema(schema, { target: "draft-7", io: "output" }),
    );
    assert.equal(validate(value).valid, true);
    assert.equal(schema.safeParse(value).success, true);
    const row = value.items?.[0] ?? value.results[0].tag;
    row.child_ids = [27];
    assert.equal(validate(value).valid, false);
    assert.equal(schema.safeParse(value).success, false);
  }
});
test("CLI flags express bounded predicates and taxonomy defaults", async () => {
  const parsed = await parseCommand([
    "query",
    "tasks",
    "--scope",
    "library",
    "--available",
    "false",
    "--tag-ids",
    "tag.root,tag.leaf",
    "--due-from",
    stamp,
    "--due-before",
    "2026-10-02T00:00:00Z",
    "--estimate-min",
    "0",
    "--estimate-max",
    "30",
  ]);
  assert.deepEqual(parsed.input.estimated_minutes, { min: 0, max: 30 });
  assert.deepEqual(parsed.input.due_at, {
    from: stamp,
    before: "2026-10-02T00:00:00Z",
  });
  assert.equal(QueryInput.safeParse(parsed.input).success, true);
  assert.equal((await parseCommand(["query", "tags"])).input.scope, "library");
});
test("core, executable CLI and SDK MCP have discovery/filter/taxonomy parity", async () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const preload = fileURLToPath(
    new URL("./discovery-bootstrap.mjs", import.meta.url),
  );
  const client = new Client({ name: "discovery-parity", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, cli, "mcp"],
    stderr: "pipe",
  });
  const { core } = setup();
  try {
    await client.connect(transport);
    const cases = [
      ["query", q({ limit: 2 })],
      ["query", q({ status: "dropped" })],
      [
        "query",
        q({
          flagged: true,
          available: true,
          tag_ids: ["tag.leaf"],
          estimated_minutes: { min: 0, max: 0 },
        }),
      ],
      [
        "query",
        q({
          planned_at: { from: stamp },
          defer_at: { from: stamp },
          due_at: { from: stamp },
        }),
      ],
      ...["tag", "folder"].flatMap((entity) => [
        ["query", { entity, scope: "library", view: "detail", limit: 1 }],
        [
          "get",
          {
            entity,
            ids: [entity + ".leaf", "missing", entity + ".leaf"],
            view: "detail",
          },
        ],
      ]),
    ];
    const first = await core.query(q({ limit: 2 }));
    cases.push(["query", q({ limit: 2, cursor: first.next_cursor })]);
    const taxonomy = await core.query({
      entity: "folder",
      scope: "library",
      fields: [],
      limit: 1,
    });
    cases.push([
      "query",
      {
        entity: "folder",
        scope: "library",
        fields: [],
        limit: 1,
        cursor: taxonomy.next_cursor,
      },
    ]);
    const children = await core.get({
      entity: "tag",
      ids: ["tag.root"],
      fields: ["name"],
      text: { field: "name", length: 2 },
    });
    cases.push([
      "get",
      {
        entity: "tag",
        ids: ["tag.root"],
        fields: ["name"],
        text: {
          field: "name",
          cursor: children.results[0].tag.truncated.name.next_cursor,
        },
      },
    ]);
    for (const [command, input] of cases) {
      const expected = await core.execute(command, input);
      const actual = spawnSync(
        process.execPath,
        ["--import", preload, cli, command, "--input", "-"],
        { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 },
      );
      assert.equal(actual.error, undefined);
      assert.equal(actual.stderr, "");
      assert.deepEqual(JSON.parse(actual.stdout), expected);
      const mcp = await client.callTool({
        name: "nofuss_" + command,
        arguments: input,
      });
      assert.deepEqual(mcp.structuredContent, expected);
      assert.ok(Buffer.byteLength(JSON.stringify(mcp)) <= RESPONSE_BYTES);
    }
  } finally {
    await client.close();
    await transport.close();
  }
});

test("completed library pages retain native ordering and finish across nonmatching suffixes", async () => {
  const { core, fixture } = setup();
  for (const index of [0, 3]) {
    fixture.tasks[index].completed = true;
    fixture.tasks[index].taskStatus = "Completed";
  }
  const rows = [];
  let cursor;
  let pages = 0;
  do {
    const page = await core.query(
      q({ status: "completed", limit: 1, ...(cursor ? { cursor } : {}) }),
    );
    rows.push(...ids(page));
    cursor = page.next_cursor;
    assert.ok(++pages < 10);
  } while (cursor);
  assert.deepEqual(rows, ["task.0", "task.3", "task.5"]);
});
