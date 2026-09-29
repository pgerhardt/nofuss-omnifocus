// Compatibility module: the MCP presentation adapter, no domain/native logic.
import { NoFussCore } from "./core.js";
import { ReadError, RESPONSE_BYTES } from "./contract.js";
import type { NativeWorker } from "./worker.js";
import type { WriteScope } from "./write-authorization.js";
export { errorInfo } from "./errors.js";

export function mcpResult(data: Record<string, unknown>, isError = false) {
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > RESPONSE_BYTES)
    throw new ReadError(
      "RESPONSE_LIMIT",
      "Encoded MCP result exceeds the byte budget.",
    );
  return result;
}
export function resultBytes(
  data: Record<string, unknown>,
  isError = false,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
      ...(isError ? { isError: true } : {}),
    }),
  );
}
export class ReadService {
  private core: NoFussCore;
  constructor(
    worker: Pick<NativeWorker, "run" | "snapshot">,
    build: Record<string, unknown>,
  ) {
    this.core = new NoFussCore(worker, build);
  }
  async mutate(scope: WriteScope, input: unknown) {
    const result = await this.core.mutate(scope, input);
    return mcpResult(
      result,
      "items" in result &&
        (result.reconciliation_required ||
          result.items.some((i) => i.outcome !== "applied")),
    );
  }
  async get(input: unknown, signal?: AbortSignal) {
    const data = await this.core.get(input, signal);
    return mcpResult(
      data,
      data.results.some((r) => r.status !== "ok"),
    );
  }
  async query(input: unknown, signal?: AbortSignal) {
    return mcpResult(await this.core.query(input, signal));
  }
  async overview(input: unknown, signal?: AbortSignal) {
    return mcpResult(await this.core.overview(input, signal));
  }
  async status(signal?: AbortSignal) {
    return mcpResult(await this.core.status(signal));
  }
}
