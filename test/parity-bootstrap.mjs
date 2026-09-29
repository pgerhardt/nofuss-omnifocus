// Test-only preload: no production switch or user-selectable native executor.
import { registerHooks } from "node:module";
import { NativeWorker } from "../dist/worker.js";
import { ReadError } from "../dist/contract.js";
import { fixture } from "./parity-fixture.mjs";
if (process.env.NFO_TEST_NO_MCP)
  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier.includes("@modelcontextprotocol") ||
        /\/(service|index)\.js$/.test(specifier)
      )
        throw Error("Direct CLI imported MCP");
      return next(specifier, context);
    },
  });
const reader = fixture(process.env.NFO_TEST_FIXTURE);
NativeWorker.prototype.run = async function (op, args) {
  if (process.env.NFO_TEST_ERROR)
    throw new ReadError(process.env.NFO_TEST_ERROR, "Controlled failure.");
  if (process.env.NFO_TEST_DIAGNOSTIC)
    process.stderr.write("controlled diagnostic\n");
  return reader.run(op, args);
};
