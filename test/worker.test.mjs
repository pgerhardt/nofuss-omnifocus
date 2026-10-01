import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { NativeWorker } from "../dist/worker.js";
const fake = fileURLToPath(new URL("./fake-native.cjs", import.meta.url));
const worker = (options = {}) =>
  new NativeWorker({
    command: process.execPath,
    prefix: [fake],
    timeoutMs: 2000,
    ...options,
  });
test("byte-by-byte UTF-8 response is decoded without corruption", async () => {
  const w = worker();
  try {
    assert.equal((await w.run("get", { scenario: "split" })).text, "Ω 😀 ’");
  } finally {
    await w.close();
  }
});
test("failure cases are explicit and the next read can recover", async () => {
  const w = worker({ outputBytes: 1000 });
  try {
    for (const [scenario, code] of [
      ["mismatch", "RESPONSE_MISMATCH"],
      ["bad", "INVALID_NATIVE_OUTPUT"],
      ["utf8bad", "INVALID_NATIVE_OUTPUT"],
      ["exit", "NATIVE_PROCESS_FAILED"],
      ["oversize", "OUTPUT_LIMIT"],
      ["stderr", "OUTPUT_LIMIT"],
    ]) {
      await assert.rejects(w.run("get", { scenario }), (e) => e.code === code);
      assert.equal((await w.run("status", {})).op, "status");
    }
  } finally {
    await w.close();
  }
});
test("spawn failure is bounded and explicit", async () => {
  const w = worker({ command: "/nonexistent/nofuss-reader" });
  await assert.rejects(w.run("get", {}), (e) => e.code === "SPAWN_FAILED");
  await w.close();
});
test("serialized queue rejects saturation and associates results", async () => {
  const w = worker({ maxPending: 2 });
  try {
    const first = w.run("first", { delay: 120 }),
      second = w.run("second", {});
    await assert.rejects(w.run("third", {}), (e) => e.code === "QUEUE_FULL");
    assert.equal(w.snapshot().queued, 1);
    assert.equal((await first).op, "first");
    assert.equal((await second).op, "second");
  } finally {
    await w.close();
  }
});
test("deadline includes queue time; timed-out reads are not replayed", async () => {
  const w = worker({ timeoutMs: 500 });
  try {
    const all = Promise.allSettled([
      w.run("query", { scenario: "hang", entity: "task", scope: "library" }),
      w.run("second", {}),
    ]);
    const results = await all;
    assert.ok(
      results.every(
        (r) => r.status === "rejected" && r.reason.code === "TIMEOUT",
      ),
    );
    assert.equal((await w.run("recovered", {})).op, "recovered");
  } finally {
    await w.close();
  }
});
test("cancellation removes queued work, terminates active launcher and shutdown rejects new work", async () => {
  const w = worker();
  const a = new AbortController(),
    b = new AbortController();
  const all = Promise.allSettled([
    w.run("first", { scenario: "hang" }, a.signal),
    w.run("second", {}, b.signal),
  ]);
  b.abort();
  a.abort();
  assert.ok(
    (await all).every(
      (r) => r.status === "rejected" && r.reason.code === "CANCELLED",
    ),
  );
  const running = w.run("last", { scenario: "hang" });
  const failure = assert.rejects(running, (e) => e.code === "SHUTDOWN");
  await w.close();
  await failure;
  await assert.rejects(w.run("after", {}), (e) => e.code === "SHUTDOWN");
});

test("permission denial is specific, stderr stays private and malformed envelopes cannot succeed", async () => {
  const w = worker();
  try {
    await assert.rejects(
      w.run("get", { scenario: "permission" }),
      (e) => e.code === "AUTOMATION_DENIED" && !e.message.includes("private"),
    );
    assert.equal((await w.run("get", { scenario: "diagnostic" })).op, "get");
    for (const scenario of [
      "empty",
      "multiple",
      "both",
      "extra",
      "missing",
      "baderror",
    ]) {
      await assert.rejects(
        w.run("get", { scenario }),
        (e) => e.code === "INVALID_NATIVE_OUTPUT",
      );
      assert.equal((await w.run("recovered", {})).op, "recovered");
    }
    await assert.rejects(
      w.run("status", { scenario: "unavailable" }),
      (e) => e.code === "NOT_RUNNING",
    );
  } finally {
    await w.close();
  }
});

test("deadline discards buffered results while independent native work can finish, with no replay or cross-request result", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/nofuss-worker-");
  const ledger = dir + "/events.jsonl";
  const events = () =>
    readFileSync(ledger, "utf8").trim().split("\n").map(JSON.parse);
  const w = worker({ timeoutMs: 400 });
  try {
    await assert.rejects(
      w.run("expired", { scenario: "late", ledger }),
      (e) => e.code === "TIMEOUT",
    );
    assert.equal((await w.run("next", { ledger })).op, "next");
    const until = Date.now() + 2000;
    while (!events().some((e) => e.event === "late") && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    const all = events(),
      launches = all.filter((e) => e.event === "launch");
    assert.deepEqual(
      launches.map((e) => e.op),
      ["expired", "next"],
    );
    assert.notEqual(launches[0].id, launches[1].id);
    assert.equal(all.find((e) => e.event === "late")?.id, launches[0].id);
    assert.equal((await w.run("after-late", {})).op, "after-late");
  } finally {
    await w.close();
    // Only this test's own simulated native process; never OmniFocus.
    for (const e of events().filter((e) => e.event === "native")) {
      try {
        process.kill(e.pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true });
  }
});

test("queued/pre-aborted cancellation never launches and shutdown settles all owned work", async () => {
  const { mkdtempSync, readFileSync, existsSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(tmpdir() + "/nofuss-cancel-"),
    ledger = dir + "/events.jsonl";
  const w = worker();
  try {
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(
      w.run("pre", { ledger }, pre.signal),
      (e) => e.code === "CANCELLED",
    );
    const first = w.run("active", { scenario: "hang", ledger });
    const cancel = new AbortController();
    const second = w.run("cancelled-queued", { ledger }, cancel.signal);
    const third = w.run("shutdown-queued", { ledger });
    const all = Promise.allSettled([first, second, third]);
    cancel.abort();
    const until = Date.now() + 1500;
    while (!existsSync(ledger) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(existsSync(ledger));
    await w.close();
    assert.deepEqual(
      (await all).map((r) => r.reason.code),
      ["SHUTDOWN", "CANCELLED", "SHUTDOWN"],
    );
    assert.deepEqual(
      readFileSync(ledger, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x).op),
      ["active"],
    );
    assert.equal(w.snapshot().state, "closed");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true });
  }
});
