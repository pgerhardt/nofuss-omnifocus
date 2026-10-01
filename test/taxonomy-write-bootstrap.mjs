// PROCESS DOUBLE: no OmniFocus connection.
import { NativeWorker } from "../dist/worker.js";
import { fixture } from "./taxonomy-write-fixture.mjs";
const f = fixture();
const parent = new f.Tag("parent");
new f.Tag("child", parent);
new f.Folder("folder");
NativeWorker.prototype.run = function (...args) {
  return f.native.run(...args);
};
