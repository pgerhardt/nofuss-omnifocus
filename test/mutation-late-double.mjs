// Simulated in-app work outlives the process that dispatched it. Files only.
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2];
await writeFile(join(directory, "double-running"), String(process.pid));
process.send({ ready: true });
await new Promise((resolve) => setTimeout(resolve, 400));
await writeFile(join(directory, "double-state"), JSON.stringify({ value: 2 }));
await unlink(join(directory, "double-running"));
