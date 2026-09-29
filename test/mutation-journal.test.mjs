import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
  writeFile,
  readFile,
  chmod,
  mkdir,
  symlink,
  readdir,
} from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutationJournal, stateDirectory } from "../dist/mutation-journal.js";
import { fixture, request } from "./mutation-fixture.mjs";
async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), "nfo-journal-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return join(parent, "private-state");
}
async function prepared(dir) {
  const f = fixture(dir),
    r = request(),
    { plan } = await f.boundary.preview(r);
  return { f, r, record: await f.journal.prepare(r, plan) };
}
test("OFFLINE: state location, private directory/files, caller key cannot escape path", async (t) => {
  const dir = await setup(t),
    f = fixture(dir);
  assert.match(
    stateDirectory(),
    /Library\/Application Support\/NoFuss OmniFocus\/mutation-state$/,
  );
  const old = process.env.NOFUSS_STATE_DIR;
  try {
    process.env.NOFUSS_STATE_DIR = dir;
    assert.equal(stateDirectory(), dir);
    process.env.NOFUSS_STATE_DIR = "relative";
    assert.throws(stateDirectory);
  } finally {
    if (old === undefined) delete process.env.NOFUSS_STATE_DIR;
    else process.env.NOFUSS_STATE_DIR = old;
  }
  const r = request("../../outside");
  await f.boundary.apply(r);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(f.journal.path(r.request_key))).mode & 0o777, 0o600);
  assert.equal(await readdir(dir).then((a) => a.length), 1);
});
for (const fault of ["truncated", "schema", "hash", "permissions", "symlink"])
  test(`OFFLINE: ${fault} journal fails closed before setters`, async (t) => {
    const dir = await setup(t),
      { f, record } = await prepared(dir),
      path = f.journal.path("key");
    if (fault === "truncated") await writeFile(path, "{");
    if (fault === "schema")
      await writeFile(path, JSON.stringify({ ...record, schema_version: 99 }));
    if (fault === "hash")
      await writeFile(
        path,
        JSON.stringify({ ...record, input_hash: "0".repeat(64) }),
      );
    if (fault === "permissions") await chmod(path, 0o644);
    if (fault === "symlink") {
      const other = path + ".saved";
      await writeFile(other, JSON.stringify(record), { mode: 0o600 });
      await rm(path);
      await symlink(other, path);
    }
    assert.equal(
      (await f.boundary.apply(request())).error.code,
      "MUTATION_STATE_UNAVAILABLE",
    );
    assert.equal(f.setterCalls, 0);
  });
