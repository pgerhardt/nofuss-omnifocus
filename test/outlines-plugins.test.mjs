import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outlines, parseOutline } from "../dist/outlines.js";
import { plugins } from "../dist/plugins.js";
import { inputHash } from "../dist/mutation-contract.js";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-outline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["project.import_outline"],
      project_ids: ["project"],
      allow_inbox: true,
    }),
    { mode: 0o600 },
  );
  return dir;
}
test("strict outline parsing rejects metadata, notes, project syntax, skipped depths and oversize before native calls", () => {
  for (const text of [
    "",
    "- x @due(tomorrow)",
    "Project:",
    "- Project:",
    "- root\n\t\t- skipped",
    "- root\n  note",
    "- x ",
    "- x\n" + Array(21).fill("- extra").join("\n"),
    "- " + "x".repeat(513),
  ])
    assert.throws(() => parseOutline(text));
  assert.deepEqual(parseOutline("- root\n\t- child\n- second"), [
    { name: "root", depth: 0, parent: -1 },
    { name: "child", depth: 1, parent: 0 },
    { name: "second", depth: 0, parent: -1 },
  ]);
});
test("export escape/fidelity and complete topology reject invalid native inventories or oversized content", async () => {
  const root = {
      id: "root",
      parent_id: null,
      name: '< & "',
      note: "line\nnext",
      flagged: true,
      due_at: null,
      defer_at: null,
      attachments: 0,
    },
    child = { ...root, id: "child", parent_id: "root", name: "child" };
  let rows = [root, child],
    data = "- native\n";
  const exporter = new Outlines({
    run: async () => ({ project_id: "project", root_id: "root", rows, data }),
  });
  const opml = await exporter.export({ project_id: "project", format: "opml" });
  assert.ok(opml.data.includes("&lt; &amp; &quot;"));
  assert.ok(opml.data.includes("line&#10;next"));
  assert.equal(opml.fidelity, "nofuss_opml_outline");
  assert.ok(opml.warnings[1].includes("attachments"));
  assert.equal(
    (await exporter.export({ project_id: "project", format: "taskpaper" }))
      .data,
    data,
  );
  rows = [root, { ...child, parent_id: "missing" }];
  await assert.rejects(
    () => exporter.export({ project_id: "project", format: "opml" }),
    /preorder/,
  );
  rows = [root];
  data = "x".repeat(24001);
  await assert.rejects(
    () => exporter.export({ project_id: "project", format: "taskpaper" }),
    /budget/,
  );
});
test("outline import independently verifies generated hierarchy/ownership and finalized replay", async (t) => {
  const dir = await setup(t);
  let dest = {
      id: "project",
      exists: true,
      active: true,
      repeat: false,
      tentative: false,
      child_ids: [],
      root_id: "project",
    },
    items = [],
    calls = [];
  const native = {
    run: async (op, a) => {
      calls.push(op);
      if (op === "import_facts")
        return { reference: a.reference, facts: structuredClone(dest) };
      if (op === "import_readback")
        return {
          destination: structuredClone(dest),
          items: structuredClone(items),
        };
      items = [
        {
          id: "new1",
          name: "root",
          parent_id: "project",
          project_id: "project",
          child_ids: ["new2"],
          ordinary: true,
          note: "",
          flagged: false,
          due_at: null,
          defer_at: null,
          estimated_minutes: null,
        },
        {
          id: "new2",
          name: "child",
          parent_id: "new1",
          project_id: "project",
          child_ids: [],
          ordinary: true,
          note: "",
          flagged: false,
          due_at: null,
          defer_at: null,
          estimated_minutes: null,
        },
      ];
      dest.child_ids = ["new1"];
      return {
        request_key: a.request.request_key,
        input_hash: inputHash(a.request),
        finished: true,
        setter_count: 2,
        project_id: "project",
        roots: ["new1"],
        inventory: [
          { id: "new1", name: "root", parent_id: null },
          { id: "new2", name: "child", parent_id: "new1" },
        ],
        error: null,
      };
    },
  };
  const outlines = new Outlines(native, dir),
    a = {
      entity: "project",
      project_id: "project",
      text: "- root\n\t- child",
      apply: true,
      request_key: "import",
    };
  const r = await outlines.import(a);
  assert.equal(r.items[0].outcome, "applied");
  assert.ok(calls.indexOf("import_readback") > calls.indexOf("import_apply"));
  const count = calls.length;
  assert.deepEqual(await outlines.import(a), r);
  assert.equal(calls.length, count);
});
test("lost import identity receipt stays unknown without replay", async (t) => {
  const dir = await setup(t);
  let count = 0,
    children = [];
  const out = new Outlines(
    {
      run: async (op, a) => {
        if (op === "import_facts")
          return {
            reference: a.reference,
            facts: {
              id: "project",
              exists: true,
              active: true,
              repeat: false,
              tentative: false,
              child_ids: children,
              root_id: "project",
            },
          };
        count++;
        throw Error("lost identities");
      },
    },
    dir,
  );
  const args = {
    entity: "project",
    project_id: "project",
    text: "- x",
    apply: true,
    request_key: "unknown",
  };
  assert.equal((await out.import(args)).items[0].outcome, "unknown");
  assert.equal((await out.import(args)).items[0].outcome, "unknown");
  assert.equal(count, 1);
});
test("plug-in discovery rejects duplicate identifiers and unknown/side-effect input; invocation has no contract", async () => {
  const r = {
      plugins: [
        {
          identifier: "plugin",
          name: "Plugin",
          version: "1",
          actions: [{ identifier: "action", label: "Action" }],
        },
      ],
      invocation: "intentionally_excluded",
      observed_at: new Date().toISOString(),
    },
    native = { run: async () => r };
  assert.equal(
    (await plugins(native, {})).invocation,
    "intentionally_excluded",
  );
  await assert.rejects(() => plugins(native, { invoke: "action" }));
  r.plugins[0].actions.push({ ...r.plugins[0].actions[0] });
  await assert.rejects(() => plugins(native, {}), /identity/);
});

