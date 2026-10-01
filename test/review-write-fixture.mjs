// NATIVE-ALGORITHM DOUBLE: execute both shipped launcher and project operation.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fixture } from "./project-write-fixture.mjs";
const launcher = readFileSync(
    new URL("../src/native/launcher.js", import.meta.url),
    "utf8",
  ),
  source = readFileSync(
    new URL("../src/native/project-operation.js", import.meta.url),
    "utf8",
  );
const singular = {
  days: "day",
  weeks: "week",
  months: "month",
  years: "year",
  minutes: "minute",
  hours: "hour",
};
export function reviewFixture() {
  const f = fixture(),
    p = new f.Project("review");
  p._interval = { unit: "weeks", steps: 1, fixed: true };
  p._last = null;
  Object.defineProperty(p, "reviewInterval", {
    get: () => ({ unit: p._interval.unit, steps: p._interval.steps }),
  });
  function recalculate() {
    if (!p._last) {
      p.nextReviewDate = null;
      return;
    }
    const next = new Date(p._last);
    next.setUTCHours(0, 0, 0, 0);
    if (p._interval.unit === "days")
      next.setUTCDate(next.getUTCDate() + p._interval.steps);
    if (p._interval.unit === "weeks")
      next.setUTCDate(next.getUTCDate() + 7 * p._interval.steps);
    if (p._interval.unit === "months")
      next.setUTCMonth(next.getUTCMonth() + p._interval.steps);
    if (p._interval.unit === "years")
      next.setUTCFullYear(next.getUTCFullYear() + p._interval.steps);
    p.nextReviewDate = next;
  }
  Object.defineProperty(p, "lastReviewDate", {
    get: () => p._last,
    set: (d) => {
      f.counters.setters++;
      p._last = d;
      recalculate();
    },
  });
  const bridge = { id: () => p.id.primaryKey };
  Object.defineProperty(bridge, "reviewInterval", {
    get: () => () => ({
      unit: singular[p._interval.unit],
      steps: p._interval.steps,
      fixed: p._interval.fixed,
    }),
    set: (v) => {
      f.counters.setters++;
      p._interval = {
        unit: Object.keys(singular).find((k) => singular[k] === v.unit),
        steps: v.steps,
        fixed: v.fixed,
      };
      recalculate();
    },
  });
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: (v) => v },
    $: {
      NSString: { stringWithContentsOfFileEncodingError: () => source },
      NSUTF8StringEncoding: 4,
    },
    Application: () => ({
      running: () => true,
      evaluateJavascript: (script) =>
        vm.runInNewContext(script, f.nativeContext()),
      defaultDocument: {
        flattenedProjects: {
          byId: (id) => {
            if (id !== p.id.primaryKey) throw Error("Missing exact ID");
            return bridge;
          },
        },
      },
    }),
  });
  vm.runInContext(launcher, context);
  const native = {
    run: async (op, args) => {
      const r = JSON.parse(
        context.run([
          "operation.js",
          JSON.stringify({ request_id: "x", op, args }),
        ]),
      );
      if (r.error) throw Object.assign(Error(r.error.message), r.error);
      return r.result;
    },
  };
  const core = {
    get: async ({ ids }) => ({
      results: await Promise.all(
        ids.map(async (id) => {
          const snap = (
            await native.run("project_write_facts", {
              reference: { entity: "project", id },
              review_interval: true,
            })
          ).facts;
          return {
            project: {
              ...snap,
              review_interval: { ...p._interval },
              last_review_at: snap.preserved.last_review_at,
              next_review_at: snap.preserved.next_review_at,
            },
          };
        }),
      ),
    }),
  };
  return { ...f, p, native, core };
}
