# NoFuss for OmniFocus: direct CLI (private development)

`nofuss-omnifocus` calls the typed `NoFussCore` directly, then the existing native
worker and fixed scripts. Ordinary reads have no MCP client/server hop and never
use `scripts/call.mjs`. Only `nofuss-omnifocus mcp` loads the MCP server. The package is `nofuss-omnifocus`; the existing
`nofuss-omnifocus-mcp` executable remains an MCP compatibility alias. The former npm
package name is not a registry alias. No global installation or daily-runtime
activation is required.

Build with `npm run build`. In this checkout, substitute `node dist/cli.js` for
`nofuss-omnifocus` in examples. The additive package bin exposes the latter name
when installed in a later packaging step. Node 22+ and an already running,
Automation-authorized OmniFocus are required. No command starts or activates it.

## Syntax

```sh
nofuss-omnifocus query tasks --scope inbox --fields id,name --limit 20
nofuss-omnifocus get task TASK_ID --fields id,name,note
nofuss-omnifocus get project PROJECT_ID --view detail
nofuss-omnifocus query tasks --scope project --project-id PROJECT_ID --depth descendants --fields id,name --limit 20
nofuss-omnifocus query projects --status active --flagged false --fields id,name --limit 20
nofuss-omnifocus overview
nofuss-omnifocus overview --waiting-tag-ids TAG_ID,OTHER_TAG_ID
nofuss-omnifocus doctor
nofuss-omnifocus mcp
nofuss-omnifocus --help
```

`get task|project ID...` accepts 1–20 exact persistent IDs, including dots; order
and duplicates are retained. `query tasks|projects` uses Inbox roots or library
scope respectively by default. `--scope inbox` is only an argv convenience for
`inbox_roots`; JSON uses the existing contract spelling. Query also accepts
`--view brief|detail`, `--cursor TOKEN`, and `--include-completed true|false` for
tasks. Each option takes a value; boolean values must be `true` or `false`.
Duplicate, unknown, inapplicable or conflicting arguments fail. Entity/IDs precede
options. No abbreviations, positional name search or arbitrary expressions exist.

`--fields` is a comma-separated list, overrides `--view`, and always retains ID.
`--fields ''` requests ID only. Brief is the default. Page limit defaults to 25
and is capped at 200. Scope, filters, local/effective state, explicit unavailable
fields and truncated values retain the [read contract](contract.md).

For every existing request shape (trees, field continuations, all projections),
use a complete strict JSON object from a UTF-8 file or stdin:

```sh
nofuss-omnifocus query tasks --input query.json
nofuss-omnifocus get --input project-tree.json
printf '%s\n' '{"waiting_tag_ids":["TAG_ID"]}' | nofuss-omnifocus overview --input -
```

Example `project-tree.json`:

```json
{
  "entity": "project",
  "ids": ["PROJECT_ID"],
  "fields": ["name"],
  "tree": { "fields": ["name", "status"], "limit": 200 }
}
```

`--input` cannot combine with request flags or positional IDs. An optional
positional entity must agree with the JSON entity. JSON uses precisely the shared
get/query/overview/status input schemas, including rejection of unknown fields.
`doctor` accepts only `{}`. File/stdin input is bounded to 65,536 bytes; unreadable
files, malformed UTF-8/JSON, nonobjects and oversized input produce `INVALID_INPUT`.
Stdin is consumed only for `--input -`; shell pipelines can use `jq` after the CLI.

## JSON and exits

Stdout is exactly one compact JSON document plus newline (including errors and
help). No prose or diagnostics are mixed into it. Diagnostics belong to stderr;
private native stderr is bounded and discarded by the existing worker. Stable
serialization follows the shared schema; timestamps and observed native facts are
fresh, so repeated live calls need not have identical bytes.

Successful exact get (synthetic):

```json
{
  "results": [
    {
      "id": "TASK_ID",
      "status": "ok",
      "task": { "id": "TASK_ID", "name": "Plan workshop" }
    }
  ],
  "read_at": "2026-09-28T12:00:00.000Z"
}
```

