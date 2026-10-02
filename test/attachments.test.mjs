import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  readFile,
  mkdtemp,
  writeFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Attachments } from "../dist/attachments.js";
import { readAttachmentFile } from "../dist/attachment-paths.js";
import { NoFussCore } from "../dist/core.js";
import { runCli } from "../dist/cli-command.js";
import { mcpResult } from "../dist/service.js";
const source = await readFile(
  new URL("../src/native/attachment-operation.js", import.meta.url),
  "utf8",
);
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-attachment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "allowed");
  await mkdir(root);
  const path = join(root, "bytes.bin");
  await writeFile(path, Buffer.from([0, 1, 254, 255]));
  await writeFile(
    join(dir, "attachment-authorization.json"),
    JSON.stringify({ schema_version: 1, read_roots: [root] }),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: [
        "task.attach",
        "task.detach",
        "project.attach",
        "project.detach",
      ],
      project_ids: ["p"],
      task_ids: ["t"],
    }),
    { mode: 0o600 },
  );
  const types = { File: "file", Directory: "directory", Link: "link" },
    wrap = (filename, b64) => ({
      preferredFilename: filename,
      filename: null,
      type: types.File,
      contents: {
        length: Buffer.from(b64, "base64").length,
        toBase64: () => b64,
      },
    });
  const records = {
    t: { id: { primaryKey: "t" }, attachments: [], containingProject: null },
    p: {
      id: { primaryKey: "p" },
      attachments: [],
      task: { containingProject: null },
    },
  };
  let setters = 0,
    calls = [];
  for (const o of Object.values(records)) {
    o.addAttachment = (w) => {
      setters++;
      o.attachments.push(w);
    };
    o.removeAttachmentAtIndex = (i) => {
      setters++;
      o.attachments.splice(i, 1);
    };
  }
  const native = {
    snapshot: () => ({}),
    run: async (op, args) => {
      calls.push(op);
      const r = JSON.parse(
        vm.runInNewContext(
          "(" +
            source +
            ")(" +
            JSON.stringify({ request_id: "x", op, args }) +
            ")",
          {
            Task: { byIdentifier: (k) => (k === "t" ? records.t : null) },
            Project: { byIdentifier: (k) => (k === "p" ? records.p : null) },
            FileWrapper: {
              Type: types,
              withContents: (n, d) => wrap(n, d.toBase64()),
            },
            Data: {
              fromBase64: (b) => ({
                length: Buffer.from(b, "base64").length,
                toBase64: () => b,
              }),
            },
          },
        ),
      );
      if (r.error) throw Object.assign(Error(r.error.message), r.error);
      return r.result;
    },
  };
  return {
    dir,
    path,
    root,
    native,
    records,
    wrap,
    writes: new Attachments(native, dir),
    get setters() {
      return setters;
    },
    calls,
  };
}
for (const entity of ["task", "project"])
  test(
    "attachment " +
      entity +
      " binary add/read/remove, same-name identity and finalized replay",
    async (t) => {
      const f = await setup(t),
        id = entity === "task" ? "t" : "p";
      const args = {
        entity,
        id,
        path: f.path,
        filename: "same.bin",
        apply: true,
        request_key: "add",
      };
      const added = await f.writes.execute(entity + ".attach", args);
      assert.equal(added.items[0].outcome, "applied", JSON.stringify(added));
      const list = await f.writes.read({ entity, id }),
        h = list.attachments[0].handle;
      assert.equal(
        (await f.writes.read({ entity, id, handle: h })).data_base64,
        "AAH+/w==",
      );
      const n = f.setters;
      assert.deepEqual(await f.writes.execute(entity + ".attach", args), added);
      assert.equal(f.setters, n);
      const remove = {
        entity,
        id,
        handle: h,
        apply: true,
        request_key: "remove",
      };
      const removed = await f.writes.execute(entity + ".detach", remove);
      assert.equal(
        removed.items[0].outcome,
        "applied",
        JSON.stringify(removed),
      );
      assert.deepEqual(
        await f.writes.execute(entity + ".detach", remove),
        removed,
      );
      assert.equal((await f.writes.read({ entity, id })).attachments.length, 0);
    },
  );
