import { createReadStream } from "node:fs";
import { NoFussCore } from "./core.js";
import { ReadError, RESPONSE_BYTES } from "./contract.js";
import { errorCategory, errorInfo } from "./errors.js";

export const INPUT_BYTES = 65_536;
export const HELP = {
  executable: "nofuss-omnifocus",
  usage: [
    "get task|project|tag|folder|perspective ID... [--fields id,name | --view brief|detail]",
    "query tasks|projects|tags|folders|perspectives [--scope inbox|project|library] [--project-id ID] [--fields id,name] [--limit 20] [--cursor TOKEN]",
    "get|query|overview|doctor --input FILE|-",
    "overview [--waiting-tag-ids ID,ID]",
    "doctor",
    "mcp",
    "create|update|complete|move|reorder|drop|duplicate|delete task|project|tag|folder|perspective --input FILE|- [--apply --request-key KEY]",
    "batch task --input FILE|- [--apply --request-key KEY]",
    "review project --input FILE|- [--apply --request-key KEY]",
  ],
  documentation: "docs/cli.md",
};
export function exitCode(code: string): number {
  if (
    [
      "INVALID_MUTATION",
      "REQUEST_KEY_REUSE_MISMATCH",
      "REPEATING_COMPLETION_UNSUPPORTED",
    ].includes(code)
  )
    return 2;
  if (code === "WRITE_NOT_AUTHORIZED") return 4;
  if (code === "MUTATION_BUSY") return 5;
  if (code === "MUTATION_STATE_UNAVAILABLE") return 8;
  if (code === "PRECONDITION_CONFLICT") return 9;
  if (code === "MUTATION_RECONCILIATION_REQUIRED") return 10;
  switch (errorCategory(code)) {
    case "invalid_input":
    case "unsupported_capability":
    case "invalid_cursor":
    case "cursor_mismatch":
      return 2;
    case "not_found":
    case "wrong_entity":
      return 3;
    case "permission":
      return 4;
    case "deadline":
    case "unavailable":
      return 5;
    case "native_execution":
      return 6;
    case "output_limit":
      return 7;
    case "internal_protocol":
      return 8;
  }
}
function invalid(message: string): never {
  throw new ReadError("INVALID_INPUT", message);
}
export async function readInput(path: string): Promise<unknown> {
  const stream = path === "-" ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > INPUT_BYTES) invalid("JSON input exceeds 65536 bytes.");
      chunks.push(buffer);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof ReadError) throw error;
    return invalid("Cannot read a valid UTF-8 JSON input document.");
  }
}
export async function parseCommand(argv: string[], read = readInput) {
  const [command, ...rest] = argv;
  if (
    [
      "create",
      "update",
      "complete",
      "move",
      "reorder",
      "drop",
      "duplicate",
      "delete",
      "review",
      "batch",
    ].includes(command ?? "") &&
    ["task", "project", "tag", "folder", "perspective"].includes(rest[0] ?? "")
  ) {
    const options = new Map<string, string>();
    let apply = false;
    for (let i = 1; i < rest.length; i++) {
      const key = rest[i]!;
      if (key === "--apply") {
        if (apply) invalid("Duplicate apply flag.");
        apply = true;
        continue;
      }
      if (!["--input", "--request-key"].includes(key) || options.has(key))
        invalid("Unknown/duplicate write option.");
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        invalid("Write option requires a value.");
      options.set(key, value);
    }
    if (!options.has("--input")) invalid("Writes require --input FILE|-.");
    const value = await read(options.get("--input")!);
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("Expected a write JSON object.");
    const input = value as Record<string, unknown>;
    if (input.entity !== undefined && input.entity !== rest[0])
      invalid("Conflicting write entity.");
    if (input.apply === true && !apply)
      invalid("CLI apply requires explicit --apply intent.");
    const key = options.get("--request-key");
    if (key && input.request_key !== undefined && input.request_key !== key)
      invalid("Conflicting request keys.");
    return {
      command:
        rest[0] +
        "." +
        (command === "review"
          ? input.action === "set_interval"
            ? "set_review_interval"
            : input.action === "mark_reviewed"
              ? "mark_reviewed"
              : invalid("Review action must be set_interval or mark_reviewed.")
          : command),
      input: {
        ...input,
        entity: rest[0],
        apply,
        ...(key ? { request_key: key } : {}),
      },
    };
  }
  if (!["get", "query", "overview", "doctor"].includes(command ?? "")) {
    if (
      [
        "create",
        "update",
        "complete",
        "mark-reviewed",
        "script",
        "sync",
        "delete",
      ].includes(command ?? "")
    )
      throw new ReadError(
        "UNSUPPORTED_OPERATION",
        "Only read operations are supported.",
      );
    invalid(
      "Expected get, query, overview, doctor or mcp. Use --help for syntax.",
    );
  }
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      if (options.size || arg.startsWith("-"))
        invalid("Unexpected positional argument.");
      positional.push(arg);
      continue;
    }
    if (options.has(arg)) invalid("Duplicate option.");
    const value = rest[++i];
    if (value === undefined || value.startsWith("--"))
      invalid("Every option requires a value.");
    options.set(arg, value);
  }
  const allowed =
    command === "get"
      ? ["fields", "view"]
      : command === "query"
        ? [
            "fields",
            "view",
            "scope",
            "project-id",
            "depth",
            "limit",
            "cursor",
            "status",
            "flagged",
            "include-completed",
            "include-dropped",
            "available",
            "tag-ids",
            "due-from",
            "due-before",
            "defer-from",
            "defer-before",
            "planned-from",
            "planned-before",
            "effective-due-from",
            "effective-due-before",
            "effective-defer-from",
            "effective-defer-before",
            "estimate-min",
            "estimate-max",
          ]
        : command === "overview"
          ? ["waiting-tag-ids"]
          : [];
  for (const key of options.keys())
    if (key !== "--input" && !allowed.includes(key.slice(2)))
      invalid("Unknown or inapplicable option.");
  let input: Record<string, unknown> = {};
  if (options.has("--input")) {
    if (options.size !== 1)
      invalid("--input cannot be combined with request options.");
    const value = await read(options.get("--input")!);
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("Input must be a JSON object.");
    input = value as Record<string, unknown>;
  } else {
    for (const [key, value] of options) {
      const field = key.slice(2).replaceAll("-", "_");
      if (["fields", "waiting_tag_ids", "tag_ids"].includes(field))
        input[field] = value === "" ? [] : value.split(",");
      else if (field === "limit") {
        if (!/^[0-9]+$/.test(value)) invalid("Limit must be an integer.");
        input[field] = Number(value);
      } else if (
        /^(effective_)?(due|defer|planned)_(from|before)$/.test(field)
      ) {
        const end = field.endsWith("_from") ? "from" : "before";
        const dateField = field.slice(0, -(end.length + 1)) + "_at";
        input[dateField] = {
          ...((input[dateField] as object) ?? {}),
          [end]: value,
        };
      } else if (field === "estimate_min" || field === "estimate_max") {
        if (!/^(?:[0-9]+)(?:\.[0-9]+)?$/.test(value))
          invalid("Estimate must be a nonnegative number.");
        input.estimated_minutes = {
          ...((input.estimated_minutes as object) ?? {}),
          [field.slice(9)]: Number(value),
        };
      } else if (
        [
          "flagged",
          "include_completed",
          "include_dropped",
          "available",
        ].includes(field)
      ) {
        if (value !== "true" && value !== "false")
          invalid("Boolean options require true or false.");
        input[field] = value === "true";
      } else
        input[field] =
          field === "scope" && value === "inbox" ? "inbox_roots" : value;
    }
  }
  if (command === "get" || command === "query") {
    const entity = positional.shift();
    const entities: Record<string, string> =
      command === "get"
        ? {
            task: "task",
            project: "project",
            tag: "tag",
            folder: "folder",
            perspective: "perspective",
          }
        : {
            tasks: "task",
            projects: "project",
            tags: "tag",
            folders: "folder",
            perspectives: "perspective",
          };
    if (entity !== undefined) {
      if (!Object.hasOwn(entities, entity)) invalid("Unknown entity.");
      if (input.entity !== undefined && input.entity !== entities[entity])
        invalid("Positional entity conflicts with JSON input.");
      input.entity = entities[entity];
    } else if (!options.has("--input")) invalid("An entity is required.");
    if (command === "get" && positional.length) {
      if (options.has("--input"))
        invalid("IDs belong inside the input document when using --input.");
      input.ids = positional.splice(0);
    }
    if (
      command === "query" &&
      !options.has("--input") &&
      input.scope === undefined
    )
      input.scope = input.entity === "task" ? "inbox_roots" : "library";
  }
  if (positional.length) invalid("Unexpected positional argument.");
  return { command: command!, input };
}
export async function runCli(
  argv: string[],
  core: NoFussCore,
  read = readInput,
  signal?: AbortSignal,
) {
  let data: Record<string, unknown>;
  let status = 0;
  try {
    if (argv.length === 1 && argv[0] === "--help") data = HELP;
    else {
      const { command, input } = await parseCommand(argv, read);
      data = await core.execute(command, input, signal);
      // Preserve batch/diagnostic facts even when some or all reads fail.
      const errors: { code: string }[] = [];
      if (command === "get") {
        for (const item of (data as Awaited<ReturnType<NoFussCore["get"]>>)
          .results)
          if (item.error) errors.push(item.error);
      }
      if (command === "doctor") {
        const native = (data as Awaited<ReturnType<NoFussCore["status"]>>)
          .native;
        if (native.error) errors.push(native.error);
      }
      status = Math.max(0, ...errors.map((e) => exitCode(e.code)));
      if (command.startsWith("task.") && "items" in data) {
        const result = data as import("./mutation-contract.js").MutationResult;
        status =
          result.reconciliation_required ||
          result.items.some((i) => ["unknown", "partial"].includes(i.outcome))
            ? 10
            : result.items.some((i) => i.outcome === "conflict")
              ? 9
              : result.items.some((i) => i.outcome === "rejected")
                ? exitCode(result.error?.code ?? "INVALID_MUTATION")
                : 0;
      }
    }
  } catch (error) {
    const info = errorInfo(error);
    data = { error: info };
    status = exitCode(info.code);
  }
  let json = JSON.stringify(data) + "\n";
  if (Buffer.byteLength(json) > RESPONSE_BYTES) {
    json =
      JSON.stringify({
        error: {
          code: "RESPONSE_LIMIT",
          message: "Encoded CLI result exceeds the byte budget.",
        },
      }) + "\n";
    status = 7;
  }
  return { json, exitCode: status };
}
