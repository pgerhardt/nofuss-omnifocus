import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NoFussCore } from "../dist/core.js";
import { CAPABILITIES } from "../dist/contract.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test("PROCESS DOUBLE: public MCP catalog is still declared read tools; no native operation required", async () => {
  const client = new Client({ name: "NFO-9 catalog regression", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
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
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
  } finally {
    await client.close();
  }
});
test("OFFLINE: CLI exposes task commands while bare mutation dispatch remains unavailable", async () => {
  const help = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(help.status, 0);
  assert.deepEqual(
    JSON.parse(help.stdout).usage.map((s) => s.split(" ")[0]),
    [
      "get",
      "query",
      "get|query|overview|doctor|attachments|sync-status|location|export|plugins|preferences",
      "attach|detach",
      "trigger",
      "set_location",
      "import_outline",
      "overview",
      "doctor",
      "mcp",
      "create|update|complete|move|reorder|drop|duplicate|delete",
      "batch",
      "review",
      "uncomplete|undrop|convert_to_project",
      "set_forecast_tag",
    ],
  );
  const core = new NoFussCore(
    {
      run() {
        throw Error("native path forbidden");
      },
      snapshot() {
        return {};
      },
    },
    {},
  );
  for (const command of [
    "preview",
    "apply",
    "write",
    "create",
    "update",
    "complete",
  ]) {
    const r = spawnSync(process.execPath, [cli, command], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.notEqual(r.status, 0);
    assert.ok(JSON.parse(r.stdout).error);
    await assert.rejects(core.execute(command, {}), {
      code: "UNSUPPORTED_OPERATION",
    });
  }
  assert.equal(CAPABILITIES.writes, false);
});

test("actual SDK catalog renders newly authorized ordinary schemas including recursive predicates and icon channels", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "nfo-ordinary-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: [
        "task.uncomplete",
        "task.undrop",
        "task.convert_to_project",
        "document.set_forecast_tag",
        "tag.set_allows_next_action",
        "project.set_next_review_date",
        "perspective.create",
        "perspective.update",
        "perspective.delete",
        "project.import_outline",
      ],
      project_ids: ["project"],
      tag_ids: ["tag"],
      task_ids: ["task"],
      perspective_ids: ["perspective"],
      allow_preferences: true,
      allow_project_creation: true,
      allow_perspective_creation: true,
      allow_inbox: true,
    }),
    { mode: 0o600 },
  );
  const client = new Client({
    name: "ordinary schema regression",
    version: "1",
  });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp"],
        env: { ...process.env, NOFUSS_STATE_DIR: dir },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    for (const name of [
      "nofuss_uncomplete",
      "nofuss_undrop",
      "nofuss_convert_to_project",
      "nofuss_set_forecast_tag",
      "nofuss_set_allows_next_action",
      "nofuss_set_next_review_date",
      "nofuss_create",
      "nofuss_import_outline",
    ])
      assert.ok(
        tools.some((t) => t.name === name),
        name,
      );
    const schema = JSON.stringify(
      tools.find((t) => t.name === "nofuss_create").inputSchema,
    );
    assert.ok(schema.includes("icon_color"));
    assert.ok(schema.includes("disabled"));
    assert.ok(schema.includes("tag_ids"));
  } finally {
    await client.close();
  }
});
