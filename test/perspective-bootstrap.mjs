// PROCESS DOUBLE: shipped read algorithm, no native OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { perspectiveFixture } from "./perspective-fixture.mjs";
const fixture = perspectiveFixture();
NativeWorker.prototype.run = function (...args) {
  return fixture.run(...args);
};
