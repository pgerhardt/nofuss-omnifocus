// Direct SDK client; never registers or deploys this server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const [tool = "nofuss_status", json = "{}"] = process.argv.slice(2);
const client = new Client({
  name: "NoFuss for OmniFocus direct harness",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  stderr: "pipe",
});
transport.stderr?.on("data", (data) => process.stderr.write(data));
try {
  await client.connect(transport);
  const result =
    tool === "tools/list"
      ? await client.listTools()
      : await client.callTool({ name: tool, arguments: JSON.parse(json) });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
