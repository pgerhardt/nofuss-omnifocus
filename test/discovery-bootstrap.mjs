import { NativeWorker } from "../dist/worker.js";
import { discoveryFixture } from "./discovery-fixture.mjs";
const fixture = discoveryFixture();
NativeWorker.prototype.run = function (op, args) {
  return fixture.run(op, args);
};
