#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { NoFussCore } from "./core.js";
import { NativeWorker } from "./worker.js";
import { runCli } from "./cli-command.js";
import { errorInfo } from "./errors.js";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "mcp") {
  await import("./index.js");
} else {
  const worker = new NativeWorker();
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    process.stdin.destroy();
    void worker.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const build = JSON.parse(
      readFileSync(new URL("./build.json", import.meta.url), "utf8"),
    );
    const result = await runCli(
      argv,
      new NoFussCore(worker, build),
      undefined,
      controller.signal,
    );
    process.stdout.write(result.json);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: errorInfo(error) }) + "\n");
    process.exitCode = 8;
  } finally {
    await worker.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
