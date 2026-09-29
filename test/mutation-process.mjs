// PROCESS DOUBLE. Only writes test-directory files. Never imports native worker.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fixture, request } from "./mutation-fixture.mjs";
const [directory, key, interruption = "", mode = "apply"] =
  process.argv.slice(2);
async function pause(point) {
  if (point !== interruption) return;
  process.send?.({ point });
  await new Promise((resolve) => process.once("message", resolve));
}
async function state() {
  try {
    return JSON.parse(await readFile(join(directory, "double-state"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { value: 1 };
    throw error;
  }
}
const f = fixture(directory, {
  checkpoint: pause,
  setter: async () => {
    await appendFile(join(directory, "double-setters"), `${key}\n`);
    if (interruption === "late-work") {
      const late = fork(
        new URL("./mutation-late-double.mjs", import.meta.url),
        [directory],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await once(late, "message");
      late.disconnect();
      late.unref();
      throw Error("launcher timeout while simulated native work continues");
    }
    await pause("during-setter");
    await writeFile(
      join(directory, "double-state"),
      JSON.stringify({ value: 2 }),
    );
    await pause("response-lost");
    if (interruption === "throw-lost") throw Error("lost setter response");
  },
  readback: async () => {
    await pause("during-readback");
    const current = await state();
    let running = false;
    try {
      await readFile(join(directory, "double-running"));
      running = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return {
      settled: !running,
      items: [
        {
          item_key: "a",
          all_postconditions: current.value === 2,
          some_effects: false,
          evidence: [
            "independent process-double file read; old double is stopped",
          ],
        },
      ],
    };
  },
});
f.reader.resolve = async (reference) => ({ reference, facts: await state() });
f.reader.readFact = async () => (await state()).value;
try {
  const r = request(key);
  if (mode === "inspect")
    process.send?.({ inspection: await f.boundary.reconcile(r) });
  else if (mode === "read-loop") {
    for (let i = 0; i < 100; i++) {
      const record = await f.journal.read(key);
      if (!record) throw Error("record disappeared");
    }
    process.send?.({ read: true });
  } else process.send?.({ result: await f.boundary.apply(r) });
} catch (error) {
  process.send?.({ error: { code: error.code, message: error.message } });
}
process.disconnect?.();
