// PROCESS DOUBLE: replace the native launcher; no OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { repeatingFixture } from "./repeating-fixture.mjs";
import { taskFixture } from "./task-write-fixture.mjs";
const fixture = taskFixture();
if (process.env.NOFUSS_TEST_REPEATING === "1") repeatingFixture(fixture);
NativeWorker.prototype.run = function (...args) {
  return fixture.run(...args);
};
