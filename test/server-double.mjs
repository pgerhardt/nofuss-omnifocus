// Loaded only by lifecycle tests. Replace the fixed osascript process, never the
// service/worker/protocol code; no production environment-variable test switch.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const original = childProcess.spawn;
const fake = fileURLToPath(new URL("./fake-native.cjs", import.meta.url));
childProcess.spawn = function (command, args, options) {
  if (command !== "/usr/bin/osascript")
    throw Error("Unexpected test subprocess");
  const envelope = JSON.parse(args.at(-1));
  envelope.args = {
    ...envelope.args,
    scenario: process.env.NFO_TEST_SCENARIO,
    ledger: process.env.NFO_TEST_LEDGER,
    test_stderr: true,
  };
  return original(process.execPath, [fake, JSON.stringify(envelope)], options);
};
syncBuiltinESMExports();
