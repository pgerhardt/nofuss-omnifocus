import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ReadService } from "../dist/service.js";
import { NativeWorker } from "../dist/worker.js";
import { StatusOutput, ReadError } from "../dist/contract.js";
const source = readFileSync(
  new URL("../src/native/operation.js", import.meta.url),
  "utf8",
);
// Deliberately small declaration double, not a native API archive or behavior proof.
const declarations = `declare namespace Task {
    function byIdentifier(identifier: string): Task | null;
}
declare namespace Project {
    function byIdentifier(identifier: string): Project | null;
    class ReviewInterval {
        steps: number;
        unit: string;
    }
}
declare namespace Tag {
    function byIdentifier(identifier: string): Tag | null;
}
declare class ActiveObject {
    readonly effectiveActive: boolean;
}
declare class Task extends ActiveObject {
    readonly taskStatus: Task.Status;
    readonly effectiveCompletionDate: Date | null;
    readonly tags: TagArray;
    readonly notifications: Array<Task.Notification>;
    plannedDate: Date | null;
}
declare class Project {
    readonly tasks: TaskArray;
    readonly flattenedTasks: TaskArray;
    // numberOfTasks: number;
    /* numberOfCompletedTasks: number; */
}`;
function reader(extra = {}) {
  const app = {
    userVersion: { versionString: "4.9.2" },
    buildVersion: { versionString: "188.3" },
    getTypeScriptDeclarations: () => declarations,
    ...extra,
  };
  const op = vm.runInNewContext("(" + source + ")", {
    app,
    get flattenedProjects() {
      throw Error("status must not read private projects");
    },
    get inbox() {
      throw Error("status must not read private tasks");
    },
    Task: { byIdentifier: () => null },
  });
  return {
    app,
    snapshot: () => new NativeWorker().snapshot(),
    run: async (opName, args) => {
      const frame = JSON.parse(
        op({ request_id: "status-test", op: opName, args }),
      );
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
  };
}
const build = {
  name: "NoFuss for OmniFocus",
  version: "test",
  source_revision: null,
  dirty: true,
  source_sha256: "test",
};
const getStatus = async (r) =>
  StatusOutput.parse(
    (await new ReadService(r, build).status()).structuredContent,
  );
test("status reports narrow declarations separately from build-bound behavioral evidence", async () => {
  const r = reader();
  const status = await getStatus(r);
  assert.equal(status.native.connected, true);
  assert.equal(status.native.api_introspection, true);
  assert.equal(status.native.api_support.state, "observed");
  for (const [key, value] of Object.entries(status.native.api_support.members))
    assert.equal(
      value,
      ["review_interval_fixed", "project_direct_counts"].includes(key)
        ? "not_declared"
        : "declared",
      key,
    );
  assert.equal(status.verification.matches_running_build, true);
  assert.ok(
    status.verification.gaps.includes(
      "notifications_rare_states_not_live_verified",
    ),
  );
  assert.ok(
    status.verification.verified_reads.includes(
      "notifications_normalized_core_cli_mcp_and_continuation",
    ),
  );
  assert.match(
    status.verification.exceptions.notification_relative_offsets,
    /raw seconds divided by 60 without version gating/,
  );
  assert.equal(status.capabilities.sync_completion, false);
  assert.equal(status.capabilities.writes, false);
  assert.equal(status.capabilities.locations, false);
  assert.equal(status.sync.state, "unavailable");
  // Metadata is freshly observed. An upgrade never inherits a successful match.
  r.app.buildVersion.versionString = "new-build";
  r.app.getTypeScriptDeclarations = () => "unrecognized declaration syntax";
  const changed = await getStatus(r);
  assert.equal(changed.verification.matches_running_build, false);
  assert.ok(
    Object.values(changed.native.api_support.members).every(
      (v) => v === "unknown",
    ),
  );
  assert.ok(JSON.stringify(status).length < 5000);
  r.app.getTypeScriptDeclarations = () =>
    declarations.replace("Task extends ActiveObject", "Task extends OtherBase");
  assert.equal(
    (await getStatus(r)).native.api_support.members.task_state,
    "unknown",
  );
});
test("absent, empty and failed introspection keep connectivity and unknown support truthful", async () => {
  for (const [value, code] of [
    [undefined, "INTROSPECTION_UNAVAILABLE"],
    [() => "", "INTROSPECTION_UNAVAILABLE"],
    [
      () => {
        throw Object.assign(Error("private declaration failure"), {
          code: "PRIVATE",
        });
      },
      "INTROSPECTION_FAILED",
    ],
  ]) {
    const status = await getStatus(
      reader({ getTypeScriptDeclarations: value }),
    );
    assert.equal(status.native.connected, true);
    assert.equal(status.native.api_introspection, typeof value === "function");
    assert.equal(status.native.api_support.error.code, code);
    assert.equal(status.native.api_support.state, "unavailable");
    assert.ok(
      Object.values(status.native.api_support.members).every(
        (v) => v === "unknown",
      ),
    );
    assert.equal(status.capabilities.exact_task_ids, true);
    assert.ok(!JSON.stringify(status).includes("private declaration failure"));
  }
});
test("native failure makes readiness/build/support unknown without leaking errors or cached success", async () => {
  const r = reader();
  await getStatus(r);
  r.run = async () => {
    throw new ReadError("NOT_RUNNING", "OmniFocus must already be running.");
  };
  const status = await getStatus(r);
  assert.equal(status.native.connected, false);
  assert.equal(status.native.error.code, "NOT_RUNNING");
  assert.equal(status.native.api_introspection, null);
  assert.equal(status.native.build, null);
  assert.equal(status.verification.matches_running_build, null);
  assert.ok(
    Object.values(status.native.api_support.members).every(
      (v) => v === "unknown",
    ),
  );
  r.run = async () => {
    throw Error("private native failure");
  };
  assert.ok(
    !JSON.stringify(await getStatus(r)).includes("private native failure"),
  );
});
test("ordinary gets do not export declarations or require introspection", async () => {
  let reads = 0;
  const r = reader({
    getTypeScriptDeclarations: () => {
      reads++;
      return declarations;
    },
  });
  const result = await r.run("get", {
    entity: "task",
    ids: ["absent"],
    fields: [],
  });
  assert.equal(result.results[0].status, "not_found");
  assert.equal(reads, 0);
  await getStatus(r);
  assert.equal(reads, 1);
});

test("REVIEW REGRESSION: status reports typed perspective rule writes only for applicable host authority", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { NoFussCore } = await import("../dist/core.js");
  const dir = await mkdtemp(join(tmpdir(), "nfo-review-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const core = new NoFussCore(reader(), build, dir);
  assert.equal(
    (await core.status()).capabilities.perspective_rule_writes,
    false,
  );
  for (const policy of [
    {
      scopes: ["perspective.update"],
      perspective_ids: ["exact-custom"],
      expected: true,
    },
    {
      scopes: ["perspective.create"],
      allow_perspective_creation: true,
      expected: true,
    },
    { scopes: ["project.update"], project_ids: ["project"], expected: false },
  ]) {
    const { expected, ...authorization } = policy;
    await writeFile(
      join(dir, "mutation-authorization.json"),
      JSON.stringify({ schema_version: 1, project_ids: [], ...authorization }),
      { mode: 0o600 },
    );
    const status = await core.status();
    assert.equal(status.capabilities.writes, true);
    assert.equal(status.capabilities.perspective_rule_writes, expected);
  }
});