Top-level error (exit 2):

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Input does not match the strict read contract."
  }
}
```

Per-ID failure retains the entire batch, including successes (exit 3 here):

```json
{
  "results": [
    {
      "id": "MISSING_ID",
      "status": "not_found",
      "error": {
        "code": "NOT_FOUND",
        "message": "No task has this persistent ID."
      }
    }
  ],
  "read_at": "2026-09-28T12:00:00.000Z"
}
```

| Exit | Meaning                                                                                | Representative existing codes                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Successful read/help; explicit field unavailability or truncation can still be present | —                                                                                                                                                             |
| 2    | Invalid input, unsupported capability, invalid/stale/mismatched cursor                 | INVALID_INPUT, INVALID_TEXT_SELECTION, INVALID_COLLECTION_SELECTION, INVALID_TREE, UNSUPPORTED_OPERATION, INVALID_CURSOR, CURSOR_STALE, CURSOR_QUERY_MISMATCH |
| 3    | Missing ID or wrong entity                                                             | NOT_FOUND, PROJECT_NOT_FOUND, TAG_NOT_FOUND, WRONG_ENTITY, PROJECT_ROOT_EXCLUDED                                                                              |
| 4    | Automation permission denied                                                           | AUTOMATION_DENIED                                                                                                                                             |
| 5    | Deadline/cancellation or temporarily unavailable worker/app                            | TIMEOUT, CANCELLED, NOT_RUNNING, QUEUE_FULL, SHUTDOWN                                                                                                         |
| 6    | Native execution failure                                                               | NATIVE_READ_FAILED, NATIVE_PROCESS_FAILED, SPAWN_FAILED, INVENTORY_CHANGED, other native failure codes                                                        |
| 7    | Native/domain/encoded output limit                                                     | OUTPUT_LIMIT, RESPONSE_LIMIT, FIELD_OUTPUT_LIMIT, RECORD_OUTPUT_LIMIT                                                                                         |
| 8    | Internal/protocol failure                                                              | INVALID_NATIVE_OUTPUT, RESPONSE_MISMATCH, READ_FAILED                                                                                                         |

For multiple batch failures, the highest applicable exit number wins; all errors
remain in their original per-ID order. Unavailable selected fields are data-quality
states, not whole-operation failures. `doctor` preserves truthful diagnostics even
when disconnected, and exits according to `native.error`. A connected app with
unavailable introspection still exits 0; introspection does not certify behavior.
MCP status retains its existing successful diagnostic-envelope behavior.

The core preserves existing native/cursor codes. Two boundary classifications
are now explicit: public schema failures become `INVALID_INPUT`; malformed typed
native payloads become `INVALID_NATIVE_OUTPUT` instead of a generic `READ_FAILED`.
MCP's SDK still handles input-schema rejection at registration. These are error
classification improvements, not changes to native read selection or semantics.

## Budgets and continuation

Domain selection keeps the frozen v1 packing policy: raw JSON byte weight plus
its JSON-string escaping weight and a 58-unit reserve (73 for failed batches),
within 65,536 units. Those historical reserves deliberately preserve the old
selection thresholds. This policy constructs no transport envelope. Tests compare
it with the historical MCP encoding cost, including escaped Unicode/control text.
Do not increase native page sizes merely because a transport has less overhead.

Adapters independently enforce their real encoding: MCP checks the entire tool
result including both text and structured content against 65,536 bytes; CLI checks
its JSON plus newline against the same ceiling. The fixed native record, field,
page and compact-list bounds are unchanged. Pages stop at record boundaries with
continuation; batches keep explicit per-ID response-limit errors; overview retains
full-scope counts and truthful list coverage. No head/tail truncation or huge
implicit export is performed.

Follow query `next_cursor` via `--cursor` (or JSON `cursor`) with identical traversal
parameters until `has_more:false`. Tree continuation goes in `tree.cursor`. Field
continuation goes in exact-get `text.cursor` or `collection.cursor`, with the same
owner and field. Cursors bind API/schema version, entity, persistent owner ID,
field, ordering/units and window offset/size; query/tree bindings remain unchanged.
Field continuations **do not bind content revision**. Concatenated windows are
**not snapshot-consistent**: concurrent native edits can affect later windows,
including insertion, replacement, deletion and shifted offsets. Unchanged-data
reconstruction is tested separately from live edit behavior. No snapshot cache,
mirror or new cursor system exists.

## Process and capability boundaries

Sequential ordinary CLI use is supported. Each shell invocation is an independent
process; its in-process queue does not coordinate separate CLI invocations. The
unchanged worker admits eight total jobs, including the active job: at most one
running and seven waiting. The 15-second deadline includes waiting. Native output
limits are 256 KiB stdout and 32 KiB stderr. Request IDs, cancellation, late-result
isolation and no automatic replay remain intact. Stopping a launcher does not
prove that already-dispatched in-app work stopped. No daemon, PTY, persistent
bridge, cross-process scheduler or native result cache is added.

Writes require explicit host authorization and apply intent. See [safe writes](safe-writes.md)
for current subsets and exclusions. Arbitrary scripts, sync-completion truth,
attachment CRUD and locations remain deferred. Typed custom perspective mutation is
available on the development branch; headless evaluation remains unavailable.
`doctor` reports the same build/native/capability/verification facts as `nofuss_status`.

## Modules

- `src/core.ts`: typed reads, validation, native orchestration, semantic checks,
  projection, pagination, continuations and packing decisions.
- `src/contract.ts`, `src/cursor.ts`, `src/errors.ts`, `src/packing.ts`,
  `src/verification.ts`: shared schemas, tokens, error taxonomy, frozen selection
  cost and build-bound evidence. No MCP SDK dependency.
- `src/worker.ts`, `src/native/`: existing bounded per-call native execution.
- `src/cli-command.ts`, `src/cli.ts`: strict argv/file/stdin input, JSON output,
  exit mapping and optional dynamic MCP launch.
- `src/service.ts`: thin compatibility MCP presentation adapter; `src/index.ts`:
  four default read registrations, optional policy-gated task tools, annotations
  and stdio server lifecycle.

`NoFussCore.execute(operation, input, signal?)` accepts shared reads and declared
semantic mutation operations. Unknown commands cannot become native scripts.

## Gated mutation commands

Create/update/complete/move/reorder/drop/duplicate/delete task commands and the supported
project/taxonomy/perspective/review/batch verbs use strict JSON via `--input FILE|-`.
Default is preview. Apply requires `--apply --request-key KEY` plus private host
operation/object authorization. See [safe writes](safe-writes.md) for supported
subsets, pinned input, outcomes, exits and no-replay behavior; CLI help lists grammar.

## Direct capture and Inbox triage

The existing `create task` accepts exactly one of legacy `project_id`,
`destination:{"kind":"inbox"}` or `destination:{"kind":"parent","task_id":"EXACT_ID"}`.
Inbox scalar updates require exact `task_id`, `changes`, `allow_inbox:true` and
`task.update` scope. Parent capture authorizes its actual native containing project
or explicit Inbox scope. See [capture contract](inbox-parent-capture.md).
