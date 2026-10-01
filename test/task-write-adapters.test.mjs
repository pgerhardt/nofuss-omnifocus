import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const reads = [
  "nofuss_get",
  "nofuss_query",
  "nofuss_overview",
  "nofuss_status",
];
async function setup(t, scopes) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (scopes)
    await writeFile(
      join(dir, "mutation-authorization.json"),
      JSON.stringify({ schema_version: 1, scopes, project_ids: ["project"] }),
      { mode: 0o600 },
    );
  return dir;
}
function cli(dir, args, input) {
  const r = spawnSync(
    process.execPath,
    ["--import", "./test/task-write-bootstrap.mjs", "dist/cli.js", ...args],
    {
      env: { ...process.env, NOFUSS_STATE_DIR: dir },
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(r.signal, null, r.stderr);
  return { exit: r.status, body: JSON.parse(r.stdout) };
}
test("PROCESS DOUBLE: CLI explicit apply, keys, default preview, default deny and deterministic exits", async (t) => {
  const dir = await setup(t, ["task.create"]),
    denied = await setup(t);
  const args = ["create", "task", "--input", "-"],
    input = { project_id: "project", name: "CLI" };
  assert.equal(cli(dir, args, input).body.mode, "preview");
  assert.equal(cli(dir, [...args, "--apply"], input).exit, 2);
  assert.equal(
    cli(dir, args, { ...input, apply: true, request_key: "hidden" }).exit,
    2,
  );
  assert.equal(
    cli(denied, [...args, "--apply", "--request-key", "no"], input).exit,
    4,
  );
  const applied = cli(dir, [...args, "--apply", "--request-key", "yes"], input);
  assert.equal(applied.exit, 0);
  assert.equal(applied.body.items[0].outcome, "applied");
  assert.deepEqual(
    cli(dir, [...args, "--apply", "--request-key", "yes"], input),
    applied,
  );
  assert.equal(
    cli(dir, [...args, "--apply", "--request-key", "yes"], {
      ...input,
      name: "changed",
    }).exit,
    2,
  );
  assert.equal(cli(dir, [...args, "--apply", "--apply"], input).exit, 2);
});
for (const scopes of [
  undefined,
  ["task.update"],
  ["task.move"],
  ["task.create", "task.update", "task.complete"],
])
  test(
    "PROCESS DOUBLE: MCP catalog host scopes " + JSON.stringify(scopes),
    async (t) => {
      const dir = await setup(t, scopes),
        client = new Client({ name: "NFO-10 test", version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "./test/task-write-bootstrap.mjs",
          "dist/cli.js",
          "mcp",
        ],
        env: { ...process.env, NOFUSS_STATE_DIR: dir },
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const tools = (await client.listTools()).tools;
        assert.deepEqual(
          tools.map((x) => x.name),
          [
            ...reads,
            ...["task.create", "task.update", "task.complete", "task.move"]
              .filter((s) => scopes?.includes(s))
              .map((s) => "nofuss_" + s.slice(5)),
          ],
        );
        for (const tool of tools.slice(4)) {
          assert.equal(tool.annotations.readOnlyHint, false);
          assert.equal(tool.annotations.idempotentHint, false);
          assert.equal(tool.outputSchema, undefined);
        }
        if (scopes?.includes("task.move")) {
          const input = {
            task_id: "task",
            destination: { kind: "inbox" },
            apply: true,
            request_key: "mcp-move",
          };
          const actual = await client.callTool({
            name: "nofuss_move",
            arguments: input,
          });
          assert.equal(actual.structuredContent.items[0].outcome, "applied");
          const moved = cli(dir, ["move", "task", "--input", "-", "--apply"], {
            ...input,
            request_key: "cli-move",
          });
          assert.equal(moved.exit, 0);
          assert.equal(moved.body.items[0].outcome, "applied");
        }
        if (scopes?.includes("task.create")) {
          const input = {
            project_id: "project",
            name: "MCP",
            apply: true,
            request_key: "mcp",
          };
          const result = await client.callTool({
            name: "nofuss_create",
            arguments: input,
          });
          assert.equal(!!result.isError, false);
          const domain =
            result.structuredContent ?? JSON.parse(result.content[0].text);
          assert.equal(domain.items[0].outcome, "applied");
          await rm(join(dir, "mutation-authorization.json"));
          const denied = await client.callTool({
            name: "nofuss_create",
            arguments: { ...input, request_key: "revoked" },
          });
          assert.equal(denied.isError, true);
        }
      } finally {
        await client.close();
      }
    },
  );
test("PROCESS DOUBLE: recurrence/notification update routes through actual CLI and MCP union schemas", async (t) => {
  const dir = await setup(t, ["task.update"]);
  const changes = {
    recurrence: null,
    notifications: [{ kind: "absolute", fire_at: "2099-02-03T01:02:03.456Z" }],
  };
  const actual = cli(
    dir,
    ["update", "task", "--input", "-", "--apply", "--request-key", "cli-alarm"],
    { task_id: "task", changes },
  );
  assert.equal(actual.exit, 0);
  assert.equal(actual.body.items[0].outcome, "applied");
  const client = new Client({ name: "recurrence-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "./test/task-write-bootstrap.mjs",
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
      [...reads, "nofuss_update"],
    );
    const result = await client.callTool({
      name: "nofuss_update",
      arguments: {
        task_id: "task",
        changes,
        apply: true,
        request_key: "mcp-alarm",
      },
    });
    assert.equal(result.structuredContent.items[0].outcome, "applied");
  } finally {
    await client.close();
  }
});
test("PROCESS DOUBLE: actual CLI/MCP grouped batch schema and durable item-key parity", async (t) => {
  const dir = await setup(t, ["task.batch", "task.create"]);
  const input = {
    action: "create",
    items: [
      { item_key: "one", project_id: "project", name: "one" },
      { item_key: "two", project_id: "project", name: "two" },
    ],
  };
  const r = cli(
    dir,
    ["batch", "task", "--input", "-", "--apply", "--request-key", "cli-batch"],
    input,
  );
  assert.equal(r.exit, 0);
  assert.deepEqual(
    r.body.items.map((i) => i.item_key),
    ["one", "two"],
  );
  const client = new Client({ name: "batch-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "./test/task-write-bootstrap.mjs",
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
      [...reads, "nofuss_create", "nofuss_batch"],
    );
    const result = await client.callTool({
      name: "nofuss_batch",
      arguments: { ...input, apply: true, request_key: "mcp-batch" },
    });
    assert.ok(
      result.structuredContent.items.every((i) => i.outcome === "applied"),
    );
    assert.deepEqual(
      result.structuredContent.items.map((i) => i.item_key),
      r.body.items.map((i) => i.item_key),
    );
  } finally {
    await client.close();
  }
});
test("PROCESS DOUBLE: Inbox-only CLI/core/MCP parity and unchanged generic catalog", async (t) => {
  const dir = await setup(t);
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.create", "task.update"],
      project_ids: [],
      allow_inbox: true,
    }),
    { mode: 0o600 },
  );
  const { NoFussCore } = await import("../dist/core.js");
  const { taskFixture } = await import("./task-write-fixture.mjs");
  const input = {
    destination: { kind: "inbox" },
    name: "Inbox adapter",
    note: "scalar",
    flagged: true,
    due_at: "2099-01-02T12:00:00Z",
  };
  const core = new NoFussCore(taskFixture(), {}, dir);
  const expected = await core.mutate("task.create", input);
  assert.deepEqual(
    cli(dir, ["create", "task", "--input", "-"], input).body,
    expected,
  );
  const client = new Client({ name: "NFO-38", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "./test/task-write-bootstrap.mjs", "dist/cli.js", "mcp"],
    env: { ...process.env, NOFUSS_STATE_DIR: dir },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      [...reads, "nofuss_create", "nofuss_update"],
    );
    const p = await client.callTool({
      name: "nofuss_create",
      arguments: input,
    });
    assert.deepEqual(p.structuredContent, expected);
    const r = await client.callTool({
      name: "nofuss_create",
      arguments: {
        ...p.structuredContent.apply_input,
        apply: true,
        request_key: "inbox-mcp",
      },
    });
    assert.equal(r.structuredContent.items[0].outcome, "applied");
    const id = r.structuredContent.items[0].resource.id;
    const u = await client.callTool({
      name: "nofuss_update",
      arguments: {
        task_id: id,
        changes: { name: "updated", planned_at: "2099-01-01T12:00:00Z" },
        apply: true,
        request_key: "inbox-update",
      },
    });
    assert.equal(u.structuredContent.items[0].outcome, "applied");
    const denied = await client.callTool({
      name: "nofuss_create",
      arguments: {
        destination: { kind: "parent", task_id: "task" },
        name: "project child",
        apply: true,
        request_key: "denied-parent",
      },
    });
    assert.equal(denied.structuredContent.items[0].outcome, "rejected");
  } finally {
    await client.close();
  }
});
