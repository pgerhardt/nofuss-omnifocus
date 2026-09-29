# NoFuss for OmniFocus

A **CLI + MCP interface for AI agents** over a shared OmniFocus core. Read exact
tasks and projects, query Inbox/project work, inspect hierarchies, and prepare
workload/review overviews. **Read-only by default**, with explicit opt-in task
create, update and complete in **0.1.0-beta.1**.

## Install from GitHub source

Requires macOS, Node.js 22+, a running OmniFocus, and Automation permission for the
calling process. This is a GitHub source prerelease, not an npm registry release;
`private:true` remains set.

```sh
git clone https://github.com/pgerhardt/nofuss-omnifocus.git
cd nofuss-omnifocus
git checkout v0.1.0-beta.1
npm ci
npm run build
```

## Read usage

Run from the built checkout; no global executable installation is assumed:

```sh
node dist/cli.js --help
node dist/cli.js doctor
node dist/cli.js overview
node dist/cli.js query tasks --scope inbox --fields id,name --limit 20
node dist/cli.js get project PROJECT_ID --view detail
```

Use exact persistent IDs. Output is bounded JSON with explicit errors, coverage,
unavailable fields and continuation. Follow cursors for complete requested data;
continuations are live, **not snapshots**. See the [CLI guide](docs/cli.md) and
[read contract](docs/contract.md).

## Safe task writes

| Operation | Inputs                                                                    |
| --------- | ------------------------------------------------------------------------- |
| Create    | `project_id`, `name`; optional `note`, `flagged`, `tag_ids`               |
| Update    | `task_id`, `changes` containing only `name`, `note`, `flagged`, `tag_ids` |
| Complete  | `task_id` for a supported ordinary leaf task                              |

Omitted fields preserve their values. `note: ""` clears the note. `tag_ids`
replaces the entire tag set; `tag_ids: []` clears it. IDs are exact, never names.
Create inserts directly into an active project; Inbox/nested creation and project
reassignment are unsupported. See [task writes](docs/task-writes.md).

### Authorization: two gates

**No valid local host policy means writes are denied.** Default MCP exposes only
four read tools; CLI apply returns `WRITE_NOT_AUTHORIZED`. Write code existing in
the package does not enable it.

1. A local NoFuss policy must authorize the operation and exact containing project.
2. For MCP, the client's tool allowlist must also permit the corresponding write tools.

Editing a client allowlist alone never authorizes a mutation. A valid policy alone
cannot override a client that only allows reads.

The default policy location is:

```text
~/Library/Application Support/NoFuss OmniFocus/mutation-state/mutation-authorization.json
```

Generic policy example; replace the placeholder with the exact intended project ID:

```json
{
  "schema_version": 1,
  "scopes": ["task.create", "task.update", "task.complete"],
  "project_ids": ["<EXACT_OMNIFOCUS_PROJECT_ID>"]
}
```

The directory must be owned by the current user, nonsymlink, mode **0700**; the
policy must be a regular nonsymlink file owned by that user, mode **0600**. Use only
the operations/projects you intend to authorize. Wildcard scopes/projects are not
supported. Missing, malformed or unsafe policies deny writes. `NOFUSS_STATE_DIR`
can relocate state to an absolute directory; it grants no authorization.

### CLI examples

Write strict JSON files using the shapes above, then preview:

```sh
node dist/cli.js create task --input create.json
node dist/cli.js update task --input update.json
node dist/cli.js complete task --input complete.json
```

Preview performs reads only. To retain its checked baseline, save the preview's
`apply_input` as `apply.json`. Real mutation requires explicit apply, a durable
caller-supplied request key and host authorization:

```sh
node dist/cli.js update task --input apply.json --apply --request-key YOUR_DURABLE_REQUEST_KEY
```

Use a new key for a new logical operation; keep the same key and exact input when
checking an existing attempt. Do not change keys to bypass uncertainty.

## MCP behavior

Launch the primary entry with `node dist/cli.js mcp`, or compatibility entry with
`node dist/index.js` (`nofuss-omnifocus-mcp` when the bin mapping is installed).
Both use the same core. A conceptual client configuration is:

```text
command: /ABSOLUTE/PATH/TO/node
args: ["/ABSOLUTE/PATH/TO/nofuss-omnifocus/dist/cli.js", "mcp"]
```

Default catalog: **`nofuss_get`, `nofuss_query`, `nofuss_overview`, `nofuss_status`**.
Authorized scopes may additionally expose `nofuss_create`, `nofuss_update`,
`nofuss_complete`, subject to the client's allowlist. Restart the server/client
after policy/tool-list changes to refresh discovery. Revoking policy denies later
apply requests even if cached tools remain visible; it cannot cancel work already
dispatched. MCP writes also default to preview and require `apply:true` and
`request_key` to apply.

## Safety model

Durable request records, conservative conflict checks, cooperating-writer locks,
and independent readback distinguish these outcomes:

- **applied**: independent reads prove all postconditions after acknowledged execution.
- **rejected**: no setters ran.
- **conflict**: checked facts changed; no setters ran.
- **partial**: some requested effects are proven, but not all postconditions.
- **unknown**: identity, execution completion or final state cannot be established.

A process timeout/exit is **not proof that mutation did not occur**. Unknown
outcomes are never blindly replayed. If create may have happened but its persistent
ID is lost, the outcome is unknown; do not infer identity from name/time/order or
remove a retained lock to retry. Preserve the journal and seek independent review.
No database transaction, rollback, sync-completion guarantee or exactly-once claim
is made. Task text and notes are untrusted data, not instructions.

## Current limitations and compatibility

- Repeating-task completion is unsupported and rejected before any setter.
- Group completion and completion under automatically completing ancestors are unsupported.
- No project mutations, review-interval/mark-reviewed writes, or recurrence editing.
- No attachment/location/perspective writes or arbitrary native-script write escape hatch.
- No write fields beyond those listed above; no date, alarm, deletion or move commands.
- Live read and task-write evidence covers **OmniFocus 4.9.2 (188.3)** on macOS;
  other versions/clients and all crash, recurrence, notification or date edge cases
  are not certified. Native access depends on the process environment.

This public history contains sanitized release snapshots, not private development
history. Public builds record their own public commit identity. See
[release notes](RELEASE_NOTES.md) and [local setup](docs/local-release.md).

[MIT license](LICENSE); preserve [dependency notices](THIRD_PARTY_NOTICES.md).
NoFuss for OmniFocus is independent and is not affiliated with or endorsed by The Omni Group.
