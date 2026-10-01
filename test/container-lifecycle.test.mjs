import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFussCore } from "../dist/core.js";
const source = await readFile(
  new URL("../src/native/container-lifecycle-operation.js", import.meta.url),
  "utf8",
);
async function setup(
  t,
  scopes = [
    "project.delete",
    "folder.delete",
    "tag.delete",
    "project.reorder",
    "folder.reorder",
    "tag.reorder",
  ],
) {
  const records = {
      project: new Map(),
      folder: new Map(),
      tag: new Map(),
      task: new Map(),
    },
    library = [],
    tags = [],
    events = [];
  const id = (o) => o?.id.primaryKey ?? null;
  class Task {
    static byIdentifier = (k) => records.task.get(k) ?? null;
    constructor(k, p = null) {
      Object.assign(this, {
        id: { primaryKey: k },
        project: null,
        containingProject: p,
        parent: null,
        name: k,
        noteText: { string: "" },
        flagged: false,
        tags: [],
        dueDate: null,
        deferDate: null,
        plannedDate: null,
        completed: false,
        completionDate: null,
        dropDate: null,
        repetitionRule: null,
        attachments: [],
        notifications: [],
        completedByChildren: false,
        assignedContainer: null,
        tasks: [],
        active: true,
        effectiveActive: true,
      });
      records.task.set(k, this);
    }
  }
  class Folder {
    static byIdentifier = (k) => records.folder.get(k) ?? null;
    constructor(k, parent = null) {
      Object.assign(this, {
        id: { primaryKey: k },
        name: k,
        parent,
        status: "Active",
        active: true,
        effectiveActive: true,
        sections: [],
      });
      records.folder.set(k, this);
      (parent?.sections ?? library).push(this);
    }
    get before() {
      return { peer: this, after: false };
    }
    get after() {
      return { peer: this, after: true };
    }
  }
  class Project {
    static byIdentifier = (k) => records.project.get(k) ?? null;
    constructor(k, f = null) {
      Object.assign(this, {
        id: { primaryKey: k },
        name: k,
        parentFolder: f,
        status: "Active",
        containsSingletonActions: false,
        sequential: false,
        defaultSingletonActionHolder: false,
        flattenedTasks: [],
      });
      this.task = new Task("root-" + k, this);
      this.task.project = this;
      records.project.set(k, this);
      (f?.sections ?? library).push(this);
    }
    get before() {
      return { peer: this, after: false };
    }
    get after() {
      return { peer: this, after: true };
    }
  }
  class Tag {
    static byIdentifier = (k) => records.tag.get(k) ?? null;
    static forecastTag = null;
    constructor(k, parent = null) {
      Object.assign(this, {
        id: { primaryKey: k },
        name: k,
        parent,
        status: "Active",
        active: true,
        effectiveActive: true,
        tags: [],
        tasks: [],
        childrenAreMutuallyExclusive: false,
      });
      records.tag.set(k, this);
      (parent?.tags ?? tags).push(this);
    }
    get before() {
      return { peer: this, after: false };
    }
    get after() {
      return { peer: this, after: true };
    }
  }
  const f = new Folder("folder"),
    sub = new Folder("sub", f),
    p = new Project("project", sub),
    peer = new Project("peer", f),
    task = new Task("task", p);
  p.flattenedTasks.push(task);
  p.task.tasks.push(task);
  task.parent = p.task;
  const tag = new Tag("tag"),
    child = new Tag("child", tag),
    spare = new Tag("spare", tag);
  task.tags = [tag, child];
  tag.tasks = [task];
  child.tasks = [task, peer.task];
  peer.task.tags = [child];
  const siblings = (o) =>
    o instanceof Tag
      ? (o.parent?.tags ?? tags)
      : o instanceof Project
        ? (o.parentFolder?.sections ?? library)
        : (o.parent?.sections ?? library);
  function del(o) {
    if (o instanceof Folder) {
      [...o.sections].forEach(del);
    } else if (o instanceof Project) {
      records.task.delete(id(o.task));
      o.flattenedTasks.forEach((t) => records.task.delete(id(t)));
    } else if (o instanceof Tag) {
      [...o.tags].forEach(del);
      for (const t of records.task.values())
        t.tags = t.tags.filter((x) => x !== o);
    }
    const list = siblings(o);
    list.splice(list.indexOf(o), 1);
    records[
      o instanceof Folder ? "folder" : o instanceof Project ? "project" : "tag"
    ].delete(id(o));
  }
  const move = (values, pos) => {
    for (const o of values) {
      const list = siblings(o);
      list.splice(list.indexOf(o), 1);
      list.splice(list.indexOf(pos.peer) + (pos.after ? 1 : 0), 0, o);
    }
    events.push("move");
  };
  const native = {
    run: async (op, args) => {
      if (op === "get") {
        return {
          read_at: null,
          results: args.ids.map((k) => {
            const o = records[args.entity].get(k);
            return o
              ? {
                  id: k,
                  status: "ok",
                  [args.entity]: {
                    id: k,
                    name: o.name,
                    ...(["project", "task"].includes(args.entity)
                      ? { tag_ids: (o.task?.tags ?? o.tags ?? []).map(id) }
                      : {}),
                    ...(args.entity === "project"
                      ? { folder_id: id(o.parentFolder) }
                      : { parent_id: id(o.parent) }),
                  },
                }
              : {
                  id: k,
                  status: "error",
                  error: { code: "NOT_FOUND", message: "missing" },
                };
          }),
        };
      }
      const r = JSON.parse(
        vm.runInNewContext(
          "(" +
            source +
            ")(" +
            JSON.stringify({ op, args, request_id: "test" }) +
            ")",
          {
            Project,
            Folder,
            Tag,
            Task,
            library,
            tags,
            moveSections: move,
            moveTags: move,
            deleteObject: (o) => {
              events.push("delete");
              del(o);
            },
          },
        ),
      );
      if (r.error) throw Object.assign(Error(r.error.message), r.error);
      return r.result;
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "nfo-containers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policy = {
    schema_version: 1,
    scopes,
    folder_ids: ["folder", "sub"],
    project_ids: ["project", "peer"],
    tag_ids: ["tag", "child", "spare"],
  };
  await writeFile(
    join(dir, "mutation-authorization.json"),
    JSON.stringify(policy),
    { mode: 0o600 },
  );
  return {
    core: new NoFussCore(native, {}, dir),
    native,
    records,
    events,
    f,
    sub,
    p,
    peer,
    task,
    tag,
    child,
    spare,
    policy,
    dir,
  };
}
const deletion = (entity, k) => ({
  entity,
  [entity + "_id"]: k,
  cascade: true,
  apply: true,
  request_key: "delete-" + k,
});
test("NATIVE-CONTAINER DOUBLE: project and folder cascades independently prove every exact task/root absence, including empty parent order", async (t) => {
  for (const [entity, k] of [
    ["project", "project"],
    ["folder", "folder"],
  ]) {
    const f = await setup(t);
    const r = await f.core.mutate(entity + ".delete", deletion(entity, k));
    assert.equal(r.items[0].outcome, "applied");
    assert.equal(f.records.task.has("root-project"), false);
    assert.equal(f.records.task.has("task"), false);
    const n = f.events.length;
    assert.deepEqual(
      await f.core.mutate(entity + ".delete", deletion(entity, k)),
      r,
    );
    assert.equal(f.events.length, n);
  }
});
test("NATIVE-CONTAINER DOUBLE: tag cascade removes only exact associations and resolves distinct project/root identities", async (t) => {
  const f = await setup(t);
  const r = await f.core.mutate("tag.delete", deletion("tag", "tag"));
  assert.equal(r.items[0].outcome, "applied");
  assert.equal(f.records.tag.size, 0);
  assert.equal(f.records.task.size, 3);
  assert.deepEqual(f.task.tags, []);
  assert.deepEqual(f.peer.task.tags, []);
});
test("NATIVE-CONTAINER DOUBLE: mixed section/tag reorder preserves identity and rejects stale or wrong parent before setters", async (t) => {
  for (const input of [
    {
      entity: "project",
      project_id: "peer",
      folder_id: "folder",
      peer: { entity: "folder", id: "sub" },
      position: "before",
    },
    {
      entity: "folder",
      folder_id: "sub",
      parent_id: "folder",
      peer: { entity: "project", id: "peer" },
      position: "after",
    },
    {
      entity: "tag",
      tag_id: "spare",
      parent_id: "tag",
      peer: { entity: "tag", id: "child" },
      position: "before",
    },
  ]) {
    const f = await setup(t);
    const args = { ...input, apply: true, request_key: "reorder" };
    assert.equal(
      (await f.core.mutate(input.entity + ".reorder", args)).items[0].outcome,
      "applied",
    );
    const stale = await setup(t);
    const preview = await stale.core.mutate(input.entity + ".reorder", {
      ...args,
      apply: false,
    });
    (input.entity === "tag" ? stale.tag.tags : stale.f.sections).reverse();
    const r = await stale.core.mutate(input.entity + ".reorder", {
      ...preview.apply_input,
      apply: true,
    });
    assert.notEqual(r.items?.[0]?.outcome, "applied");
    assert.equal(stale.events.length, 0);
  }
});
test("NATIVE-CONTAINER DOUBLE: missing descendant/association authorization and native forecast/default holders fail closed", async (t) => {
  for (const kind of ["descendant", "association", "default", "attachment"]) {
    const f = await setup(t);
    if (kind === "descendant") {
      f.policy.folder_ids = ["folder"];
      await writeFile(
        join(f.dir, "mutation-authorization.json"),
        JSON.stringify(f.policy),
      );
    }
    if (kind === "association") {
      f.policy.project_ids = ["project"];
      await writeFile(
        join(f.dir, "mutation-authorization.json"),
        JSON.stringify(f.policy),
      );
    }
    if (kind === "default") f.p.defaultSingletonActionHolder = true;
    if (kind === "attachment") f.task.attachments = [{}];
    const entity = kind === "association" ? "tag" : "folder",
      r = await f.core.mutate(entity + ".delete", deletion(entity, entity));
    assert.notEqual(r.items?.[0]?.outcome, "applied");
    assert.equal(f.events.length, 0);
  }
});

test("REVIEW REGRESSION: failed container setter with unchanged independent order remains unknown", async (t) => {
  const f = await setup(t);
  const run = f.native.run;
  f.native.run = async (op, args) => {
    if (op !== "container_lifecycle_apply") return run(op, args);
    // Use the real native script, but make its before-location getter fail after setter_count increments.
    Object.defineProperty(f.sub, "before", {
      get() {
        throw Error("before effect");
      },
    });
    return run(op, args);
  };
  const input = {
    entity: "project",
    project_id: "peer",
    folder_id: "folder",
    peer: { entity: "folder", id: "sub" },
    position: "before",
    apply: true,
    request_key: "failed-order",
  };
  const result = await f.core.mutate("project.reorder", input);
  assert.equal(result.items[0].outcome, "unknown");
  assert.equal(result.reconciliation_required, true);
  assert.equal(f.events.length, 0);
});
