// Small adapter-parity fixture executing the retained native algorithm. Native
// conformance remains covered by existing tests and independent live evidence.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ReadError } from "../dist/contract.js";
import { NativeWorker } from "../dist/worker.js";
export const now = "2026-09-28T12:00:00.000Z";
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
}
const ref = (id) => ({ id: { primaryKey: id } });
export function fixture(mode) {
  const statuses = Object.fromEntries(
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
  const tag = ref("wait-tag");
  const task = (id) => ({
    ...ref(id),
    name: id + " Ω",
    noteText: { string: "abcdef😀" },
    project: null,
    containingProject: null,
    parent: null,
    tasks: [],
    active: true,
    completed: false,
    added: null,
    taskStatus: statuses.Available,
    tags: [tag, ref("other-tag")],
  });
  const inbox = [task("inbox.1"), task("inbox.2")];
  const Kind = {
    Absolute: "absolute",
    DueRelative: "relative",
    Unknown: "unknown",
  };
  if (mode?.startsWith("notifications")) {
    for (const [index, raw] of [-1800, 900].entries()) {
      const owner = inbox[index];
      const alarm = {
        ...ref("relative." + index),
        task: owner,
        kind: Kind.DueRelative,
        initialFireDate: new Date(
          index ? "2099-01-15T18:15:00Z" : "2099-01-15T17:30:00Z",
        ),
        nextFireDate: null,
        relativeFireOffset: raw,
        repeatInterval: 0,
        isSnoozed: false,
        usesFloatingTimeZone: false,
        get absoluteFireDate() {
          throw Error("Nonapplicable getter");
        },
      };
      owner.notifications = [alarm];
    }
    inbox[0].notifications.push({
      ...ref("absolute"),
      task: inbox[0],
      kind: Kind.Absolute,
      initialFireDate: new Date("2099-01-14T18:00:00Z"),
      nextFireDate: null,
      absoluteFireDate: new Date("2099-01-14T18:00:00Z"),
      repeatInterval: 3600,
      isSnoozed: false,
      usesFloatingTimeZone: true,
      get relativeFireOffset() {
        throw Error("Nonapplicable getter");
      },
    });
  }
  if (mode === "notifications-unavailable") {
    Object.defineProperty(inbox[0].notifications[0], "relativeFireOffset", {
      get() {
        throw Error("Native getter unavailable");
      },
    });
  }
  if (mode === "field-states") {
    Object.assign(inbox[0], {
      name: "😀".repeat(600),
      noteText: { string: "" },
      tags: { length: 0, map: Array.prototype.map },
      dueDate: null,
      flagged: false,
      estimatedMinutes: 0,
    });
    Object.defineProperty(inbox[0], "plannedDate", {
      get() {
        throw Error("unavailable");
      },
    });
  }
  const root = task("project");
  const child = task("child");
  const child2 = {
    ...task("child2"),
    completed: true,
    taskStatus: statuses.Completed,
  };
  const project = {
    ...ref("project"),
    name: "Project",
    status: "active",
    flagged: false,
    task: root,
    nextReviewDate: null,
    tasks: [child, child2],
    flattenedTasks: [child, child2],
    tags: [],
    noteText: { string: "Project note" },
  };
  root.project = project;
  child.parent = root;
  child.containingProject = project;
  child2.parent = root;
  child2.containingProject = project;
  const tasks = [...inbox, root, child, child2];
  const op = vm.runInNewContext(
    "(" +
      readFileSync(
        new URL("../src/native/operation.js", import.meta.url),
        "utf8",
      ) +
      ")",
    {
      Date: Clock,
      inbox,
      flattenedProjects: [project],
      Task: {
        Status: statuses,
        Notification: { Kind },
        byIdentifier: (id) => tasks.find((t) => t.id.primaryKey === id) ?? null,
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
      Tag: { byIdentifier: (id) => (id === "wait-tag" ? tag : null) },
      Folder: { byIdentifier: () => null },
      app: {
        userVersion: { versionString: "4.9.2" },
        buildVersion: {
          versionString:
            mode === "notifications-unverified" ? "188.4" : "188.3",
        },
      },
    },
  );
  return {
    inbox,
    project,
    run: async (operation, args) => {
      const frame = JSON.parse(
        op({ request_id: "parity", op: operation, args }),
      );
      if (frame.error)
        throw new ReadError(frame.error.code, frame.error.message);
      return frame.result;
    },
    snapshot: () => new NativeWorker().snapshot(),
  };
}
