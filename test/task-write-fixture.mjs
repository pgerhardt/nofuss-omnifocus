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
      this.parent =
        position instanceof Task ? position : (position?.task ?? null);
      this.containingProject =
        position instanceof Task
          ? position.containingProject
          : (position ?? null);
      this.assignedContainer = null;
      this.project = null;
      this.tags = [];
      this.tasks = [];
      this.completed = false;
      this.completionDate = null;
      this.repetitionRule = null;
      this.dueDate = null;
      this.deferDate = null;
      this.plannedDate = null;
      this.added = new Date("2026-01-01T00:00:00Z");
      this.estimatedMinutes = null;
      this.sequential = false;
      this.completedByChildren = false;
      this.shouldUseFloatingTimeZone = false;
      this.notifications = [];
      this.attachments = [];
      this.dropDate = null;
      this.active = true;
      tasks.push(this);
      if (position) position.tasks.push(this);
      events.push("create");
    }
    get ending() {
      return { owner: this };
    }
    get inInbox() {
      return this.parent === null && this.containingProject === null;
    }
    get effectivePlannedDate() {
      return this.plannedDate ?? this.parent?.effectivePlannedDate ?? null;
    }
    get effectiveActive() {
      return (
        this.active &&
        (!this.containingProject || this.containingProject.status === "Active")
      );
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
      return this.dropDate;
    }
    get effectiveDueDate() {
      return this.dueDate ?? this.parent?.effectiveDueDate ?? null;
    }
    get effectiveDeferDate() {
      return this.deferDate ?? this.parent?.effectiveDeferDate ?? null;
    }
    addNotification(value) {
      events.push("addNotification");
      const absolute = value instanceof Date;
      const fire = absolute
        ? value
        : new Date(this.effectiveDueDate.getTime() + value * 1000);
      const n = {
        id: { primaryKey: "alarm-" + ++count },
        task: this,
        kind: absolute ? "Absolute" : "DueRelative",
        absoluteFireDate: absolute ? value : null,
        relativeFireOffset: absolute ? null : value,
        initialFireDate: fire,
        nextFireDate: fire,
        repeatInterval: 0,
        isSnoozed: false,
        usesFloatingTimeZone: absolute,
      };
      this.notifications.push(n);
      this.notifications.sort((a, b) => a.initialFireDate - b.initialFireDate);
      return n;
    }
    removeNotification(n) {
      events.push("removeNotification");
      this.notifications.splice(this.notifications.indexOf(n), 1);
    }
    clearTags() {
      events.push("clearTags");
      this.tags = [];
    }
    addTags(value) {
      events.push("addTags");
      this.tags.push(...value);
    }
    drop() {
      events.push("drop");
      this.active = false;
      this.dropDate = new Date();
    }
    get after() {
      return { owner: this.parent, project: this.containingProject };
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
  Task.RepetitionScheduleType = {
    Regularly: "Regularly",
    FromCompletion: "FromCompletion",
  };
  Task.AnchorDateKey = { DueDate: "DueDate", DeferDate: "DeferDate" };
  Task.Notification = {
    Kind: { Absolute: "Absolute", DueRelative: "DueRelative" },
  };
  Task.RepetitionRule = class {
    constructor(rule, method, schedule, anchor, catchup) {
      this.ruleString = rule;
      this.scheduleType = schedule;
      this.anchorDateKey = anchor;
      this.catchUpAutomatically = catchup;
    }
  };

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
    inbox: Object.assign([], { ending: { owner: null } }),
    flattenedProjects: projects,
    moveTasks: (moving, position) => {
      events.push("move");
      for (const t of moving) {
        const old = t.parent?.tasks;
        if (old) old.splice(old.indexOf(t), 1);
        if (t.containingProject?.tasks.includes(t))
          t.containingProject.tasks.splice(
            t.containingProject.tasks.indexOf(t),
            1,
          );
        t.parent = position.owner;
        const project =
          position.owner?.project ?? position.owner?.containingProject ?? null;
        function propagate(t) {
          t.containingProject = project;
          for (const c of t.tasks) propagate(c);
        }
        propagate(t);
        if (position.owner) position.owner.tasks.push(t);
        if (position.owner?.project) project.tasks.push(t);
      }
    },
    duplicateTasks: (values, position) => {
      events.push("duplicate");
      return values.map((original) => {
        const t = new Task(original.name, original.containingProject);
        t.parent = original.parent;
        t.noteText = { ...original.noteText };
        t._flagged = original.flagged;
        t.tags = [...original.tags];
        for (const field of [
          "dueDate",
          "deferDate",
          "plannedDate",
          "estimatedMinutes",
          "sequential",
          "completedByChildren",
          "shouldUseFloatingTimeZone",
        ])
          t[field] = original[field];
        return t;
      });
    },
    deleteObject: (t) => {
      events.push("delete");
      tasks.splice(tasks.indexOf(t), 1);
      for (const siblings of [t.parent?.tasks, t.containingProject?.tasks])
        if (siblings?.includes(t)) siblings.splice(siblings.indexOf(t), 1);
    },
    app: {
      getTypeScriptDeclarations: () =>
        "declare class Task { plannedDate: Date | null; }",
    },
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