test("metadata TaskPaper parsing is explicit, complete and rejects unsupported/ambiguous annotations", async () => {
  const { parseTaskPaper } = await import("../dist/import-outline.js");
  const [n, child] = parseTaskPaper(
    "- root @flagged @due(2027-01-10T15:00:00.000Z) @estimate(30)\n\tplain note\n\t- child",
  );
  assert.equal(n.flagged, true);
  assert.equal(n.note, "plain note");
  assert.equal(n.estimated_minutes, 30);
  assert.equal(child.parent, 0);
  for (const text of [
    "- x @tag(guess)",
    "- x @due(tomorrow)",
    "- x @due(2026-02-30T00:00:00.000Z)",
    "- x @estimate(3.5)",
    "- x @flagged @flagged",
    "- x\n\t- ambiguous @repeat(foo)",
    "- x\n note",
  ])
    assert.throws(() => parseTaskPaper(text));
});

test("selected export verifies exact membership, topology and complete bounds instead of flattening missing objects", async () => {
  const p = {
    project_id: "p",
    root_id: "p",
    folder_id: "f",
    rows: [
      {
        id: "p",
        parent_id: null,
        name: "project",
        note: "",
        flagged: false,
        due_at: null,
        defer_at: null,
        attachments: 0,
      },
    ],
    data: null,
  };
  let r = {
    projects: [p],
    folders: [{ id: "f", name: "folder", parent_id: null, child_ids: ["p"] }],
    data: "native",
  };
  const out = new Outlines({ run: async () => r });
  assert.ok(
    (await out.export({ folder_id: "f", format: "opml" })).data.includes(
      'type="nofuss:folder"',
    ),
  );
  r.folders[0].child_ids.push("missing");
  await assert.rejects(
    () => out.export({ folder_id: "f", format: "opml" }),
    /membership/,
  );
  await assert.rejects(() =>
    out.export({ project_ids: ["p", "p"], format: "taskpaper" }),
  );
});

test("import readback checks the complete destination identity/state, not only appended child order", async (t) => {
  const dir = await setup(t),
    before = {
      id: "project",
      exists: true,
      active: true,
      repeat: false,
      tentative: false,
      root_id: "project",
      child_ids: [],
    };
  const native = {
    run: async (op, a) => {
      if (op === "import_facts")
        return { reference: a.reference, facts: before };
      if (op === "import_readback")
        return {
          destination: { ...before, active: false, child_ids: ["new"] },
          items: [
            {
              id: "new",
              name: "x",
              parent_id: "project",
              project_id: "project",
              child_ids: [],
              ordinary: true,
              note: "",
              flagged: false,
              due_at: null,
              defer_at: null,
              estimated_minutes: null,
            },
          ],
        };
      return {
        request_key: a.request.request_key,
        input_hash: inputHash(a.request),
        finished: true,
        setter_count: 2,
        project_id: "project",
        roots: ["new"],
        inventory: [{ id: "new", name: "x", parent_id: null }],
        error: null,
      };
    },
  };
  const r = await new Outlines(native, dir).import({
    entity: "project",
    project_id: "project",
    text: "- x",
    apply: true,
    request_key: "changed-destination",
  });
  assert.equal(r.items[0].outcome, "partial");
});

test("TaskPaper rejects lossy boundary whitespace and preserves interior blank note lines", async () => {
  const { parseTaskPaper } = await import("../dist/import-outline.js");
  assert.throws(() => parseTaskPaper("- task\n\t\n\tfirst"));
  assert.throws(() => parseTaskPaper("- task\n\tfirst\n\t"));
  assert.equal(
    parseTaskPaper("- task\n\tfirst\n\t\n\tlast")[0].note,
    "first\n\nlast",
  );
});
test("all import formats reject excess UTF-8 bytes before native parsing", async () => {
  const { ImportInput } = await import("../dist/outlines.js");
  for (const format of ["outline", "taskpaper", "opml"])
    assert.equal(
      ImportInput.safeParse({
        entity: "project",
        project_id: "p",
        format,
        text: "界".repeat(5500),
      }).success,
      false,
    );
});
