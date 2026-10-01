import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NoFussCore } from "../dist/core.js";
import { CAPABILITIES } from "../dist/contract.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test("PROCESS DOUBLE: public MCP catalog is still exactly four reads; no native operation required", async () => {
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
      ["nofuss_get", "nofuss_query", "nofuss_overview", "nofuss_status"],
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
      "get|query|overview|doctor",
      "overview",
      "doctor",
      "mcp",
      "create|update|complete|move|drop|duplicate|delete",
      "batch",
      "review",
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
