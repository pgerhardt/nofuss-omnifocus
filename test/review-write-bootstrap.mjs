// PROCESS DOUBLE: no live OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { reviewFixture } from "./review-write-fixture.mjs";
const f = reviewFixture();
NativeWorker.prototype.run = function (...args) {
  return f.native.run(...args);
};
