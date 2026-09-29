import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(
  new URL("../src/native/launcher.js", import.meta.url),
  "utf8",
);
function launcher(running) {
  let evaluations = 0,
    sourceReads = 0;
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: (x) => x },
    $: {
      NSString: {
        stringWithContentsOfFileEncodingError() {
          sourceReads++;
          return "function(request) { return JSON.stringify(request); }";
        },
      },
      NSUTF8StringEncoding: 4,
    },
    Application(name) {
      assert.equal(name, "OmniFocus");
      return {
        running: () => running,
        evaluateJavascript(script) {
          evaluations++;
          return vm.runInNewContext(script, {}, { timeout: 1000 });
        },
      };
    },
  });
  vm.runInContext(source, context);
  return {
    run: (request) =>
      JSON.parse(context.run(["fixed-operation.js", JSON.stringify(request)])),
    counts: () => ({ evaluations, sourceReads }),
  };
}
test("unavailable app is NOT_RUNNING without reading/evaluating a script or launching the app", () => {
  const l = launcher(false);
  const frame = l.run({ request_id: "id", op: "status", args: {} });
  assert.equal(frame.request_id, "id");
  assert.equal(frame.error.code, "NOT_RUNNING");
  assert.deepEqual(l.counts(), { evaluations: 0, sourceReads: 0 });
});
test("fixed launcher round-trips hostile-looking Unicode arguments as data", () => {
  const l = launcher(true);
  const request = {
    request_id: "request",
    op: "get",
    args: {
      entity: "task",
      ids: ["a'\"\\\n\u2028\u2029Ω😀"],
      fields: [],
      text: "')); throw Error('injected'); // $(touch nope) `code`",
    },
  };
  assert.deepEqual(l.run(request), request);
  assert.deepEqual(l.counts(), { evaluations: 1, sourceReads: 1 });
});
