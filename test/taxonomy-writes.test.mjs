import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaxonomyWrites } from "../dist/taxonomy-writes.js";
import { fixture } from "./taxonomy-write-fixture.mjs";
async function setup(t, entity) {
  const f = fixture(),
    dir = await mkdtemp(join(tmpdir(), "nfo-taxonomy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const C = entity === "tag" ? f.Tag : f.Folder,
    parent = new C("parent"),
    child = new C("child", parent);
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      project_ids: [],
      scopes: [entity + ".create", entity + ".update", entity + ".move"],
      [entity + "_ids"]: [parent.id.primaryKey, child.id.primaryKey],
      ["allow_" + entity + "_creation"]: true,
    }),
    { mode: 0o600 },
  );
  return {
    ...f,
    original: f,
    parent,
    child,
    writes: new TaxonomyWrites(f.native, f.core, dir),
  };
}
for (const entity of ["tag", "folder"]) {
  test(
    "NATIVE-ALGORITHM DOUBLE: " +
      entity +
      " constructor identity, parent move/root and key reuse",
    async (t) => {
      const f = await setup(t, entity);
      const args = {
        entity,
        name: "created",
        parent_id: f.parent.id.primaryKey,
        apply: true,
        request_key: "create",
      };
      const r = await f.writes.execute(entity + ".create", args);
      assert.equal(r.items[0].outcome, "applied");
      const n = f.records[entity].get(r.items[0].resource.id);
      assert.equal(n.parent, f.parent);
      assert.deepEqual(await f.writes.execute(entity + ".create", args), r);
      assert.equal(
        (
          await f.writes.execute(entity + ".create", {
            ...args,
            name: "changed",
          })
        ).error.code,
        "REQUEST_KEY_REUSE_MISMATCH",
      );
      const root = await f.writes.execute(entity + ".move", {
        entity,
        [entity + "_id"]: f.child.id.primaryKey,
        parent_id: null,
        apply: true,
        request_key: "root",
      });
      assert.equal(root.items[0].outcome, "applied");
      assert.equal(f.child.parent, null);
    },
  );
  test(
    "NATIVE-ALGORITHM DOUBLE: " +
      entity +
      " whole-request cycle/inactive rejection and stale snapshot conflict",
    async (t) => {
      const f = await setup(t, entity),
        before = f.original.setters;
      for (const [target, parent] of [
        [f.parent, f.parent],
        [f.parent, f.child],
      ]) {
        const r = await f.writes.execute(entity + ".move", {
          entity,
          [entity + "_id"]: target.id.primaryKey,
          parent_id: parent.id.primaryKey,
          apply: true,
          request_key: target.id.primaryKey + parent.id.primaryKey,
        });
        assert.equal(r.items[0].outcome, "rejected");
      }
      assert.equal(f.original.setters, before);
      const input = {
        entity,
        [entity + "_id"]: f.child.id.primaryKey,
        changes: { name: "new" },
      };
      const preview = await f.writes.execute(entity + ".update", input);
      f.child.name = "external";
      const conflict = await f.writes.execute(entity + ".update", {
        ...preview.apply_input,
        apply: true,
        request_key: "conflict",
      });
      assert.equal(conflict.items[0].outcome, "conflict");
      assert.equal(f.child.name, "external");
    },
  );
}
test("NATIVE-ALGORITHM DOUBLE: tag status roundtrip and exclusive parent rejected without association effects", async (t) => {
  const f = await setup(t, "tag");
  for (const status of ["on_hold", "dropped", "active"]) {
    const r = await f.writes.execute("tag.update", {
      entity: "tag",
      tag_id: f.child.id.primaryKey,
      changes: { status },
      apply: true,
      request_key: status,
    });
    assert.equal(r.items[0].outcome, "applied");
  }
  f.parent.childrenAreMutuallyExclusive = true;
  const r = await f.writes.execute("tag.move", {
    entity: "tag",
    tag_id: f.child.id.primaryKey,
    parent_id: null,
    apply: true,
    request_key: "exclusive",
  });
  assert.equal(r.items[0].outcome, "rejected");
  assert.equal(f.child.parent, f.parent);
});
