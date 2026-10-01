import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ReadError } from "../dist/contract.js";
import { NativeWorker } from "../dist/worker.js";
export const stamp = "2026-10-01T00:00:00.000Z";
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [stamp]));
  }
}
const ref = (id) => ({ id: { primaryKey: id } });
export function discoveryFixture() {
  const Status = Object.fromEntries(
    [
      "Available",
      "Next",
      "DueSoon",
      "Overdue",
      "Blocked",
      "Completed",
      "Dropped",
    ].map((s) => [s, s]),
  );
  const node = (id, status = "active") => ({
    ...ref(id),
    name: id,
    added: new Date(stamp),
    modified: null,
    parent: null,
    status,
    active: status !== "dropped",
    effectiveActive: status !== "dropped",
    tags: [],
    folders: [],
    projects: [],
  });
  const tags = [
    node("tag.root"),
    node("tag.child", "on_hold"),
    node("tag.leaf", "dropped"),
  ];
  tags[1].parent = tags[0];
  tags[0].tags = [tags[1]];
  tags[2].parent = tags[1];
  tags[1].tags = [tags[2]];
  const folders = [
    node("folder.root", "dropped"),
    node("folder.child"),
    node("folder.leaf"),
  ];
  folders[1].parent = folders[0];
  folders[0].folders = [folders[1]];
  folders[2].parent = folders[1];
  folders[1].folders = [folders[2]];
  folders[1].effectiveActive = folders[2].effectiveActive = false;
  const task = (id, status) => ({
    ...ref(id),
    name: id,
    project: null,
    parent: null,
    containingProject: null,
    tasks: [],
    inInbox: true,
    added: new Date(stamp),
    active: status !== "Dropped",
    completed: status === "Completed",
    taskStatus: status,
    flagged: false,
    tags: [],
    dueDate: null,
    deferDate: null,
    plannedDate: null,
    effectiveDueDate: null,
    effectiveDeferDate: null,
    estimatedMinutes: null,
  });
  const tasks = Object.values(Status).map((s, i) => task("task." + i, s));
  Object.assign(tasks[0], {
    flagged: true,
    tags: [tags[2]],
    estimatedMinutes: 0,
  });
  Object.assign(tasks[1], {
    estimatedMinutes: 30,
    dueDate: new Date(stamp),
    deferDate: new Date(stamp),
    plannedDate: new Date(stamp),
    effectiveDueDate: new Date(stamp),
    effectiveDeferDate: new Date(stamp),
  });
  Object.assign(tasks[2], {
    dueDate: new Date("2026-10-02T00:00:00Z"),
    estimatedMinutes: 60,
  });
  const project = {
    ...node("project"),
    tasks: [tasks[0]],
    get flattenedTasks() {
      const found = [];
      function walk(nodes) {
        for (const n of nodes) {
          found.push(n);
          walk(n.tasks);
        }
      }
      walk(this.tasks);
      return found;
    },
    task: task("project", "Available"),
  };
  project.task.project = project;
  tasks[0].parent = project.task;
  tasks[0].containingProject = project;
  tasks[0].inInbox = false;
  folders[2].projects = [project];
  const context = {
    Date: Clock,
    Task: {
      Status,
      byIdentifier: (id) =>
        [...tasks, project.task].find((t) => t.id.primaryKey === id) ?? null,
    },
    Project: {
      Status: {
        Active: "active",
        OnHold: "on_hold",
        Done: "done",
        Dropped: "dropped",
      },
      byIdentifier: (id) => (id === "project" ? project : null),
    },
    Tag: {
      Status: { Active: "active", OnHold: "on_hold", Dropped: "dropped" },
      byIdentifier: (id) => tags.find((t) => t.id.primaryKey === id) ?? null,
    },
    Folder: Object.assign(class Folder {}, {
      Status: { Active: "active", Dropped: "dropped" },
      byIdentifier: (id) => folders.find((t) => t.id.primaryKey === id) ?? null,
    }),
    get flattenedTasks() {
      return [project.task, ...tasks];
    },
    library: [project],
    flattenedProjects: [project],
    flattenedTags: tags,
    flattenedFolders: folders,
    get inbox() {
      return tasks.filter((t) => t.inInbox && t.parent === null);
    },
    app: {
      getTypeScriptDeclarations: () =>
        "declare class Task {\n plannedDate: Date | null;\n}\n",
    },
  };
  const op = vm.runInNewContext(
    "(" +
      readFileSync(
        new URL("../src/native/operation.js", import.meta.url),
        "utf8",
      ) +
      ")",
    context,
  );
  return {
    tasks,
    tags,
    folders,
    project,
    context,
    run: async (operation, args) => {
      const frame = JSON.parse(
        op({ request_id: "discovery", op: operation, args }),
      );
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => new NativeWorker().snapshot(),
  };
}
