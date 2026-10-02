import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sync } from "../dist/sync.js";
import { Locations } from "../dist/locations.js";
import { inputHash } from "../dist/mutation-contract.js";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "nfo-local-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({
      schema_version: 1,
      scopes: ["sync.trigger", "tag.set_location"],
      project_ids: [],
      allow_sync: true,
      tag_ids: ["tag"],
    }),
    { mode: 0o600 },
  );
  return dir;
}
const status = () => ({
  document_id: "doc",
  syncing: false,
  last_sync_date: null,
  last_sync_error: null,
  unavailable: [],
  observed_at: new Date().toISOString(),
  sync_completion: "unavailable",
  last_attempted_sync: "unavailable",
  last_successful_sync: "unavailable",
  pending_local_changes: "unavailable",
  remote_acknowledgement: "unavailable",
});
test("sync accepted trigger is durable, independent status is local only; strict inputs and wrong document reject", async (t) => {
  const dir = await setup(t);
  let calls = [];
  const native = {
    run: async (op, args) => {
      calls.push(op);
      if (op === "sync_facts") return status();
      return {
        request_key: args.request.request_key,
        input_hash: inputHash(args.request),
        finished: true,
        setter_count: 1,
        document_id: "doc",
        accepted: true,
        error: null,
      };
    },
  };
  const sync = new Sync(native, dir),
    args = {
      entity: "sync",
      document_id: "doc",
      apply: true,
      request_key: "one",
    };
  const r = await sync.trigger(args);
  assert.equal(r.items[0].outcome, "applied");
  assert.ok(
    calls.indexOf("sync_facts", calls.indexOf("sync_apply")) >
      calls.indexOf("sync_apply"),
  );
  const before = calls.length;
  assert.deepEqual(await sync.trigger(args), r);
  assert.equal(calls.length, before);
  assert.equal((await sync.read({})).sync_completion, "unavailable");
  await assert.rejects(() => sync.read({ script: "x" }));
  assert.equal(
    (
      await sync.trigger({
        ...args,
        document_id: "other",
        request_key: "wrong",
      })
    ).items[0].outcome,
    "rejected",
  );
});
test("sync lost receipt stays unknown and never blind replays", async (t) => {
  const dir = await setup(t);
  let dispatches = 0;
  const sync = new Sync(
      {
        run: async (op) => {
          if (op === "sync_facts") return status();
          dispatches++;
          throw Error("lost receipt");
        },
      },
      dir,
    ),
    args = {
      entity: "sync",
      document_id: "doc",
      apply: true,
      request_key: "lost",
    };
  assert.equal((await sync.trigger(args)).items[0].outcome, "unknown");
  assert.equal((await sync.trigger(args)).items[0].outcome, "unknown");
  assert.equal(dispatches, 1);
});
test("location arrival/departure/clear retains native float radius and unset trigger marker; stale native preconditions reject", async (t) => {
  const dir = await setup(t);
  let snap = { id: "tag", exists: true, location: null, native_unset: null },
    dispatches = 0;
  const native = {
    run: async (op, a) => {
      if (op === "location_facts")
        return { reference: a.reference, facts: structuredClone(snap) };
      dispatches++;
      snap = {
        ...snap,
        location: a.request.items[0].changes.location,
        native_unset:
          a.request.items[0].changes.location === null ? "arrival" : null,
      };
      return {
        request_key: a.request.request_key,
        input_hash: inputHash(a.request),
        finished: true,
        setter_count: 1,
        resource_id: "tag",
        error: null,
      };
    },
  };
  const loc = new Locations(native, dir);
  for (const [n, location] of [
    {
      name: "x",
      latitude: 0,
      longitude: 0,
      radius_km: 0.2,
      trigger: "arrival",
    },
    {
      name: "x",
      latitude: 0,
      longitude: 0,
      radius_km: 0.1,
      trigger: "departure",
    },
    null,
  ].entries()) {
    const a = {
      entity: "tag",
      tag_id: "tag",
      location,
      apply: true,
      request_key: "loc" + n,
    };
    const r = await loc.write(a);
    assert.equal(r.items[0].outcome, "applied", JSON.stringify(r));
    assert.deepEqual(
      (await loc.read({ tag_id: "tag" })).location,
      location
        ? { ...location, radius_km: Math.fround(location.radius_km) }
        : null,
    );
    assert.deepEqual(await loc.write(a), r);
  }
  const p = await loc.write({ entity: "tag", tag_id: "tag", location: null });
  snap.native_unset = "departure";
  const count = dispatches;
  assert.equal(
    (await loc.write({ ...p.apply_input, apply: true, request_key: "stale" }))
      .items[0].outcome,
    "conflict",
  );
  assert.equal(dispatches, count);
});
test("location invalid coordinates/radii/both/raw fields reject before native mutation; authorization revocation fails closed", async (t) => {
  const dir = await setup(t);
  let calls = 0;
  const loc = new Locations(
    {
      run: async () => {
        calls++;
        return {
          reference: { entity: "tag", id: "tag" },
          facts: {
            id: "tag",
            exists: true,
            location: null,
            native_unset: null,
          },
        };
      },
    },
    dir,
  );
  for (const location of [
    { name: "x", latitude: 91, longitude: 0, radius_km: 1, trigger: "arrival" },
    { name: "x", latitude: 0, longitude: 0, radius_km: 0, trigger: "arrival" },
    { name: "x", latitude: 0, longitude: 0, radius_km: 1, trigger: "both" },
    {
      name: "x",
      latitude: 0,
      longitude: 0,
      radius_km: 1,
      trigger: "arrival",
      raw: {},
    },
  ])
    await assert.rejects(
      () => loc.write({ entity: "tag", tag_id: "tag", location }),
      /Invalid/,
    );
  assert.equal(calls, 0);
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify({ schema_version: 1, scopes: [], project_ids: [] }),
    { mode: 0o600 },
  );
  const denied = await loc.write({
    entity: "tag",
    tag_id: "tag",
    location: null,
    apply: true,
    request_key: "deny",
  });
  assert.equal(denied.items[0].outcome, "rejected");
  assert.equal(denied.error.code, "WRITE_NOT_AUTHORIZED");
});
