import test from "node:test";
import assert from "node:assert/strict";
import { NoFussCore } from "../dist/core.js";
import { perspectiveFixture } from "./perspective-fixture.mjs";
import { GetInput, QueryInput } from "../dist/contract.js";
const setup = () => {
  const fixture = perspectiveFixture();
  return { fixture, core: new NoFussCore(fixture, {}) };
};
test("NATIVE-ALGORITHM DOUBLE: built-in enum/custom persistent inventory, exact get, archive/aggregation and cursor binding", async () => {
  const { core } = setup();
  const query = {
    entity: "perspective",
    scope: "library",
    limit: 2,
    view: "detail",
  };
  const first = await core.query(query);
  assert.deepEqual(
    first.items.map((i) => i.id),
    ["builtin_inbox", "builtin_projects"],
  );
  assert.equal(first.items[0].identity_kind, "builtin_enum");
  assert.ok(first.items[0].unavailable.rule_archive);
  const second = await core.query({ ...query, cursor: first.next_cursor });
  assert.equal(second.items[0].id, "custom-id");
  assert.equal(second.items[0].identity_kind, "persistent");
  assert.deepEqual(second.items[0].rule_archive, {
    format: "native_unversioned",
    application_version: "4.9.2",
    rules: [{ action: "due" }],
  });
  assert.equal(second.items[0].rule_aggregation, null);
  await assert.rejects(
    core.query({ ...query, fields: ["name"], cursor: first.next_cursor }),
    (e) => e.code === "CURSOR_QUERY_MISMATCH",
  );
  const r = await core.get({
    entity: "perspective",
    ids: ["custom-id", "absent", "custom-id"],
    fields: ["name", "rule_aggregation"],
  });
  assert.deepEqual(
    r.results.map((i) => i.status),
    ["ok", "not_found", "ok"],
  );
  assert.equal(r.results[0].perspective.name, "Custom Ω");
});
test("NATIVE-ALGORITHM DOUBLE: evaluation observes selected visible tree only, without switching/expanding windows", async () => {
  const { fixture, core } = setup();
  const get = () =>
    core.get({
      entity: "perspective",
      ids: ["custom-id"],
      fields: ["evaluation"],
    });
  let r = (await get()).results[0].perspective.evaluation;
  assert.equal(r.status, "available");
  assert.deepEqual(r.task_ids, ["task.one"]);
  assert.deepEqual(r.project_ids, ["project.one"]);
  assert.equal(fixture.document.windows[0].perspective, fixture.custom);
  fixture.document.windows.push({ ...fixture.document.windows[0] });
  assert.equal(
    (await get()).results[0].perspective.evaluation.status,
    "ambiguous_windows",
  );
  fixture.document.windows = [
    {
      perspective: fixture.Perspective.BuiltIn.Projects,
      content: { rootNode: fixture.root },
    },
  ];
  assert.equal(
    (await get()).results[0].perspective.evaluation.status,
    "not_selected",
  );
  fixture.document.windows = [];
  assert.equal(
    (await get()).results[0].perspective.evaluation.status,
    "no_window",
  );
});
test("NATIVE-ALGORITHM DOUBLE: evaluation cap and unversioned oversized archive are explicit, no scalar truncation", async () => {
  const { fixture, core } = setup();
  fixture.root.children = Array.from({ length: 101 }, (_, i) =>
    fixture.node(new fixture.Task("task." + i)),
  );
  fixture.custom.archivedFilterRules = [{ large: "x".repeat(15000) }];
  const p = (
    await core.get({
      entity: "perspective",
      ids: ["custom-id"],
      fields: ["evaluation", "rule_archive"],
    })
  ).results[0].perspective;
  assert.equal(p.evaluation.task_ids.length, 100);
  assert.equal(p.evaluation.has_more, true);
  assert.ok(p.unavailable.rule_archive);
  assert.equal(p.rule_archive, undefined);
});
test("OFFLINE: perspective rejects task predicates/tree/collections and undeclared write forms", () => {
  assert.equal(
    QueryInput.safeParse({
      entity: "perspective",
      scope: "library",
      status: "active",
    }).success,
    false,
  );
  assert.equal(
    QueryInput.safeParse({
      entity: "perspective",
      scope: "library",
      flagged: false,
    }).success,
    false,
  );
  assert.equal(
    GetInput.safeParse({ entity: "perspective", ids: ["custom-id"], tree: {} })
      .success,
    false,
  );
  assert.equal(
    GetInput.safeParse({
      entity: "perspective",
      ids: ["custom-id"],
      collection: { field: "project_ids" },
    }).success,
    false,
  );
});
test("NATIVE-ALGORITHM DOUBLE: perspective names use owner-bound Unicode continuation", async () => {
  const { fixture, core } = setup();
  fixture.custom.name = "Ω".repeat(1000);
  const r = await core.get({
    entity: "perspective",
    ids: ["custom-id"],
    fields: ["name"],
    text: { field: "name", length: 100 },
  });
  const p = r.results[0].perspective;
  assert.equal(p.name.length, 100);
  const next = await core.get({
    entity: "perspective",
    ids: ["custom-id"],
    fields: ["name"],
    text: { field: "name", cursor: p.truncated.name.next_cursor },
  });
  assert.equal(next.results[0].perspective.truncated.name.offset, 100);
});
test("PROCESS DOUBLE: actual CLI/MCP perspective schemas preserve declared reads and archive representation", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { spawnSync } = await import("node:child_process"),
    { Client } = await import("@modelcontextprotocol/sdk/client/index.js"),
    { StdioClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = await mkdtemp(join(tmpdir(), "nfo-perspective-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/perspective-bootstrap.mjs",
      "dist/cli.js",
      "query",
      "perspectives",
      "--scope",
      "library",
      "--fields",
      "id,name,kind",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NOFUSS_STATE_DIR: dir },
      timeout: 10000,
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).returned, 3);
  const client = new Client({ name: "perspective-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "./test/perspective-bootstrap.mjs",
        "dist/cli.js",
        "mcp",
      ],
      env: { ...process.env, NOFUSS_STATE_DIR: dir },
      stderr: "pipe",
    });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      [
        "nofuss_get",
        "nofuss_query",
        "nofuss_overview",
        "nofuss_status",
        "nofuss_attachments",
        "nofuss_sync_status",
        "nofuss_location",
        "nofuss_export",
        "nofuss_plugins",
        "nofuss_preferences",
      ],
    );
    const r = await client.callTool({
      name: "nofuss_get",
      arguments: {
        entity: "perspective",
        ids: ["custom-id"],
        fields: ["rule_archive", "rule_aggregation"],
      },
    });
    assert.equal(
      r.structuredContent.results[0].perspective.rule_archive.format,
      "native_unversioned",
    );
  } finally {
    await client.close();
  }
});
