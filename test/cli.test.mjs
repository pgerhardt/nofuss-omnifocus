import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NoFussCore } from "../dist/core.js";
import { ReadService, mcpResult, resultBytes } from "../dist/service.js";
import { ReadError, QueryInput, GetInput } from "../dist/contract.js";
import { runCli, exitCode } from "../dist/cli-command.js";
import { packingCost } from "../dist/packing.js";
import { encodeCursor, queryHash, treeHash } from "../dist/cursor.js";
import { fixture } from "./parity-fixture.mjs";
const build = JSON.parse(
  readFileSync(new URL("../dist/build.json", import.meta.url)),
);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const preload = fileURLToPath(
  new URL("./parity-bootstrap.mjs", import.meta.url),
);
function shell(argv, input, env = {}) {
  const r = spawnSync(process.execPath, ["--import", preload, cli, ...argv], {
    encoding: "utf8",
    input,
    timeout: 10000,
    env: { ...process.env, NFO_TEST_NO_MCP: "1", ...env },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.ok(r.stdout.endsWith("\n"));
  const data = JSON.parse(r.stdout);
  assert.equal(
    r.stdout,
    JSON.stringify(data) + "\n",
    "exactly one compact JSON document",
  );
  assert.ok(Buffer.byteLength(r.stdout) <= 65536);
  return { ...r, data };
}
const requests = [
  ["get", { ids: ["inbox.1"], fields: ["id", "name"] }],
  ["get", { entity: "project", ids: ["project"], fields: ["id", "name"] }],
  [
    "get",
    {
      entity: "project",
      ids: ["project"],
      fields: [],
      tree: { fields: ["name"], limit: 2 },
    },
  ],
  [
    "query",
    { entity: "task", scope: "inbox_roots", fields: ["name"], limit: 1 },
  ],
  [
    "query",
    {
      entity: "task",
      scope: "project",
      project_id: "project",
      fields: ["name"],
    },
  ],
  [
    "query",
    {
      entity: "project",
      scope: "library",
      status: "active",
      flagged: false,
      fields: ["name"],
    },
  ],
  ["overview", {}],
  ["overview", { waiting_tag_ids: ["wait-tag", "wait-tag"] }],
  ["doctor", {}],
  ["get", { ids: ["missing", "inbox.1", "project"], fields: [] }],
  ["get", { entity: "project", ids: ["inbox.1"], fields: [] }],
  [
    "get",
    { ids: ["inbox.1"], fields: ["note"], text: { field: "note", length: 2 } },
  ],
];
test("core, executable CLI and real SDK MCP adapter return equivalent domain facts", async () => {
  const client = new Client({ name: "parity", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, cli, "mcp"],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (b) => (stderr += b));
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
    const core = new NoFussCore(fixture(), build);
    for (const [command, input] of requests) {
      const direct = await core.execute(command, input);
      const actual = shell([command, "--input", "-"], JSON.stringify(input));
      assert.deepEqual(actual.data, direct, command);
      assert.equal(actual.stderr, "");
      const mcp = await client.callTool({
        name: command === "doctor" ? "nofuss_status" : "nofuss_" + command,
        arguments: input,
      });
      assert.deepEqual(mcp.structuredContent, direct, command);
      assert.deepEqual(JSON.parse(mcp.content[0].text), direct);
      assert.ok(Buffer.byteLength(JSON.stringify(mcp)) <= 65536);
      if (direct.results?.some((r) => r.status !== "ok")) {
        assert.equal(mcp.isError, true);
        assert.equal(actual.status, 3);
      } else assert.equal(actual.status, 0);
    }
    const first = await core.query(requests[3][1]);
    const input = { ...requests[3][1], cursor: first.next_cursor };
    const next = await core.query(input);
    assert.equal(next.items[0].id, "inbox.2");
    assert.equal(next.has_more, false);
    assert.deepEqual(
      shell(["query", "--input", "-"], JSON.stringify(input)).data,
      next,
    );
    assert.deepEqual(
      (await client.callTool({ name: "nofuss_query", arguments: input }))
        .structuredContent,
      next,
    );
    const window = await core.get(requests[11][1]);
    const continuation = {
      ...requests[11][1],
      text: {
        field: "note",
        cursor: window.results[0].task.truncated.note.next_cursor,
      },
    };
    const continued = await core.get(continuation);
    assert.equal(continued.results[0].task.note, "cd");
    assert.deepEqual(
      shell(["get", "--input", "-"], JSON.stringify(continuation)).data,
      continued,
    );
    assert.deepEqual(
      (await client.callTool({ name: "nofuss_get", arguments: continuation }))
        .structuredContent,
      continued,
    );
    for (const input of [
      {
        entity: "project",
        ids: ["project"],
        fields: [],
        tree: { fields: [], limit: 1 },
      },
      {
        ids: ["inbox.1"],
        fields: ["tag_ids"],
        collection: { field: "tag_ids", limit: 1 },
      },
    ]) {
      const first = await core.get(input);
      const cursor = input.tree
        ? first.results[0].tree.next_cursor
        : first.results[0].task.truncated.tag_ids.next_cursor;
      assert.ok(cursor);
      const continuedInput = input.tree
        ? { ...input, tree: { ...input.tree, cursor } }
        : { ...input, collection: { ...input.collection, cursor } };
      const expected = await core.get(continuedInput);
      assert.deepEqual(
        shell(["get", "--input", "-"], JSON.stringify(continuedInput)).data,
        expected,
      );
      assert.deepEqual(
        (
          await client.callTool({
            name: "nofuss_get",
            arguments: continuedInput,
          })
        ).structuredContent,
        expected,
      );
      if (input.tree) {
        assert.equal(expected.results[0].tree.items[0].id, "child2");
        assert.equal(expected.results[0].tree.has_more, false);
      } else assert.deepEqual(expected.results[0].task.tag_ids, ["other-tag"]);
    }
  } finally {
    await client.close();
  }
  assert.equal(stderr, "");
});
test("obvious flags, file/stdin input, strict rejection and separated diagnostics", () => {
  const dir = mkdtempSync(tmpdir() + "/nofuss-cli-");
  try {
    const path = dir + "/query.json";
    writeFileSync(path, JSON.stringify(requests[3][1]));
    assert.deepEqual(
      shell(["query", "tasks", "--input", path]).data,
      shell([
        "query",
        "tasks",
        "--scope",
        "inbox",
        "--fields",
        "name",
        "--limit",
        "1",
      ]).data,
    );
    assert.equal(
      shell(["get", "task", "inbox.1", "--fields", "id,name"]).status,
      0,
    );
    assert.equal(
      shell(["doctor"], undefined, { NFO_TEST_DIAGNOSTIC: "1" }).stderr,
      "controlled diagnostic\n",
    );
    for (const argv of [
      [],
      ["bogus"],
      ["mcp", "extra"],
      ["doctor", "--fields", "name"],
      ["get", "task"],
      ["query", "tasks", "--limit", "1x"],
      ["query", "tasks", "--limit", "1", "--limit", "2"],
      ["query", "tasks", "--flagged", "yes"],
      ["query", "tasks", "--input", path, "--fields", "name"],
      ["get", "project", "--input", path],
    ]) {
      const r = shell(argv);
      assert.equal(r.status, 2, JSON.stringify(argv));
      assert.equal(r.data.error.code, "INVALID_INPUT");
    }
    for (const input of [
      "{",
      "[]",
      "null",
      '{"unknown":true}',
      " ".repeat(65537),
      Buffer.from([0xff]),
    ])
      assert.equal(shell(["doctor", "--input", "-"], input).status, 2);
    assert.equal(shell(["doctor", "--input", dir + "/absent"]).status, 2);
    const r = shell(["complete", "inbox.1"]);
    assert.equal(r.status, 2);
    assert.equal(r.data.error.code, "UNSUPPORTED_OPERATION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("stable semantic errors and exit statuses preserve codes across core/CLI/MCP", async () => {
  for (const [code, status] of [
    ["UNSUPPORTED_OPERATION", 2],
    ["NOT_FOUND", 3],
    ["WRONG_ENTITY", 3],
    ["INVALID_CURSOR", 2],
    ["CURSOR_QUERY_MISMATCH", 2],
    ["AUTOMATION_DENIED", 4],
    ["TIMEOUT", 5],
    ["NOT_RUNNING", 5],
    ["NATIVE_READ_FAILED", 6],
    ["OUTPUT_LIMIT", 7],
    ["INVALID_NATIVE_OUTPUT", 8],
  ]) {
    const reader = {
      ...fixture(),
      run: async () => {
        throw new ReadError(code, "Controlled failure.");
      },
    };
    const core = new NoFussCore(reader, build);
    await assert.rejects(core.query(requests[3][1]), (e) => e.code === code);
    const cliResult = shell(
      ["query", "--input", "-"],
      JSON.stringify(requests[3][1]),
      { NFO_TEST_ERROR: code },
    );
    assert.equal(cliResult.data.error.code, code);
    assert.equal(cliResult.status, status);
    assert.equal(exitCode(code), status);
    const mcp = await new ReadService(reader, build).get({ ids: ["inbox.1"] });
    const get = await core.get({ ids: ["inbox.1"] });
    assert.deepEqual(mcp.structuredContent, get);
    assert.equal(get.results[0].error.code, code);
    assert.equal(mcp.isError, true);
  }
  const doctor = shell(["doctor"], undefined, {
    NFO_TEST_ERROR: "AUTOMATION_DENIED",
  });
  assert.equal(doctor.status, 4);
  assert.equal(doctor.data.native.connected, false);
  const core = new NoFussCore(fixture(), build);
  for (const cursor of [
    "!",
    encodeCursor(queryHash(QueryInput.parse({ ...requests[3][1], limit: 2 })), {
      id: "inbox.1",
      created_at: null,
    }),
  ]) {
    const input = { ...requests[3][1], cursor };
    const r = await runCli(["query", "--input", "-"], core, async () => input);
    assert.equal(r.exitCode, 2);
  }
  await assert.rejects(
    core.execute("complete", {}),
    (e) => e.code === "UNSUPPORTED_OPERATION",
  );
  await assert.rejects(
    core.get({ ids: [], extra: true }),
    (e) => e.code === "INVALID_INPUT",
  );
  const unexpected = new NoFussCore(
    {
      ...fixture(),
      run: async () => {
        throw Error("private internal detail");
      },
    },
    build,
  );
  await assert.rejects(
    unexpected.query(requests[3][1]),
    (e) => e.code === "READ_FAILED" && !e.message.includes("private internal"),
  );
  const malformed = new NoFussCore(
    { ...fixture(), run: async () => ({}) },
    build,
  );
  await assert.rejects(
    malformed.query(requests[3][1]),
    (e) => e.code === "INVALID_NATIVE_OUTPUT",
  );
});
test("field continuation is live, does not bind content revision, and cannot promise snapshot reconstruction", async () => {
  const reader = fixture(),
    core = new NoFussCore(reader, build),
    adapter = new ReadService(reader, build);
  const first = await core.get(requests[11][1]);
  const cursor = first.results[0].task.truncated.note.next_cursor;
  reader.inbox[0].noteText.string = "XYnew😀";
  const input = { ...requests[11][1], text: { field: "note", cursor } };
  const next = await core.get(input);
  assert.equal(next.results[0].task.note, "ne");
  assert.equal(first.results[0].task.note + next.results[0].task.note, "abne");
  assert.deepEqual(
    JSON.parse(
      (await runCli(["get", "--input", "-"], core, async () => input)).json,
    ),
    next,
  );
  assert.deepEqual((await adapter.get(input)).structuredContent, next);
  const contract = readFileSync(
    new URL("../docs/cli.md", import.meta.url),
    "utf8",
  );
  assert.match(contract, /do not bind content revision/);
  assert.match(contract, /not snapshot-consistent/);
});
test("frozen domain packing retains prior thresholds and adapters independently bound encodings", async () => {
  for (const text of ["", "Ω😀", '"\\\n\u0000'.repeat(1000), "a".repeat(33000)])
    for (const failed of [false, true]) {
      const data = { text };
      assert.equal(packingCost(data, failed), resultBytes(data, failed));
      if (resultBytes(data, failed) > 65536)
        assert.throws(
          () => mcpResult(data, failed),
          (e) => e.code === "RESPONSE_LIMIT",
        );
    }
  const maliciousBuild = { ...build, version: "x".repeat(70000) };
  const result = await runCli(
    ["doctor"],
    new NoFussCore(fixture(), maliciousBuild),
  );
  assert.equal(result.exitCode, 7);
  assert.equal(JSON.parse(result.json).error.code, "RESPONSE_LIMIT");
  for (const file of [
    "core.ts",
    "packing.ts",
    "errors.ts",
    "contract.ts",
    "cursor.ts",
    "worker.ts",
  ]) {
    const source = readFileSync(
      new URL("../src/" + file, import.meta.url),
      "utf8",
    );
    assert.ok(!source.includes("@modelcontextprotocol"));
    if (file === "core.ts")
      assert.ok(!/structuredContent|mcpResult/.test(source));
  }
});

// NFO-12 additions: real SDK error presentation and cross-adapter field states.
// These are fixture parity, never live OmniFocus proof.
async function sdkFixture(env = {}) {
  const client = new Client({ name: "conformance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, cli, "mcp"],
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (b) => (stderr += b));
  await client.connect(transport);
  await client.listTools(); // Exercise advertised SDK output validation too.
  return {
    call: (command, input) =>
      client.callTool({ name: "nofuss_" + command, arguments: input }),
    close: async () => {
      await client.close();
      assert.equal(stderr, "");
    },
  };
}
function payload(mcp) {
  const text = JSON.parse(mcp.content[0].text);
  if (mcp.structuredContent) assert.deepEqual(mcp.structuredContent, text);
  return text;
}
test("field states survive direct core, CLI subprocess and real MCP SDK fixture parity", async () => {
  const reader = fixture("field-states");
  assert.equal(Array.isArray(reader.inbox[0].tags), false);
  const core = new NoFussCore(reader, build);
  const sdk = await sdkFixture({ NFO_TEST_FIXTURE: "field-states" });
  try {
    const input = {
      ids: ["inbox.1"],
      fields: [
        "name",
        "note",
        "tag_ids",
        "due_at",
        "flagged",
        "estimated_minutes",
        "planned_at",
      ],
    };
    const expected = await core.get(input),
      row = expected.results[0].task;
    assert.equal(row.note, "");
    assert.deepEqual(row.tag_ids, []);
    assert.equal(row.due_at, null);
    assert.equal(row.flagged, false);
    assert.equal(row.estimated_minutes, 0);
    assert.equal(row.name, "😀".repeat(512));
    assert.ok(row.truncated.name.next_cursor);
    assert.ok(row.unavailable.planned_at);
    assert.ok(!Object.hasOwn(row, "planned_at"));
    assert.ok(!Object.hasOwn(row, "notifications"));
    const cli = shell(["get", "--input", "-"], JSON.stringify(input), {
      NFO_TEST_FIXTURE: "field-states",
    });
    assert.equal(cli.status, 0);
    assert.deepEqual(cli.data, expected);
    assert.deepEqual(payload(await sdk.call("get", input)), expected);
    const empty = {
      entity: "project",
      scope: "library",
      flagged: true,
      fields: [],
    };
    const zero = await core.query(empty);
    assert.deepEqual(zero.items, []);
    assert.equal(zero.has_more, false);
    assert.deepEqual(
      shell(["query", "--input", "-"], JSON.stringify(empty)).data,
      zero,
    );
    assert.deepEqual(payload(await sdk.call("query", empty)), zero);
  } finally {
    await sdk.close();
  }
});
test("natural fixture errors and invalid/stale/mismatched cursors agree through actual CLI and SDK", async () => {
  const core = new NoFussCore(fixture(), build),
    sdk = await sdkFixture();
  const query = { entity: "task", scope: "inbox_roots", fields: [], limit: 1 };
  const tree = {
    entity: "project",
    ids: ["project"],
    fields: [],
    tree: { fields: [], limit: 1 },
  };
  const field = await core.get({
    ids: ["inbox.1"],
    fields: ["note"],
    text: { field: "note", length: 2 },
  });
  const cases = [
    ["get", { ids: ["missing"], fields: [] }, "NOT_FOUND", 3],
    [
      "get",
      { entity: "project", ids: ["inbox.1"], fields: [] },
      "WRONG_ENTITY",
      3,
    ],
    [
      "query",
      { ...query, scope: "project", project_id: "missing" },
      "PROJECT_NOT_FOUND",
      3,
    ],
    ["overview", { waiting_tag_ids: ["missing"] }, "TAG_NOT_FOUND", 3],
    ["overview", { waiting_tag_ids: ["inbox.1"] }, "WRONG_ENTITY", 3],
    ["query", { ...query, cursor: "!" }, "INVALID_CURSOR", 2],
    [
      "query",
      {
        ...query,
        cursor: encodeCursor(
          queryHash(QueryInput.parse({ ...query, limit: 2 })),
          { created_at: null, id: "inbox.1" },
        ),
      },
      "CURSOR_QUERY_MISMATCH",
      2,
    ],
    [
      "get",
      {
        ...tree,
        tree: {
          ...tree.tree,
          cursor: encodeCursor(treeHash(GetInput.parse(tree)), {
            id: "removed-anchor",
          }),
        },
      },
      "CURSOR_STALE",
      2,
    ],
    [
      "get",
      { ...tree, tree: { ...tree.tree, cursor: "!" } },
      "INVALID_CURSOR",
      2,
    ],
    [
      "get",
      {
        ids: ["inbox.2"],
        fields: ["note"],
        text: {
          field: "note",
          cursor: field.results[0].task.truncated.note.next_cursor,
        },
      },
      "CURSOR_QUERY_MISMATCH",
      2,
    ],
  ];
  try {
    for (const [command, input, code, status] of cases) {
      let expected;
      try {
        expected = await core.execute(command, input);
      } catch (e) {
        expected = { error: { code: e.code, message: e.message } };
      }
      assert.equal((expected.error ?? expected.results[0].error).code, code);
      const actual = shell([command, "--input", "-"], JSON.stringify(input));
      assert.equal(actual.status, status);
      assert.deepEqual(actual.data, expected);
      const mcp = await sdk.call(command, input);
      assert.equal(mcp.isError, true);
      assert.deepEqual(payload(mcp), expected);
    }
    const invalid = { entity: "task", scope: "inbox_roots", limit: 0 };
    await assert.rejects(core.query(invalid), { code: "INVALID_INPUT" });
    assert.equal(
      shell(["query", "--input", "-"], JSON.stringify(invalid)).data.error.code,
      "INVALID_INPUT",
    );
    const rejected = await sdk.call("query", invalid);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Input validation error/);
    // MCP SDK rejects the schema before the core: equivalent invalid-input
    // semantics, but SDK protocol presentation does not carry a domain JSON code.
  } finally {
    await sdk.close();
  }
});
test("controlled failure codes reach real SDK errors and retain CLI exit mapping", async () => {
  for (const [code, status] of [
    ["AUTOMATION_DENIED", 4],
    ["TIMEOUT", 5],
    ["CANCELLED", 5],
    ["NATIVE_PROCESS_FAILED", 6],
    ["OUTPUT_LIMIT", 7],
    ["RESPONSE_LIMIT", 7],
    ["INVALID_NATIVE_OUTPUT", 8],
    ["RESPONSE_MISMATCH", 8],
  ]) {
    const core = new NoFussCore(
      {
        ...fixture(),
        run: async () => {
          throw new ReadError(code, "Controlled failure.");
        },
      },
      build,
    );
    const sdk = await sdkFixture({ NFO_TEST_ERROR: code });
    try {
      for (const input of [
        { entity: "project", scope: "library", fields: [] },
        { entity: "task", scope: "inbox_roots", fields: [] },
      ]) {
        await assert.rejects(core.query(input), { code });
        const actual = shell(["query", "--input", "-"], JSON.stringify(input), {
          NFO_TEST_ERROR: code,
        });
        assert.equal(actual.status, status);
        assert.equal(actual.data.error.code, code);
        const mcp = await sdk.call("query", input);
        assert.equal(mcp.isError, true);
        assert.deepEqual(payload(mcp), actual.data);
      }
    } finally {
      await sdk.close();
    }
  }
});

test("raw second-valued notifications normalize to minute domain facts across core, CLI and MCP fixtures", async () => {
  const core = new NoFussCore(fixture("notifications"), build);
  const sdk = await sdkFixture({ NFO_TEST_FIXTURE: "notifications" });
  async function parity(input) {
    const result = await core.get(input);
    const cliResult = shell(["get", "--input", "-"], JSON.stringify(input), {
      NFO_TEST_FIXTURE: "notifications",
    });
    assert.equal(cliResult.status, 0);
    assert.deepEqual(cliResult.data, result);
    assert.deepEqual(payload(await sdk.call("get", input)), result);
    return result;
  }
  try {
    const full = await parity({
      ids: ["inbox.1", "inbox.2"],
      fields: ["notifications"],
    });
    const [a, b] = full.results.map((r) => r.task.notifications);
    assert.deepEqual(
      a.map((n) => n.id),
      ["relative.0", "absolute"],
    );
    assert.deepEqual(
      [a[0].relative_offset_minutes, b[0].relative_offset_minutes],
      [-30, 15],
    );
    assert.deepEqual([a[0].task_id, b[0].task_id], ["inbox.1", "inbox.2"]);
    assert.deepEqual(a[1], {
      id: "absolute",
      task_id: "inbox.1",
      kind: "absolute",
      initial_fire_at: "2099-01-14T18:00:00.000Z",
      next_fire_at: null,
      absolute_fire_at: "2099-01-14T18:00:00.000Z",
      relative_offset_minutes: null,
      repeat_interval_seconds: 3600,
      is_snoozed: false,
      floating_time_zone: true,
    });
    assert.equal(a[0].absolute_fire_at, null);
    assert.equal(a[0].repeat_interval_seconds, 0);
    const first = (
      await parity({
        ids: ["inbox.1"],
        fields: ["notifications"],
        collection: { field: "notifications", limit: 1 },
      })
    ).results[0].task;
    const cursor = first.truncated.notifications.next_cursor;
    assert.ok(cursor);
    const last = (
      await parity({
        ids: ["inbox.1"],
        fields: ["notifications"],
        collection: { field: "notifications", cursor },
      })
    ).results[0].task;
    assert.equal(last.truncated.notifications.next_cursor, null);
    assert.deepEqual([...first.notifications, ...last.notifications], a);
  } finally {
    await sdk.close();
  }
});

test("notification getter failures and version changes preserve adapter semantics", async () => {
  for (const mode of [
    "notifications-unavailable",
    "notifications-unverified",
  ]) {
    const core = new NoFussCore(fixture(mode), build);
    const sdk = await sdkFixture({ NFO_TEST_FIXTURE: mode });
    try {
      const input = { ids: ["inbox.1"], fields: ["notifications"] };
      const result = await core.get(input),
        row = result.results[0].task;
      if (mode === "notifications-unverified") {
        assert.equal(row.notifications[0].relative_offset_minutes, -30);
        assert.ok(!row.unavailable);
      } else {
        assert.ok(!Object.hasOwn(row, "notifications"));
        assert.ok(row.unavailable.notifications);
      }
      const cliResult = shell(["get", "--input", "-"], JSON.stringify(input), {
        NFO_TEST_FIXTURE: mode,
      });
      assert.equal(cliResult.status, 0);
      assert.deepEqual(cliResult.data, result);
      assert.deepEqual(payload(await sdk.call("get", input)), result);
    } finally {
      await sdk.close();
    }
  }
});
