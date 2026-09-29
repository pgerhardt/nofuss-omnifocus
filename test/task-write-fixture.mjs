import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ReadError } from "../dist/contract.js";
export function taskFixture() {
  const events = [],
    tasks = [],
    tags = [],
    projects = [];
  let count = 0;
  const statuses = Object.fromEntries(
    [
      "Available",
      "Next",
      "DueSoon",
      "Overdue",
      "Blocked",
      "Completed",
      "Dropped",
    ].map((x) => [x, x]),
  );
  class Task {
    constructor(name, position) {
      this.id = { primaryKey: "new-" + ++count };
      this._name = name;
      this.noteText = { string: "" };
      this._flagged = false;
      this.parent = position?.task ?? null;
      this.containingProject = position ?? null;
      this.project = null;
      this.tags = [];
      this.tasks = [];
      this.completed = false;
      this.completionDate = null;
      this.repetitionRule = null;
      this.dueDate = null;
      this.deferDate = null;
      this.added = new Date("2026-01-01T00:00:00Z");
      this.estimatedMinutes = null;
      this.sequential = false;
      this.completedByChildren = false;
      this.shouldUseFloatingTimeZone = false;
      this.notifications = [];
      this.active = true;
      tasks.push(this);
      if (position) position.tasks.push(this);
      events.push("create");
    }
    get name() {
      return this._name;
    }
    set name(value) {
      events.push("name");
      this._name = value;
    }
    get note() {
      return this.noteText.string;
    }
    set note(value) {
      events.push("note");
      this.noteText = { string: value };
    }
    get flagged() {
      return this._flagged;
    }
    set flagged(value) {
      events.push("flagged");
      this._flagged = value;
    }
    get hasChildren() {
      return !!this.tasks.length;
    }
    get taskStatus() {
      return this.completed ? statuses.Completed : statuses.Available;
    }
    get effectiveCompletionDate() {
      return this.completionDate;
    }
    get effectiveDropDate() {
      return null;
    }
    clearTags() {
      events.push("clearTags");
      this.tags = [];
    }
    addTags(value) {
      events.push("addTags");
      this.tags.push(...value);
    }
    markComplete() {
      events.push("complete");
      if (this.repetitionRule) throw Error("repeating setter forbidden");
      this.completed = true;
      this.completionDate = new Date();
      return this;
    }
    static byIdentifier(id) {
      return tasks.find((t) => t.id.primaryKey === id) ?? null;
    }
  }
  Task.Status = statuses;
  const root = new Task("Project root", null);
  root.id.primaryKey = "root";
  const project = {
    id: { primaryKey: "project" },
    task: root,
    tasks: [],
    status: "Active",
    completedByChildren: false,
  };
  root.project = project;
  root.containingProject = project;
  projects.push(project);
  const task = new Task("baseline", project);
  task.id.primaryKey = "task";
  tags.push(
    {
      id: { primaryKey: "tag-a" },
      parent: null,
      childrenAreMutuallyExclusive: false,
    },
    {
      id: { primaryKey: "tag-b" },
      parent: null,
      childrenAreMutuallyExclusive: false,
    },
  );
  const context = vm.createContext({
    Task,
    Project: {
      Status: { Active: "Active" },
      byIdentifier: (id) =>
        projects.find((p) => p.id.primaryKey === id) ?? null,
    },
    Tag: {
      byIdentifier: (id) => tags.find((t) => t.id.primaryKey === id) ?? null,
    },
    Date,
    console,
  });
  const native = vm.runInContext(
    "(" +
      readFileSync(
        new URL("../src/native/task-operation.js", import.meta.url),
        "utf8",
      ) +
      ")",
    context,
  );
  const read = vm.runInContext(
    "(" +
      readFileSync(
        new URL("../src/native/operation.js", import.meta.url),
        "utf8",
      ) +
      ")",
    context,
  );
  events.length = 0;
  const fixture = {
    events,
    tasks,
    tags,
    project,
    task,
    beforeApply: null,
    loseResponse: false,
    readbackFails: false,
    readCalls: 0,
    run: async (op, args) => {
      if (op === "task_write_apply") fixture.beforeApply?.();
      if (op === "get") {
        fixture.readCalls++;
        if (fixture.readbackFails) throw Error("readback unavailable");
      }
      const result = JSON.parse(
        (op.startsWith("task_write_") ? native : read)({
          request_id: "double",
          op,
          args,
        }),
      );
      if (op === "task_write_apply" && fixture.loseResponse)
        throw Error("lost reply after native effect");
      if (result.error)
        throw new ReadError(result.error.code, result.error.message);
      return result.result;
    },
    snapshot: () => ({}),
  };
  return fixture;
}
