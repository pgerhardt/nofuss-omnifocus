// PROCESS DOUBLE: fixed native project facts; no OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { fixture } from "./project-write-fixture.mjs";
const f = fixture();
new f.Project("base");
new f.Folder("folder");
NativeWorker.prototype.run = function (...args) {
  return f.native.run(...args);
};
