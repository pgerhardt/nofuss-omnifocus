import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("PROCESS DOUBLE: taxonomy shares MCP update/move verbs and exact CLI entity contracts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nfo-taxonomy-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      project_ids: ["project"],
      scopes: [
        "task.update",
        "tag.update",
        "folder.update",
        "tag.move",
        "folder.move",
      ],
      tag_ids: ["tag-1", "tag-2"],
      folder_ids: ["folder-3"],
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "taxonomy-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "./test/taxonomy-write-bootstrap.mjs",
        "dist/index.js",
      ],
      env: { ...process.env, NOFUSS_STATE_DIR: dir },
      stderr: "pipe",
    });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((n) => n.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("nofuss_update"));
    assert.ok(names.includes("nofuss_move"));
    assert.ok(!names.includes("nofuss_delete"));
    for (const [entity, id] of [
      ["tag", "tag-2"],
      ["folder", "folder-3"],
    ]) {
      const args = {
        entity,
        [entity + "_id"]: id,
        changes: { name: "rename" },
      };
      const result = await client.callTool({
        name: "nofuss_update",
        arguments: args,
      });
      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          "./test/taxonomy-write-bootstrap.mjs",
          "dist/cli.js",
          "update",
          entity,
          "--input",
          "-",
        ],
        {
          input: JSON.stringify(args),
          env: { ...process.env, NOFUSS_STATE_DIR: dir },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(cli.status, 0);
      assert.deepEqual(result.structuredContent, JSON.parse(cli.stdout));
      assert.equal(result.structuredContent.operation, entity + ".update");
    }
  } finally {
    await client.close();
  }
});
