import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ReadError } from "../dist/contract.js";
export function perspectiveFixture() {
  class Task {
    constructor(id, project = null) {
      this.id = { primaryKey: id };
      this.project = project;
    }
  }
  class Project {
    constructor(id) {
      this.id = { primaryKey: id };
    }
  }
  const inbox = { name: "Inbox" },
    projects = { name: "Projects" },
    custom = {
      identifier: "custom-id",
      name: "Custom Ω",
      added: new Date("2026-01-01T01:02:03.456Z"),
      modified: null,
      archivedFilterRules: [{ action: "due" }],
      archivedTopLevelFilterAggregation: null,
      id: { primaryKey: "custom-id" },
    };
  const Perspective = {
    BuiltIn: { Inbox: inbox, Projects: projects },
    Custom: { byIdentifier: (id) => (id === "custom-id" ? custom : null) },
    all: [inbox, projects, custom],
  };
  const node = (object, children = [], isRevealed = true) => ({
    object,
    children,
    isRevealed,
  });
  const root = node(null, [
    node(new Task("task.one")),
    node(new Task("root", new Project("project.one"))),
    node(new Task("hidden"), [], false),
  ]);
  const document = {
    windows: [{ perspective: custom, content: { rootNode: root } }],
  };
  const app = {
    userVersion: { versionString: "4.9.2" },
    buildVersion: { versionString: "188.3" },
    getTypeScriptDeclarations: () => "",
  };
  const context = vm.createContext({
    Perspective,
    Task,
    Project,
    document,
    app,
    Date,
    console,
  });
  const operation = vm.runInContext(
    "(" +
      readFileSync(
        new URL("../src/native/operation.js", import.meta.url),
        "utf8",
      ) +
      ")",
    context,
  );
  return {
    Perspective,
    custom,
    document,
    root,
    node,
    Task,
    run: async (op, args) => {
      const r = JSON.parse(
        operation({ request_id: "perspective-double", op, args }),
      );
      if (r.error) throw new ReadError(r.error.code, r.error.message);
      return r.result;
    },
    snapshot: () => ({}),
  };
}