test("attachment identical duplicates reject, same-name distinct bytes are unambiguous", async (t) => {
  const f = await setup(t);
  f.records.t.attachments.push(
    f.wrap("x", "AA=="),
    f.wrap("x", "AA=="),
    f.wrap("x", "AQ=="),
  );
  const list = await f.writes.read({ entity: "task", id: "t" });
  await assert.rejects(
    () =>
      f.writes.read({
        entity: "task",
        id: "t",
        handle: list.attachments[0].handle,
      }),
    /duplicated/,
  );
  const r = await f.writes.execute("task.detach", {
    entity: "task",
    id: "t",
    handle: list.attachments[0].handle,
    apply: true,
    request_key: "ambiguous",
  });
  assert.equal(r.items[0].outcome, "rejected");
  assert.equal(f.setters, 0);
  assert.equal(
    (
      await f.writes.execute("task.detach", {
        entity: "task",
        id: "t",
        handle: list.attachments[2].handle,
        apply: true,
        request_key: "unique",
      })
    ).items[0].outcome,
    "applied",
  );
});
test("attachment stale complete set conflicts; unauthorized owner and large/directory inventories fail closed", async (t) => {
  const f = await setup(t);
  const a = { entity: "task", id: "t", path: f.path, filename: "x" };
  const p = await f.writes.execute("task.attach", a);
  f.records.t.attachments.push(f.wrap("new", "AA=="));
  const r = await f.writes.execute("task.attach", {
    ...p.apply_input,
    apply: true,
    request_key: "stale",
  });
  assert.equal(r.items[0].outcome, "conflict");
  assert.equal(f.setters, 0);
  f.records.t.attachments = [
    { preferredFilename: "directory", type: "directory" },
  ];
  await assert.rejects(
    () => f.writes.execute("task.attach", a),
    /Mutation requires/,
  );
  assert.equal(f.setters, 0);
});
test("attachment filesystem authority resolves symlinks, denies escapes/private roots, siblings, missing policy and oversized files", async (t) => {
  const f = await setup(t);
  assert.equal(await readAttachmentFile(f.path, f.dir), "AAH+/w==");
  const outside = join(f.dir, "outside");
  await writeFile(outside, "private");
  const link = join(f.root, "escape");
  await symlink(outside, link);
  await assert.rejects(() => readAttachmentFile(link, f.dir), /outside/);
  const inside = join(f.root, "inside");
  await symlink(f.path, inside);
  assert.equal(await readAttachmentFile(inside, f.dir), "AAH+/w==");
  await assert.rejects(() => readAttachmentFile("relative", f.dir), /outside/);
  await writeFile(f.path, Buffer.alloc(16385));
  await assert.rejects(() => readAttachmentFile(f.path, f.dir), /16384/);
  await writeFile(
    join(f.dir, "attachment-authorization.json"),
    JSON.stringify({ schema_version: 1, read_roots: ["/"] }),
    { mode: 0o600 },
  );
  await assert.rejects(() => readAttachmentFile(outside, f.dir), /outside/);
});
test("attachment core/CLI/MCP data parity and strict read input", async (t) => {
  const f = await setup(t);
  const core = new NoFussCore(f.native, {}, f.dir);
  const data = await core.execute("attachments", { entity: "task", id: "t" });
  const cli = JSON.parse(
    (
      await runCli(["attachments", "--input", "-"], core, async () => ({
        entity: "task",
        id: "t",
      }))
    ).json,
  );
  delete data.read_at;
  delete cli.read_at;
  assert.deepEqual(cli, data);
  assert.deepEqual(mcpResult(data).structuredContent, data);
  await assert.rejects(
    () =>
      core.execute("attachments", { entity: "task", id: "t", path: f.path }),
    /strict/,
  );
});

test("near-bound attachment previews stay within MCP output budget and excessive metadata rejects", async (t) => {
  const f = await setup(t);
  const bytes = Buffer.alloc(16384, 42);
  await writeFile(f.path, Buffer.alloc(4096, 42));
  f.records.t.attachments = [f.wrap("existing", bytes.toString("base64"))];
  const p = await f.writes.execute("task.attach", {
    entity: "task",
    id: "t",
    path: f.path,
    filename: "new",
  });
  const m = mcpResult(p);
  assert.notEqual(m.isError, true, JSON.stringify(m));
  assert.ok(Buffer.byteLength(JSON.stringify(m)) < 65536);
  f.records.t.attachments[0].preferredFilename = "x".repeat(512);
  f.records.t.attachments.push(
    f.wrap("x".repeat(512), bytes.toString("base64")),
  );
  await assert.rejects(() =>
    f.writes.execute("task.attach", {
      entity: "task",
      id: "t",
      path: f.path,
      filename: "new",
    }),
  );
  assert.equal(f.setters, 0);
});

test("installed Link enum and bounded directory metadata never follow link targets; directory mutation still rejects", async (t) => {
  const f = await setup(t),
    link = {
      type: "link",
      preferredFilename: "link",
      destination: { toString: () => "file:///unread/target" },
      get contents() {
        throw Error("must not follow");
      },
    };
  f.records.t.attachments = [
    link,
    {
      type: "directory",
      preferredFilename: "folder",
      children: [f.wrap("child", "AA=="), link],
    },
  ];
  const r = await f.writes.read({ entity: "task", id: "t" });
  assert.equal(r.attachments[0].type, "symlink");
  assert.equal(r.attachments[0].reference_url, "file:///unread/target");
  assert.equal(r.attachments[1].tree_status, "available");
  assert.equal(r.attachments[1].tree[1].type, "symlink");
  await assert.rejects(
    () =>
      f.writes.execute("task.attach", {
        entity: "task",
        id: "t",
        path: f.path,
        filename: "new",
      }),
    /Mutation requires/,
  );
  assert.equal(f.setters, 0);
  f.records.t.attachments[1].children = Array(21).fill(link);
  assert.equal(
    (await f.writes.read({ entity: "task", id: "t" })).attachments[1]
      .tree_status,
    "unsupported",
  );
});
