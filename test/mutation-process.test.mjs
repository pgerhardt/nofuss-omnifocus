import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MutationJournal } from "../dist/mutation-journal.js";
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "nfo-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function child(t, directory, key = "key", point = "", mode = "apply") {
  const process = fork(
    new URL("./mutation-process.mjs", import.meta.url),
    [directory, key, point, mode],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const exit = once(process, "exit");
  let diagnostics = "";
  process.stderr.on("data", (b) => (diagnostics += b));
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null)
      process.kill("SIGKILL");
    await exit;
    assert.equal(diagnostics, "");
  });
  return {
    process,
    exit,
    message: () =>
      Promise.race([
        once(process, "message").then(([m]) => m),
        exit.then(([code]) => {
          throw Error(`premature exit ${code}: ${diagnostics}`);
        }),
      ]),
  };
}
async function run(t, dir, key = "key", mode = "apply") {
  const c = child(t, dir, key, "", mode);
  const m = await c.message();
  await c.exit;
  return m;
}
async function count(dir) {
  try {
    return (await readFile(join(dir, "double-setters"), "utf8"))
      .trim()
      .split("\n").length;
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
}
const matrix = [
  ["A", "before-prepare", null, false, 0],
  ["B", "after-prepared", "prepared", false, 0],
  ["C", "after-lock", "prepared", true, 0],
  ["D", "after-marker", "mutation-may-have-started", true, 0],
  ["E", "during-setter", "mutation-may-have-started", true, 1],
  ["F", "response-lost", "mutation-may-have-started", true, 1],
  ["G", "after-setter", "mutation-may-have-started", true, 1],
  ["H", "during-readback", "mutation-may-have-started", true, 1],
  ["I", "after-readback", "mutation-may-have-started", true, 1],
  ["J", "after-finalized", "finalized", true, 1],
];
for (const [label, point, lifecycle, locked, setters] of matrix)
  test(
    `PROCESS DOUBLE: crash ${label} ${point}`,
    { timeout: 15000 },
    async (t) => {
      const dir = await setup(t),
        journal = new MutationJournal(dir);
      const c = child(t, dir, "key", point);
      assert.deepEqual(await c.message(), { point });
      c.process.kill("SIGKILL");
      await c.exit;
      assert.equal((await journal.read("key"))?.lifecycle ?? null, lifecycle);
      assert.equal(Boolean(await journal.inspectLock()), locked);
      assert.equal(await count(dir), setters);
      if (lifecycle) {
        const inspection = await run(t, dir, "key", "inspect");
        assert.equal(inspection.inspection.record.lifecycle, lifecycle);
        assert.equal(await count(dir), setters, "inspection never mutates");
      }
      const next = (await run(t, dir)).result;
      if (["A", "B"].includes(label)) {
        assert.equal(next.items[0].outcome, "applied");
        assert.equal(await count(dir), 1);
      } else {
        assert.equal(
          await count(dir),
          setters,
          "next independent process cannot replay",
        );
        assert.equal(
          next.items[0].outcome,
          label === "C"
            ? "rejected"
            : ["D", "E"].includes(label)
              ? "unknown"
              : "applied",
        );
        if (label !== "J") assert.equal(next.error.code, "MUTATION_BUSY");
        const other = (await run(t, dir, "different")).result;
        assert.notEqual(other.items[0].outcome, "applied");
        assert.equal(await count(dir), setters);
        assert.ok(
          await journal.inspectLock(),
          "never automatically break crashed holder lock",
        );
      }
    },
  );
test(
  "PROCESS DOUBLE: concurrent processes cannot both enter apply; normal completion releases lock",
  { timeout: 15000 },
  async (t) => {
    const dir = await setup(t),
      first = child(t, dir, "first", "after-marker");
    await first.message();
    const second = (await run(t, dir, "second")).result;
    assert.equal(second.error.code, "MUTATION_BUSY");
    assert.equal(await count(dir), 0);
    const response = first.message();
    first.process.send("continue");
    assert.equal((await response).result.items[0].outcome, "applied");
    await first.exit;
    assert.equal(await count(dir), 1);
    assert.equal(await new MutationJournal(dir).inspectLock(), null);
  },
);
test(
  "PROCESS DOUBLE: simultaneous same key runs at most one setter; finalized duplicate is reused",
  { timeout: 15000 },
  async (t) => {
    const dir = await setup(t),
      first = child(t, dir, "key", "after-marker");
    await first.message();
    const second = (await run(t, dir)).result;
    assert.equal(second.reconciliation_required, true);
    const response = first.message();
    first.process.send("continue");
    await response;
    await first.exit;
    assert.equal((await run(t, dir)).result.items[0].outcome, "applied");
    assert.equal(await count(dir), 1);
  },
);
test(
  "PROCESS DOUBLE: launcher exit does not stop dispatched work; global lock prevents a second mutation",
  { timeout: 15000 },
  async (t) => {
    const dir = await setup(t),
      launcher = child(t, dir, "key", "late-work");
    const first = (await launcher.message()).result;
    await launcher.exit;
    assert.equal(first.items[0].outcome, "unknown");
    assert.ok(await new MutationJournal(dir).inspectLock());
    const second = (await run(t, dir, "other")).result;
    assert.notEqual(second.items[0].outcome, "applied");
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await readFile(join(dir, "double-running"));
      } catch (e) {
        if (e.code === "ENOENT") break;
        throw e;
      }
      assert.ok(Date.now() < deadline, "late double must finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      JSON.parse(await readFile(join(dir, "double-state"), "utf8")).value,
      2,
    );
    assert.equal((await run(t, dir)).result.items[0].outcome, "applied");
    assert.ok(
      await new MutationJournal(dir).inspectLock(),
      "read-only reconciliation never casually unlocks",
    );
    assert.equal(await count(dir), 1);
  },
);
