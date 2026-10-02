import { z } from "zod";
import { parseInput, parseNative } from "./errors.js";
import { ReadError } from "./contract.js";
import type { NativeWorker } from "./worker.js";
export const PluginInput = z.object({}).strict();
export const PluginOutput = z
  .object({
    plugins: z
      .array(
        z
          .object({
            identifier: z.string().min(1).max(256),
            name: z.string().max(512),
            version: z.string().max(256),
            actions: z
              .array(
                z
                  .object({
                    identifier: z.string().min(1).max(256),
                    label: z.string().max(512),
                  })
                  .strict(),
              )
              .max(200),
          })
          .strict(),
      )
      .max(50),
    invocation: z.literal("intentionally_excluded"),
    observed_at: z.string().datetime(),
  })
  .strict();
export async function plugins(
  native: Pick<NativeWorker, "run">,
  input: unknown,
) {
  parseInput(PluginInput, input);
  const r = parseNative(PluginOutput, await native.run("plugin_list", {}));
  if (
    new Set(r.plugins.map((p) => p.identifier)).size !== r.plugins.length ||
    r.plugins.some(
      (p) =>
        new Set(p.actions.map((a) => a.identifier)).size !== p.actions.length,
    ) ||
    r.plugins.reduce((n, p) => n + p.actions.length, 0) > 200
  )
    throw new ReadError(
      "INVALID_NATIVE_OUTPUT",
      "Plug-in/action identity inventory invalid",
    );
  return r;
}
