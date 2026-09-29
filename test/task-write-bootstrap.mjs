// PROCESS DOUBLE: replace the native launcher; no OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { taskFixture } from "./task-write-fixture.mjs";
const fixture = taskFixture();
NativeWorker.prototype.run = function (...args) {
  return fixture.run(...args);
};
