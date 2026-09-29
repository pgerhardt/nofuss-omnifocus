import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ReadError } from "./contract.js";

interface Options {
  command?: string;
  prefix?: string[];
  timeoutMs?: number;
  maxPending?: number;
  outputBytes?: number;
}
interface Job {
  op: string;
  args: unknown;
  requestId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort: () => void;
}
export class NativeWorker {
  private queue: Job[] = [];
  private active: {
    job: Job;
    child: ChildProcessWithoutNullStreams;
    error?: ReadError;
  } | null = null;
  private closed = false;
  private closeWaiters: (() => void)[] = [];
  private options: Required<Options>;
  constructor(options: Options = {}) {
    this.options = {
      command: "/usr/bin/osascript",
      prefix: [
        "-l",
        "JavaScript",
        fileURLToPath(new URL("./native/launcher.js", import.meta.url)),
        fileURLToPath(new URL("./native/operation.js", import.meta.url)),
      ],
      timeoutMs: 15000,
      maxPending: 8,
      outputBytes: 262144,
      ...options,
    };
  }
  snapshot() {
    return {
      mode: "per_call_osascript" as const,
      state: this.closed ? "closed" : this.active ? "running" : "idle",
      queued: this.queue.length,
      timeout_ms: this.options.timeoutMs,
      max_pending: this.options.maxPending,
      result_cache: false as const,
      coordination: "single_process" as const,
    };
  }
  run(op: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new ReadError("SHUTDOWN", "Native worker is closed."),
      );
    if (signal?.aborted)
      return Promise.reject(
        new ReadError("CANCELLED", "Request was cancelled."),
      );
    if (this.queue.length + (this.active ? 1 : 0) >= this.options.maxPending)
      return Promise.reject(
        new ReadError(
          "QUEUE_FULL",
          "Native queue is full; no request was launched.",
        ),
      );
    return new Promise((resolve, reject) => {
      const job: Job = {
        op,
        args,
        requestId: randomUUID(),
        resolve,
        reject,
        signal,
        timer: setTimeout(
          () =>
            this.cancel(
              job,
              new ReadError(
                "TIMEOUT",
                "Read deadline exceeded, including queue time. Native read may still finish; no retry was attempted.",
              ),
            ),
          this.options.timeoutMs,
        ),
        abort: () =>
          this.cancel(
            job,
            new ReadError(
              "CANCELLED",
              "Read cancelled; native evaluation may still finish.",
            ),
          ),
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  private release(job: Job) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
  }
  private cancel(job: Job, error: ReadError) {
    if (this.active?.job === job) {
      this.active.error ??= error;
      this.active.child.kill("SIGKILL"); // Kill only the launcher owned by this request.
      return; // Wait for close before dispatching another operation.
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.release(job);
      job.reject(error);
    }
  }
  private pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.options.command,
        [
          ...this.options.prefix,
          JSON.stringify({
            request_id: job.requestId,
            op: job.op,
            args: job.args,
          }),
        ],
        { stdio: "pipe" },
      );
    } catch {
      this.release(job);
      job.reject(
        new ReadError("SPAWN_FAILED", "Could not launch the native reader."),
      );
      this.pump();
      return;
    }
    this.active = { job, child };
    child.stdin.end();
    const output: Buffer[] = [],
      diagnostics: Buffer[] = [];
    let outputSize = 0,
      stderrSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > this.options.outputBytes)
        this.cancel(
          job,
          new ReadError(
            "OUTPUT_LIMIT",
            "Native output exceeded the transport byte limit.",
          ),
        );
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 32768)
        this.cancel(
          job,
          new ReadError(
            "OUTPUT_LIMIT",
            "Native diagnostic output exceeded the byte limit.",
          ),
        );
      else diagnostics.push(chunk);
      // Inspect only a known OS error code; never forward private native diagnostics.
    });
    child.on("error", () => {
      if (this.active?.job === job)
        this.active.error ??= new ReadError(
          "SPAWN_FAILED",
          "Could not launch the native reader.",
        );
    });
    child.on("close", (code) => {
      const failure = this.active?.error;
      this.active = null;
      this.release(job);
      try {
        if (failure) throw failure;
        if (
          code !== 0 &&
          /\(-1743\)\s*$/.test(Buffer.concat(diagnostics).toString("utf8"))
        )
          throw new ReadError(
            "AUTOMATION_DENIED",
            "macOS denied Automation access to OmniFocus (-1743).",
          );
        if (code !== 0)
          throw new ReadError(
            "NATIVE_PROCESS_FAILED",
            "Native launcher failed. Check Automation access and OmniFocus readiness.",
          );
        let frame;
        try {
          frame = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(output),
            ),
          );
        } catch {
          throw new ReadError(
            "INVALID_NATIVE_OUTPUT",
            "Native reader returned invalid UTF-8 or a malformed result frame.",
          );
        }
        if (!frame || frame.request_id !== job.requestId)
          throw new ReadError(
            "RESPONSE_MISMATCH",
            "Native response did not match its request.",
          );
        const hasResult = Object.hasOwn(frame, "result"),
          hasError = Object.hasOwn(frame, "error");
        if (
          hasResult === hasError ||
          Object.keys(frame).length !== 2 ||
          (hasError &&
            (!frame.error ||
              typeof frame.error !== "object" ||
              typeof frame.error.code !== "string" ||
              !frame.error.code ||
              typeof frame.error.message !== "string"))
        )
          throw new ReadError(
            "INVALID_NATIVE_OUTPUT",
            "Native response must contain exactly one result or typed error.",
          );
        if (hasError)
          throw new ReadError(frame.error.code, frame.error.message);
        job.resolve(frame.result);
      } catch (error) {
        job.reject(
          error instanceof Error
            ? error
            : new ReadError("NATIVE_READ_FAILED", "Native read failed."),
        );
      }
      if (this.closed) {
        this.closeWaiters.splice(0).forEach((resolve) => resolve());
      } else this.pump();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.release(job);
      job.reject(new ReadError("SHUTDOWN", "Server is shutting down."));
    }
    if (this.active) {
      const pending = new Promise<void>((resolve) =>
        this.closeWaiters.push(resolve),
      );
      this.cancel(
        this.active.job,
        new ReadError("SHUTDOWN", "Server is shutting down."),
      );
      await pending;
    }
  }
}
