import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutationBoundary } from "../dist/mutation.js";
import {
  canonical,
  inputHash,
  normalize,
  MutationError,
  mutationErrorInfo,
} from "../dist/mutation-contract.js";
import { mcpResult } from "../dist/service.js";
import { fixture, request, ref } from "./mutation-fixture.mjs";
async function setup(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "nfo-mutation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return fixture(directory, options);
}
test("OFFLINE: canonical meaning, strict request key, versions, IDs, changes, preconditions and payload", () => {
  const a = request();
  assert.equal(inputHash(a), inputHash({ ...a, request_key: "another" }));
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  for (const change of [
    (r) => r.operation.version++,
    (r) => (r.items[0].targets[0].id = "b"),
    (r) => r.items[0].references.push(ref("b")),
    (r) => r.items[0].changes.value++,
    (r) => r.items[0].preconditions[0].expected++,
    (r) => (r.items[0].payload = "different"),
  ]) {
    const b = structuredClone(a);
    change(b);
    assert.notEqual(inputHash(a), inputHash(b));
  }
  const noKey = request();
  delete noKey.request_key;
  assert.throws(() => normalize(noKey, true), { code: "INVALID_MUTATION" });
  assert.doesNotThrow(() => normalize(noKey));
  for (const bad of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    [undefined],
    Array(1),
    { x: undefined },
  ])
    assert.throws(() => canonical(bad));
  assert.throws(() => normalize({ ...a, presentation: "ignored?" }), {
    code: "INVALID_MUTATION",
  });
  assert.throws(() => normalize({ ...a, items: [a.items[0], a.items[0]] }));
});
test("NATIVE-ALGORITHM DOUBLE: preview cannot invoke any setter or construct native objects", async (t) => {
  const f = await setup(t, {
    setter: () => {
      throw Error("ANY MUTATION FORBIDDEN");
    },
  });
  const native = new Proxy(
    { value: 1 },
    {
      set() {
        throw Error("native setter");
      },
      defineProperty() {
        throw Error("native define");
      },
      deleteProperty() {
        throw Error("native delete");
      },
    },
  );
  f.objects.set("a", native);
  const r = request();
  delete r.request_key;
  assert.equal(
    (await f.boundary.preview(r)).plan.items[0].predicted_changes.value,
    2,
  );
  assert.equal(f.setterCalls, 0);
  assert.deepEqual(
    await import("node:fs/promises").then((fs) =>
      fs.readdir(f.journal.directory),
    ),
    [],
  );
});
test("NATIVE-ALGORITHM DOUBLE: all references and all items validated before any setter", async (t) => {
  const f = await setup(t);
  let r = request("invalid", ["a", "b"]);
  r.items[1].changes = { unsupported: true };
  assert.equal((await f.boundary.apply(r)).items[0].outcome, "rejected");
  assert.equal(f.setterCalls, 0);
  assert.deepEqual(f.events.slice(0, 4), [
    "resolve:a",
    "resolve:b",
    "validate:a",
    "validate:b",
  ]);
  r = request("missing", ["a", "missing"]);
  assert.equal((await f.boundary.apply(r)).items[0].outcome, "rejected");
  r = request("wrong");
  f.reader.resolve = async (reference) => ({
    reference: { ...reference, entity: "wrong" },
    facts: {},
  });
  assert.equal((await f.boundary.apply(r)).items[0].outcome, "rejected");
  assert.equal(f.setterCalls, 0);
});
test("OFFLINE: default deny and preview-only authorization; domain errors serialize internally", async (t) => {
  const f = await setup(t);
  const denied = new MutationBoundary(f.planner, f.reader, f.writer, f.journal);
  const deniedResult = await denied.apply(request());
  assert.equal(deniedResult.error.code, "WRITE_NOT_AUTHORIZED");
  assert.equal(deniedResult.items[0].outcome, "rejected");
  await assert.rejects(denied.preview(request()), {
    code: "WRITE_NOT_AUTHORIZED",
  });
  const preview = new MutationBoundary(
    f.planner,
    f.reader,
    f.writer,
    f.journal,
    { mode: "preview-authorized" },
  );
  await preview.preview(request());
  assert.equal(
    (await preview.apply(request())).error.code,
    "WRITE_NOT_AUTHORIZED",
  );
  const error = mutationErrorInfo(
    new MutationError("WRITE_NOT_AUTHORIZED", "denied"),
  );
  assert.deepEqual(JSON.parse(mcpResult({ error }, true).content[0].text), {
    error,
  });
  assert.equal(f.setterCalls, 0);
});
for (const change of ["field", "deleted"])
  test(`NATIVE-ALGORITHM DOUBLE: lock-time ${change} precondition conflict has zero setters`, async (t) => {
    let f;
    f = await setup(t, {
      checkpoint: async (p) => {
        if (p === "after-lock") {
          if (change === "field") f.objects.get("a").value = 9;
          else f.objects.delete("a");
        }
      },
    });
    const result = await f.boundary.apply(request());
    assert.equal(result.items[0].outcome, "conflict");
    assert.equal(result.error.code, "PRECONDITION_CONFLICT");
    assert.equal(f.setterCalls, 0);
    assert.equal(await f.journal.inspectLock(), null);
  });