test("OFFLINE: unsafe directory, unavailable state and write-permission policy failure fail closed", async (t) => {
  for (const kind of ["mode", "file", "readonly", "symlink"]) {
    const dir = (await setup(t)) + kind;
    if (kind === "mode") await mkdir(dir, { mode: 0o755 });
    if (kind === "file") await writeFile(dir, "not a directory");
    if (kind === "readonly") {
      await mkdir(dir, { mode: 0o500 });
    }
    if (kind === "symlink") {
      await mkdir(dir + "-real", { mode: 0o700 });
      await symlink(dir + "-real", dir);
    }
    const f = fixture(dir);
    assert.equal(
      (await f.boundary.apply(request())).items[0].outcome,
      "rejected",
    );
    assert.equal(f.setterCalls, 0);
    if (kind === "readonly") await chmod(dir, 0o700);
  }
});
test("OFFLINE: duplicate atomic prepare never replaces first record; collision and lock metadata fail closed", async (t) => {
  const dir = await setup(t),
    { f, r, record } = await prepared(dir);
  const changed = request();
  changed.items[0].changes.value = 3;
  const { plan } = await f.boundary.preview(changed);
  assert.deepEqual(await f.journal.prepare(changed, plan), record);
  const lease = await f.journal.acquire(r.request_key);
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.schema_version, 1);
  assert.ok(Date.parse(lease.timestamp));
  assert.equal((await stat(f.journal.lockPath)).mode & 0o777, 0o600);
  await assert.rejects(f.journal.acquire("other"), { code: "MUTATION_BUSY" });
  await assert.rejects(f.journal.release({ ...lease, token: "wrong" }));
  assert.ok(await f.journal.inspectLock());
  await f.journal.release(lease);
});
test("PROCESS DOUBLE: atomic replacements readable by separate concurrent processes", async (t) => {
  const dir = await setup(t),
    { f, record } = await prepared(dir),
    lease = await f.journal.acquire("key");
  const child = fork(
    new URL("./mutation-process.mjs", import.meta.url),
    [dir, "key", "", "read-loop"],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exit = once(child, "exit"),
    message = once(child, "message");
  t.after(async () => {
    child.kill("SIGKILL");
    await exit;
  });
  let diagnostics = "";
  child.stderr.on("data", (b) => (diagnostics += b));
  for (let i = 0; i < 30; i++)
    await f.journal.write(
      { ...record, updated_at: new Date().toISOString() },
      lease,
    );
  assert.deepEqual((await message)[0], { read: true });
  await exit;
  assert.equal(diagnostics, "");
  assert.deepEqual((await f.journal.read("key")).request, record.request);
  assert.ok((await readdir(dir)).every((n) => !n.startsWith(".pending")));
  await f.journal.release(lease);
});
for (const phase of ["prepare", "marker", "final"])
  test(`OFFLINE: injected filesystem ${phase} failure never permits unsafe continuation`, async (t) => {
    const dir = await setup(t),
      journal = new MutationJournal(dir);
    if (phase === "prepare")
      journal.prepare = async () => {
        throw Error("EACCES");
      };
    else {
      const write = journal.write.bind(journal);
      journal.write = async (record, lease) => {
        if (
          phase === "marker" ||
          record.lifecycle !== "mutation-may-have-started"
        )
          throw Error("ENOSPC");
        return write(record, lease);
      };
    }
    const f = fixture(dir, { journal });
    const result = await f.boundary.apply(request());
    assert.equal(f.setterCalls, phase === "final" ? 1 : 0);
    assert.equal(
      result.items[0].outcome,
      phase === "prepare" ? "rejected" : "unknown",
    );
    if (phase !== "prepare") assert.ok(await journal.inspectLock());
    if (phase === "final")
      assert.equal(
        (await journal.read("key")).lifecycle,
        "mutation-may-have-started",
      );
  });
test("OFFLINE: failure after final write preserves prior durable final result", async (t) => {
  const dir = await setup(t),
    f = fixture(dir, {
      checkpoint: async (p) => {
        if (p === "after-finalized") throw Error("cleanup failed");
      },
    });
  await f.boundary.apply(request());
  const record = await f.journal.read("key");
  assert.equal(record.lifecycle, "finalized");
  assert.equal(record.result.items[0].outcome, "applied");
  assert.deepEqual(await f.boundary.apply(request()), record.result);
  assert.equal(f.setterCalls, 1);
  assert.ok(await f.journal.inspectLock());
  assert.ok((await readFile(f.journal.path("key"), "utf8")).endsWith("\n"));
});
test("OFFLINE: failure after final publication still returns unknown when durable acknowledgement failed", async (t) => {
  const dir = await setup(t),
    journal = new MutationJournal(dir),
    write = journal.write.bind(journal);
  journal.write = async (record, lease) => {
    await write(record, lease);
    if (record.lifecycle === "finalized")
      throw Error("directory fsync failed after rename");
  };
  const f = fixture(dir, { journal });
  const result = await f.boundary.apply(request());
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
  assert.ok(await journal.inspectLock());
  assert.equal(f.setterCalls, 1);
});
test("OFFLINE: corrupt null and unsupported lock schema are not missing state", async (t) => {
  const dir = await setup(t),
    { f } = await prepared(dir);
  await writeFile(f.journal.path("key"), "null");
  await assert.rejects(f.journal.read("key"), {
    code: "MUTATION_STATE_UNAVAILABLE",
  });
  await writeFile(f.journal.lockPath, '{"schema_version":99}', { mode: 0o600 });
  await assert.rejects(f.journal.inspectLock(), {
    code: "MUTATION_STATE_UNAVAILABLE",
  });
  await assert.rejects(f.journal.acquire("new"), { code: "MUTATION_BUSY" });
});
test("OFFLINE: journal transitions cannot revert a may-have-started record to prepared", async (t) => {
  const dir = await setup(t),
    { f, record } = await prepared(dir),
    lease = await f.journal.acquire("key");
  await f.journal.write(
    {
      ...record,
      lifecycle: "mutation-may-have-started",
      mutation_may_have_begun: true,
    },
    lease,
  );
  await assert.rejects(f.journal.write(record, lease), {
    code: "MUTATION_STATE_UNAVAILABLE",
  });
  assert.equal(
    (await f.journal.read("key")).lifecycle,
    "mutation-may-have-started",
  );
});
test("OFFLINE: old/dead-PID lock never expires or permits setters", async (t) => {
  const dir = await setup(t),
    { f } = await prepared(dir),
    lease = await f.journal.acquire("key");
  const stale = {
    ...lease,
    pid: 2147483647,
    timestamp: "2000-01-01T00:00:00.000Z",
  };
  await writeFile(f.journal.lockPath, JSON.stringify(stale));
  const result = await f.boundary.apply(request());
  assert.equal(result.error.code, "MUTATION_BUSY");
  assert.equal(f.setterCalls, 0);
  assert.deepEqual(await f.journal.inspectLock(), stale);
});
test("OFFLINE: nonregular and invalid UTF-8 journal fail closed", async (t) => {
  const dir = await setup(t),
    { f } = await prepared(dir),
    path = f.journal.path("key");
  await rm(path);
  await mkdir(path, { mode: 0o600 });
  await assert.rejects(f.journal.read("key"), {
    code: "MUTATION_STATE_UNAVAILABLE",
  });
  await rm(path, { recursive: true });
  await writeFile(path, Buffer.from([0x22, 0xff, 0x22]), { mode: 0o600 });
  await assert.rejects(f.journal.read("key"), {
    code: "MUTATION_STATE_UNAVAILABLE",
  });
});
