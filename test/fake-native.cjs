const envelope = JSON.parse(process.argv[2]);
const scenario = envelope.args.scenario;
const fs = require("node:fs");
if (envelope.args.test_stderr)
  process.stderr.write("private subprocess diagnostic\n");
if (envelope.args.ledger)
  fs.appendFileSync(
    envelope.args.ledger,
    JSON.stringify({
      event: "launch",
      id: envelope.request_id,
      op: envelope.op,
      pid: process.pid,
      args: envelope.args,
    }) + "\n",
  );
const frame = JSON.stringify({
  request_id: scenario === "mismatch" ? "stale" : envelope.request_id,
  result: { text: "Ω 😀 ’", op: envelope.op },
});
if (scenario === "permission") {
  process.stderr.write(
    "private script path and task title: Not authorized to send Apple events to OmniFocus. (-1743)\n",
  );
  process.exitCode = 1;
} else if (scenario === "diagnostic") {
  process.stderr.write("private diagnostic text\n");
  process.stdout.write(frame);
} else if (scenario === "empty") {
  /* successful process without a frame */
} else if (scenario === "multiple") process.stdout.write(frame + "\n" + frame);
else if (scenario === "both")
  process.stdout.write(
    JSON.stringify({
      request_id: envelope.request_id,
      result: {},
      error: null,
    }),
  );
else if (scenario === "extra")
  process.stdout.write(
    JSON.stringify({
      request_id: envelope.request_id,
      result: {},
      extra: true,
    }),
  );
else if (scenario === "missing")
  process.stdout.write(JSON.stringify({ request_id: envelope.request_id }));
else if (scenario === "baderror")
  process.stdout.write(
    JSON.stringify({
      request_id: envelope.request_id,
      error: { code: 3, message: "bad" },
    }),
  );
else if (scenario === "unavailable")
  process.stdout.write(
    JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: "NOT_RUNNING",
        message: "OmniFocus must already be running.",
      },
    }),
  );
else if (scenario === "late") {
  // Independent bounded read simulation. Killing its launcher does not stop it.
  const child = require("node:child_process").spawn(
    process.execPath,
    [
      "-e",
      'setTimeout(()=>require("node:fs").appendFileSync(process.argv[1],JSON.stringify({event:"late",id:process.argv[2]})+"\\n"),600)',
      envelope.args.ledger,
      envelope.request_id,
    ],
    { stdio: "ignore" },
  );
  fs.appendFileSync(
    envelope.args.ledger,
    JSON.stringify({ event: "native", pid: child.pid }) + "\n",
  );
  child.unref();
  process.stdout.write(frame); // Even a buffered result is discarded on deadline.
  setTimeout(() => {}, 10000);
} else if (scenario === "hang") setTimeout(() => {}, 10000);
else if (scenario === "exit") process.exit(3);
else if (scenario === "oversize") process.stdout.write("x".repeat(50000));
else if (scenario === "stderr") process.stderr.write("x".repeat(50000));
else if (scenario === "bad") process.stdout.write("{broken");
else if (scenario === "utf8bad")
  process.stdout.write(Buffer.from([0xc3, 0x28]));
else if (scenario === "split") {
  const bytes = Buffer.from(frame);
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(bytes.subarray(i, i + 1));
    if (++i === bytes.length) clearInterval(timer);
  }, 1);
} else
  setTimeout(
    () => process.stdout.write(frame + "\n"),
    envelope.args.delay ?? 0,
  );
