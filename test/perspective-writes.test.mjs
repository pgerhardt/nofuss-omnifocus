import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
const source = await readFile(
  new URL("../src/native/perspective-operation.js", import.meta.url),
  "utf8",
);
async function setup(t) {
  const records = new Map(),
    events = [],
    dir = await mkdtemp(join(tmpdir(), "nfo-perspective-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policy = {
    schema_version: 1,
    scopes: ["perspective.create", "perspective.update", "perspective.delete"],
    project_ids: [],
    perspective_ids: ["owned"],
    allow_perspective_creation: true,
  };
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify(policy),
    { mode: 0o600 },
  );
  const existing = {
    identifier: "owned",
    name: "same",
    archivedFilterRules: [{ actionAvailability: "remaining" }],
    archivedTopLevelFilterAggregation: null,
  };
  records.set("owned", existing);
  const Custom = {
    byIdentifier: (k) => records.get(k) ?? null,
    get all() {
      return [...records.values()];
    },
  };
  const evalNative = (op, args) => {
    const r = JSON.parse(
      vm.runInNewContext(
        "(" +
          source +
          ")(" +
          JSON.stringify({ op, args, request_id: "x" }) +
          ")",
        {
          Perspective: { Custom },
          deleteObject: (p) => {
            events.push("delete");
            records.delete(p.identifier);
          },
        },
      ),
    );
    if (r.error) throw Object.assign(Error(r.error.message), r.error);
    return r.result;
  };
  const native = {
    beforeApply: null,
    loseResponse: false,
    failConfigure: false,
    run: async (op, args) => {
      if (op === "get")
        return {
          read_at: null,
          results: args.ids.map((k) => {
            const p = records.get(k);
            return p
              ? {
                  id: k,
                  status: "ok",
                  perspective: {
                    id: k,
                    name: p.name,
                    rule_archive: {
                      format: "native_unversioned",
                      application_version: "test",
                      rules: p.archivedFilterRules,
                    },
                    rule_aggregation: p.archivedTopLevelFilterAggregation,
                  },
                }
              : {
                  id: k,
                  status: "error",
                  error: { code: "NOT_FOUND", message: "absent" },
                };
          }),
        };
      if (op === "perspective_write_apply") {
        native.beforeApply?.();
        if (args.request.operation.kind === "perspective.create") {
          try {
            evalNative("perspective_write_validate", args);
          } catch (e) {
            return {
              request_key: args.request.request_key,
              input_hash: args.input_hash,
              finished: true,
              setter_count: 0,
              perspective_id: null,
              rolled_back: false,
              error: { code: e.code, message: e.message },
            };
          }
          const p = {
            identifier: "returned-identity",
            name: args.request.items[0].changes.name,
            archivedFilterRules: [],
            archivedTopLevelFilterAggregation: null,
          };
          if (native.failConfigure)
            Object.defineProperty(p, "archivedFilterRules", {
              get: () => [],
              set: () => {
                throw Error("configuration failure");
              },
            });
          records.set(p.identifier, p);
          events.push("create");
          args = { ...args, created_id: p.identifier };
        }
        events.push("apply");
        const r = evalNative(op, args);
        if (native.loseResponse) throw Error("Lost reply");
        return r;
      }
      return evalNative(op, args);
    },
  };
  return {
    native,
    records,
    events,
    existing,
    policy,
    dir,
    core: new NoFussCore(native, {}, dir),
  };
}
const create = {
  entity: "perspective",
  name: "same",
  rules: [{ kind: "availability", value: "completed" }],
  aggregation: "all",
  apply: true,
  request_key: "create",
};
test("NATIVE-PERSPECTIVE DOUBLE: returned identity survives duplicate names, typed tree update, exact deletion and durable replay", async (t) => {
  const f = await setup(t),
    r = await f.core.mutate("perspective.create", create);
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(r.items[0].resource.id, "returned-identity");
  assert.equal(f.existing.archivedTopLevelFilterAggregation, null);
  const n = f.events.length;
  assert.deepEqual(await f.core.mutate("perspective.create", create), r);
  assert.equal(f.events.length, n);
  const updated = await f.core.mutate("perspective.update", {
    entity: "perspective",
    perspective_id: "owned",
    changes: {
      rules: [
        { kind: "group", aggregation: "none", rules: [{ kind: "flagged" }] },
      ],
      aggregation: "any",
    },
    apply: true,
    request_key: "update",
  });
  assert.equal(updated.items[0].outcome, "applied");
  assert.equal(
    (
      await f.core.mutate("perspective.delete", {
        entity: "perspective",
        perspective_id: "owned",
        apply: true,
        request_key: "delete",
      })
    ).items[0].outcome,
    "applied",
  );
});
test("NATIVE-PERSPECTIVE DOUBLE: raw archive/invalid rule and built-in/unowned mutations reject before native effects", async (t) => {
  const f = await setup(t);
  for (const rules of [
    [{ actionAvailability: "remaining" }],
    [{ kind: "script", code: "danger" }],
  ])
    await assert.rejects(
      f.core.mutate("perspective.create", { ...create, rules }),
      { code: "INVALID_MUTATION" },
    );

  const r = await f.core.mutate("perspective.update", {
    entity: "perspective",
    perspective_id: "builtin_inbox",
    changes: { name: "x" },
    apply: true,
    request_key: "builtin",
  });
  assert.notEqual(r.items?.[0]?.outcome, "applied");
  assert.equal(f.events.length, 0);
});
test("NATIVE-PERSPECTIVE DOUBLE: changed preconditions reject before constructor; partial creation rollback remains non-applied", async (t) => {
  const stale = await setup(t);
  const preview = await stale.core.mutate("perspective.create", {
    ...create,
    apply: false,
  });
  stale.records.set("new", { ...stale.existing, identifier: "new" });
  const r = await stale.core.mutate("perspective.create", {
    ...preview.apply_input,
    apply: true,
  });
  assert.notEqual(r.items?.[0]?.outcome, "applied");
  assert.equal(stale.events.length, 0);
  const f = await setup(t);
  f.native.failConfigure = true;
  const failed = await f.core.mutate("perspective.create", create);
  assert.notEqual(failed.items[0].outcome, "applied");
  assert.equal(f.records.has("returned-identity"), false);
  const n = f.events.length;
  assert.deepEqual(await f.core.mutate("perspective.create", create), failed);
  assert.equal(f.events.length, n);
});
test("NATIVE-PERSPECTIVE DOUBLE: response loss seals may-have-started journal and never replays constructor", async (t) => {
  const f = await setup(t);
  f.native.loseResponse = true;
  const r = await f.core.mutate("perspective.create", create);
  assert.equal(r.items[0].outcome, "unknown");
  const n = f.events.length;
  const repeated = await f.core.mutate("perspective.create", create);
  assert.equal(repeated.items[0].outcome, "unknown");
  assert.equal(repeated.reconciliation_required, true);
  assert.equal(f.events.length, n);
  assert.ok(f.records.has("returned-identity"));
});

test("REVIEW REGRESSION: failed perspective setter before any change is unknown, not a finalized partial effect", async (t) => {
  const f = await setup(t);
  Object.defineProperty(f.existing, "name", {
    get: () => "same",
    set: () => {
      throw Error("before effect");
    },
  });
  const input = {
    entity: "perspective",
    perspective_id: "owned",
    changes: { name: "changed" },
    apply: true,
    request_key: "failed-update",
  };
  const result = await f.core.mutate("perspective.update", input);
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
});
