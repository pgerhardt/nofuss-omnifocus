import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NoFussCore } from "../dist/core.js";
import { reader } from "./native-closure-bootstrap.mjs";
const preload = fileURLToPath(
    new URL("./native-closure-bootstrap.mjs", import.meta.url),
  ),
  cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function stable(r) {
  r = structuredClone(r);
  delete r.read_at;
  delete r.observed_at;
  return r;
}
test("real SDK MCP/executable CLI/core share all new read contracts and gated mutation previews", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "nfo-new-adapters-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(
    join(state, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: [
        "sync.trigger",
        "tag.set_location",
        "project.import_outline",
        "task.attach",
        "task.detach",
      ],
      project_ids: ["project"],
      task_ids: ["task"],
      tag_ids: ["tag"],
      allow_sync: true,
      allow_inbox: true,
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "native-closure-parity", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", preload, cli, "mcp"],
      env: { ...process.env, NOFUSS_STATE_DIR: state },
      stderr: "pipe",
    });
  const core = new NoFussCore({ ...reader, snapshot: () => ({}) }, {}, state);
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const [command, tool, args] of [
      ["attachments", "nofuss_attachments", { entity: "task", id: "task" }],
      ["sync-status", "nofuss_sync_status", {}],
      ["location", "nofuss_location", { tag_id: "tag" }],
      ["plugins", "nofuss_plugins", {}],
      ["export", "nofuss_export", { project_id: "project", format: "opml" }],
      [
        "export",
        "nofuss_export",
        { project_id: "project", format: "taskpaper" },
      ],
    ]) {
      const expected = await core.execute(command, args),
        mcp = await client.callTool({ name: tool, arguments: args });
      assert.equal(mcp.isError, undefined);
      assert.deepEqual(stable(mcp.structuredContent), stable(expected));
      const shell = spawnSync(
        process.execPath,
        ["--import", preload, cli, command, "--input", "-"],
        {
          input: JSON.stringify(args),
          encoding: "utf8",
          env: { ...process.env, NOFUSS_STATE_DIR: state },
        },
      );
      assert.equal(shell.status, 0, shell.stdout);
      assert.deepEqual(stable(JSON.parse(shell.stdout)), stable(expected));
    }
    for (const [verb, entity, args] of [
      ["trigger", "sync", { entity: "sync", document_id: "doc" }],
      ["set_location", "tag", { entity: "tag", tag_id: "tag", location: null }],
      [
        "import_outline",
        "project",
        { entity: "project", project_id: "project", text: "- safe" },
      ],
    ]) {
      const expected = await core.execute(entity + "." + verb, args),
        mcp = await client.callTool({
          name: "nofuss_" + verb,
          arguments: args,
        });
      assert.equal(mcp.isError, undefined);
      assert.deepEqual(mcp.structuredContent, expected);
      const shell = spawnSync(
        process.execPath,
        ["--import", preload, cli, verb, entity, "--input", "-"],
        {
          input: JSON.stringify(args),
          encoding: "utf8",
          env: { ...process.env, NOFUSS_STATE_DIR: state },
        },
      );
      assert.equal(shell.status, 0, shell.stdout);
      assert.deepEqual(JSON.parse(shell.stdout), expected);
    }
    assert.ok(tools.find((t) => t.name === "nofuss_trigger"));
    assert.ok(!tools.some((t) => /script|invoke/.test(t.name)));
    const bad = await client.callTool({
      name: "nofuss_import_outline",
      arguments: {
        entity: "project",
        project_id: "project",
        text: "- x @due(tomorrow)",
      },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});
