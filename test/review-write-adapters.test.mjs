import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("PROCESS DOUBLE: one review MCP tool with distinct actions matches executable CLI preview", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nfo-review-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["project.set_review_interval", "project.mark_reviewed"],
      project_ids: ["new-1"],
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "review-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "./test/review-write-bootstrap.mjs", "dist/index.js"],
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
        "nofuss_review",
      ],
    );
    for (const action of ["set_interval", "mark_reviewed"]) {
      const input = {
        entity: "project",
        project_id: "new-1",
        action,
        ...(action === "set_interval"
          ? { review_interval: { unit: "months", steps: 2, fixed: false } }
          : {}),
      };
      const result = await client.callTool({
        name: "nofuss_review",
        arguments: input,
      });
      const cli = spawnSync(
        process.execPath,
        [
          "--import",
          "./test/review-write-bootstrap.mjs",
          "dist/cli.js",
          "review",
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
      assert.deepEqual(result.structuredContent, JSON.parse(cli.stdout));
      assert.equal(result.structuredContent.mode, "preview");
    }
  } finally {
    await client.close();
  }
});
