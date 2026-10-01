import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("PROCESS DOUBLE: shared project/task MCP verb, entity schema, CLI preview and explicit constructor authorization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nfo-project-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["task.update", "project.update", "project.create"],
      project_ids: ["new-1"],
      folder_ids: ["folder"],
      allow_project_creation: true,
    }),
    { mode: 0o600 },
  );
  const input = {
    entity: "project",
    project_id: "new-1",
    changes: { name: "new" },
  };
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/project-write-bootstrap.mjs",
      "dist/cli.js",
      "update",
      "project",
      "--input",
      "-",
    ],
    {
      input: JSON.stringify(input),
      env: { ...process.env, NOFUSS_STATE_DIR: dir },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const expected = JSON.parse(cli.stdout);
  assert.equal(expected.operation, "project.update");
  assert.equal(expected.mode, "preview");
  const client = new Client({ name: "project-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "./test/project-write-bootstrap.mjs", "dist/index.js"],
    env: { ...process.env, NOFUSS_STATE_DIR: dir },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.filter((n) => n === "nofuss_update").length, 1);
    assert.ok(names.includes("nofuss_create"));
    const result = await client.callTool({
      name: "nofuss_update",
      arguments: input,
    });
    assert.deepEqual(result.structuredContent, expected);
    const create = await client.callTool({
      name: "nofuss_create",
      arguments: {
        entity: "project",
        name: "constructor",
        folder_id: "folder",
      },
    });
    assert.equal(create.structuredContent.mode, "preview");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  } finally {
    await client.close();
  }
});