test("NATIVE-ALGORITHM DOUBLE: unchanged preconditions apply; duplicate final result is durable and immutable", async (t) => {
  const f = await setup(t);
  const result = await f.boundary.apply(request());
  assert.equal(result.items[0].outcome, "applied");
  assert.equal(f.setterCalls, 1);
  assert.equal(f.readbackCalls, 1);
  const next = fixture(f.journal.directory); // Independent host instance, changed native state.
  assert.deepEqual(await next.boundary.apply(request()), result);
  assert.equal(next.setterCalls, 0);
  assert.equal(next.readbackCalls, 0);
  const mismatch = request();
  mismatch.items[0].changes.value = 3;
  assert.equal(
    (await next.boundary.apply(mismatch)).error.code,
    "REQUEST_KEY_REUSE_MISMATCH",
  );
  assert.deepEqual((await f.journal.read("key")).result, result);
});
for (const scenario of [
  "mismatch",
  "missing",
  "partial",
  "lost-present",
  "lost-ambiguous",
  "readback-throws",
  "still-running",
])
  test(`NATIVE-ALGORITHM DOUBLE: independent readback ${scenario}`, async (t) => {
    const f = await setup(t, {
      setter: async (req, objects) => {
        if (
          [
            "lost-present",
            "readback-throws",
            "still-running",
            "partial",
          ].includes(scenario)
        )
          objects.get("a").value = 2;
        if (scenario === "missing") objects.delete("a");
        if (scenario.startsWith("lost")) throw Error("response lost");
        return { success: true, applied: true }; // Ignored entirely.
      },
      ...(scenario === "readback-throws"
        ? {
            readback: () => {
              throw Error("unavailable");
            },
          }
        : {}),
      ...(["partial", "still-running"].includes(scenario)
        ? {
            readback: async () => ({
              settled: scenario !== "still-running",
              items: [
                {
                  item_key: "a",
                  all_postconditions: scenario === "still-running",
                  some_effects: true,
                  evidence: ["one proven effect"],
                },
              ],
            }),
          }
        : {}),
    });
    const result = await f.boundary.apply(request());
    const expected =
      scenario === "lost-present"
        ? "applied"
        : ["partial", "still-running"].includes(scenario)
          ? "partial"
          : "unknown";
    assert.equal(result.items[0].outcome, expected);
    assert.equal(f.readbackCalls, 1);
    assert.equal(f.setterCalls, 1);
    assert.equal(
      Boolean(await f.journal.inspectLock()),
      result.reconciliation_required,
    );
    await f.boundary.apply(request());
    assert.equal(f.setterCalls, 1, "never replay or reverse setters");
  });
