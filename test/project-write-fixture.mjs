import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(
  new URL("../src/native/project-operation.js", import.meta.url),
  "utf8",
);
export function fixture() {
  const projects = new Map(),
    folders = new Map(),
    tags = new Map();
  let serial = 0;
  const counters = { setters: 0 };
  const status = Object.fromEntries(
    ["Active", "OnHold", "Done", "Dropped"].map((k) => [k, { k }]),
  );
  const identifier = (value) => ({ primaryKey: value });
  const root = () => ({ added: new Date("2020-01-01Z"), notifications: [] });
  class Project {
    static Status = status;
    static byIdentifier = (id) => projects.get(id) ?? null;
    constructor(name, folder = null) {
      this.id = identifier("new-" + ++serial);
      this.task = { ...root(), id: this.id };
      this.parentFolder = folder;
      this.name = name;
      this.note = "";
      this.flagged = false;
      this.tags = [];
      this.status = status.Active;
      this.containsSingletonActions = false;
      this.sequential = false;
      this.dueDate = null;
      this.deferDate = null;
      this.plannedDate = null;
      this.completionDate = null;
      this.dropDate = null;
      this.repetitionRule = null;
      this.shouldUseFloatingTimeZone = true;
      this.estimatedMinutes = null;
      this.completedByChildren = false;
      this.defaultSingletonActionHolder = false;
      this.lastReviewDate = null;
      this.nextReviewDate = null;
      this.flattenedTasks = [];
      projects.set(this.id.primaryKey, this);
      counters.setters++;
    }
    markComplete() {
      this.status = status.Done;
      this.completionDate = new Date();
      counters.setters++;
    }
    clearTags() {
      this.tags = [];
    }
    addTags(values) {
      this.tags.push(...values);
    }
  }
  class Folder {
    static byIdentifier = (id) => folders.get(id) ?? null;
    constructor(id) {
      this.id = identifier(id);
      this.parent = null;
      this.effectiveActive = true;
      this.sections = [];
      this.ending = { folder: this };
      folders.set(id, this);
    }
  }
  class Tag {
    static byIdentifier = (id) => tags.get(id) ?? null;
    constructor(id) {
      this.id = identifier(id);
      this.parent = null;
      tags.set(id, this);
    }
  }
  const library = { ending: { folder: null } };
  const nativeContext = () => ({
    Project,
    Folder,
    Tag,
    library,
    inbox: [],
    flattenedProjects: [...projects.values()],
    app: { getTypeScriptDeclarations: () => "plannedDate: Date | null;" },
    moveSections: (values, position) => {
      counters.setters++;
      values.forEach((p) => (p.parentFolder = position.folder));
    },
  });
  function run(op, args) {
    const context = nativeContext();
    const result = JSON.parse(
      vm.runInNewContext(
        "(" +
          source +
          ")(" +
          JSON.stringify({ request_id: "x", op, args }) +
          ")",
        context,
      ),
    );
    if (result.error)
      throw Object.assign(Error(result.error.message), result.error);
    return result.result;
  }
  const native = { run: async (op, args) => run(op, args) };
  const core = {
    get: async ({ ids }) => ({
      results: ids.map((id) => {
        const f = run("project_write_facts", {
          reference: { entity: "project", id },
        }).facts;
        return f ? { project: f } : { id, error: { code: "NOT_FOUND" } };
      }),
    }),
  };
  return {
    native,
    core,
    projects,
    folders,
    tags,
    counters,
    Project,
    Folder,
    Tag,
    nativeContext,
  };
}
