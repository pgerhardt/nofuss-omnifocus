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
            ...["task.create", "task.update", "task.complete"]
              .filter((s) => scopes?.includes(s))
              .map((s) => "nofuss_" + s.slice(5)),
          ],
        );
        for (const tool of tools.slice(4)) {
          assert.equal(tool.annotations.readOnlyHint, false);
          assert.equal(tool.annotations.idempotentHint, false);
          assert.equal(tool.outputSchema, undefined);
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