test("NATIVE-ALGORITHM DOUBLE: readonly reconciliation inspects retained lock; reviewed recovery finalizes without replay", async (t) => {
  const f = await setup(t, {
    readback: () => {
      throw Error("lost");
    },
  });
  await f.boundary.apply(request());
  const next = fixture(f.journal.directory);
  next.objects.get("a").value = 2;
  const inspection = await next.boundary.reconcile(request());
  assert.equal(inspection.observed.items[0].outcome, "applied");
  assert.equal(inspection.record.lifecycle, "unresolved-needs-reconciliation");
  assert.ok(inspection.lock);
  assert.equal(
    (await next.boundary.apply(request())).reconciliation_required,
    true,
  );
  // TEST/ADMIN ONLY: independently established double is quiescent; remove its exact lock.
  await next.journal.release(inspection.lock);
  const final = await next.boundary.apply(request());
  assert.equal(final.items[0].outcome, "applied");
  assert.equal(final.reconciliation_required, false);
  assert.equal(next.setterCalls, 0);
});
test("OFFLINE: another unresolved journal blocks fresh writes even if its lock was removed", async (t) => {
  const f = await setup(t, {
    setter: () => {
      throw Error("uncertain");
    },
  });
  await f.boundary.apply(request());
  await f.journal.release(await f.journal.inspectLock());
  const next = fixture(f.journal.directory);
  const result = await next.boundary.apply(request("new"));
  assert.equal(result.error.code, "MUTATION_RECONCILIATION_REQUIRED");
  assert.equal(next.setterCalls, 0);
});
test("OFFLINE: race after prepare cannot report rejected when same-key mutation already started", async (t) => {
  let f, competing;
  f = await setup(t, {
    checkpoint: async (p) => {
      if (p === "after-prepared") {
        competing = fixture(f.journal.directory, {
          setter: () => {
            throw Error("lost");
          },
        });
        await competing.boundary.apply(request());
      }
    },
  });
  const result = await f.boundary.apply(request());
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
  assert.equal(f.setterCalls, 0);
  assert.equal(competing.setterCalls, 1);
});
test("OFFLINE: race after prepare returns the competing durable final result", async (t) => {
  let f, prior;
  f = await setup(t, {
    checkpoint: async (p) => {
      if (p === "after-prepared")
        prior = await fixture(f.journal.directory).boundary.apply(request());
    },
  });
  assert.deepEqual(await f.boundary.apply(request()), prior);
  assert.equal(f.setterCalls, 0);
});
test("NATIVE-ALGORITHM DOUBLE: mixed per-item effects remain partial/unknown without rollback", async (t) => {
  const f = await setup(t, {
    setter: (req, objects) => {
      objects.get("a").value = 2;
      throw Error("second setter failed");
    },
  });
  const result = await f.boundary.apply(request("batch", ["a", "b"]));
  assert.deepEqual(
    result.items.map((i) => i.outcome),
    ["applied", "unknown"],
  );
  assert.equal(f.objects.get("a").value, 2);
  assert.equal(f.objects.get("b").value, 1);
  assert.equal(f.setterCalls, 1);
});
test("NATIVE-ALGORITHM DOUBLE: independent readback reuses core/native read evaluation", async (t) => {
  const { fixture: nativeFixture } = await import("./parity-fixture.mjs");
  const { NoFussCore } = await import("../dist/core.js");
  const native = nativeFixture(),
    core = new NoFussCore(native, {}),
    f = await setup(t);
  let reads = 0;
  f.reader.readback = async () => {
    reads++;
    const output = await core.get({ ids: ["inbox.1"], fields: ["name"] });
    return {
      settled: true,
      items: [
        {
          item_key: "a",
          all_postconditions:
            output.results[0].task.name === "independently observed",
          some_effects: false,
          evidence: ["core.get -> native operation on plain doubles"],
        },
      ],
    };
  };
  f.writer.apply = async () => {
    native.inbox[0].name = "independently observed";
    return { name: "untrusted setter response" };
  };
  assert.equal((await f.boundary.apply(request())).items[0].outcome, "applied");
  assert.equal(reads, 1);
});
test("OFFLINE: planner cannot weaken preconditions or pass mutable native objects to writer", async (t) => {
  const f = await setup(t);
  f.planner.validate = (item) => ({
    item_key: item.item_key,
    preconditions: [],
    predicted_changes: item.changes,
    payload: null,
  });
  const r = request();
  r.items[0].preconditions[0].expected = 9;
  assert.equal((await f.boundary.apply(r)).items[0].outcome, "conflict");
  assert.equal(f.setterCalls, 0);
  f.planner.validate = (item, facts) => {
    facts[0].facts.value = 99;
    return {};
  };
  assert.equal(
    (await f.boundary.apply(request("immutable"))).items[0].outcome,
    "rejected",
  );
  assert.equal(f.objects.get("a").value, 1);
});
test("OFFLINE: prepared retries never silently rebase planner-captured preconditions", async (t) => {
  const f = await setup(t);
  f.planner.validate = (item, facts) => ({
    item_key: item.item_key,
    preconditions: [
      { reference: ref(), field: "other", expected: facts[0].facts.other },
    ],
    predicted_changes: item.changes,
    payload: null,
  });
  f.objects.get("a").other = 4;
  const { plan } = await f.boundary.preview(request());
  await f.journal.prepare(request(), plan);
  f.objects.get("a").other = 5;
  const result = await f.boundary.apply(request());
  assert.equal(result.items[0].outcome, "conflict");
  assert.equal(f.setterCalls, 0);
});
test("OFFLINE: accessors, cycles and oversized envelopes are rejected, never silently hash-dropped", () => {
  let accesses = 0;
  const accessor = {
    get value() {
      accesses++;
      return 1;
    },
  };
  assert.throws(() => canonical(accessor));
  assert.equal(accesses, 0);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => normalize(cycle));
  const r = request();
  r.items[0].payload = "x".repeat(65536);
  assert.throws(() => normalize(r));
});
