import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Controlled server deadline");
    await delay(10);
  }
}
function server(scenario) {
  const dir = mkdtempSync(tmpdir() + "/nofuss-stdio-"),
    ledger = dir + "/native.jsonl";
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("./server-double.mjs", import.meta.url)),
      fileURLToPath(new URL("../dist/index.js", import.meta.url)),
    ],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        NFO_TEST_SCENARIO: scenario,
        NFO_TEST_LEDGER: ledger,
      },
    },
  );
  let stdout = "",
    stderr = "",
    closed = false,
    exitCode;
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  child.on("close", (code) => {
    closed = true;
    exitCode = code;
  });
  const messages = () =>
    stdout.trim() ? stdout.trim().split("\n").map(JSON.parse) : [];
  const send = (id, method, params = {}) =>
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        ...(id === undefined ? {} : { id }),
        method,
        params,
      }) + "\n",
    );
  const response = async (id) => {
    await until(() => messages().some((m) => m.id === id));
    return messages().find((m) => m.id === id);
  };
  const events = () =>
    existsSync(ledger)
      ? readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  return {
    child,
    send,
    response,
    events,
    messages,
    get stderr() {
      return stderr;
    },
    async init() {
      send(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "controlled lifecycle test", version: "1" },
      });
      assert.ok((await response(1)).result);
      send(undefined, "notifications/initialized");
    },
    async exited() {
      await until(() => closed);
      assert.equal(exitCode, 0);
    },
    async cleanup() {
      if (!closed) {
        child.kill("SIGKILL");
        await until(() => closed);
      }
      for (const e of events()) {
        try {
          process.kill(e.pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true });
    },
  };
}
test("actual MCP registration/handlers preserve inputs and stdout stays protocol-only", async () => {
  const s = server("unavailable");
  try {
    await s.init();
    s.send(2, "tools/list");
    const tools = (await s.response(2)).result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "nofuss_get",
      "nofuss_overview",
      "nofuss_query",
      "nofuss_status",
    ]);
    assert.ok(
      tools.every(
        (t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint,
      ),
    );
    s.send(3, "tools/call", { name: "nofuss_status", arguments: {} });
    const status = (await s.response(3)).result.structuredContent;
    assert.equal(status.native.error.code, "NOT_RUNNING");
    assert.equal(status.native.connected, false);
    s.send(4, "tools/call", {
      name: "nofuss_overview",
      arguments: { waiting_tag_ids: ["tag-a", "tag-b"] },
    });
    assert.equal((await s.response(4)).result.isError, true);
    assert.deepEqual(
      s.events().find((e) => e.op === "overview").args.waiting_tag_ids,
      ["tag-a", "tag-b"],
    );
    s.send(5, "tools/call", {
      name: "nofuss_query",
      arguments: {
        entity: "project",
        scope: "library",
        flagged: false,
        fields: [],
        limit: 2,
      },
    });
    assert.equal((await s.response(5)).result.isError, true);
    const args = s.events().find((e) => e.op === "query").args;
    assert.equal(args.flagged, false);
    assert.equal(args.limit, 2);
    assert.deepEqual(args.fields, ["id"]);
    s.send(6, "tools/call", {
      name: "nofuss_overview",
      arguments: { script: "arbitrary()" },
    });
    assert.equal((await s.response(6)).result.isError, true);
    assert.equal(s.events().length, 3);
    assert.ok(s.messages().every((m) => m.jsonrpc === "2.0"));
    assert.equal(s.stderr, ""); // native stderr is never forwarded
    s.child.stdin.end();
    await s.exited();
  } finally {
    await s.cleanup();
  }
});
test("MCP EOF and SIGTERM close an in-flight owned launcher cleanly", async () => {
  for (const ending of ["eof", "signal"]) {
    const s = server("hang");
    try {
      await s.init();
      s.send(2, "tools/call", { name: "nofuss_status", arguments: {} });
      await until(() => s.events().length === 1);
      const pid = s.events()[0].pid;
      if (ending === "eof") s.child.stdin.end();
      else s.child.kill("SIGTERM");
      await s.exited();
      assert.throws(
        () => process.kill(pid, 0),
        (e) => e.code === "ESRCH",
      );
      assert.equal(s.events().length, 1);
      assert.equal(s.stderr, "");
    } finally {
      await s.cleanup();
    }
  }
});
