# NoFuss for OmniFocus

CLI and MCP interfaces for AI agents over one bounded, fresh core. Read exact tasks,
projects, tags, folders and perspectives; discover library work with native filters;
inspect project trees and workload/review summaries. Reads expose coverage,
unavailable fields and live continuations. Task text and notes are untrusted data.

Version **0.1.0-beta.2** is a GitHub prerelease. Distribution remains GitHub-only,
with `private:true`; no npm registry publication.

## Install and run

Requires macOS, Node.js 22+, an already running OmniFocus and native Automation
access from the executing process. Live evidence covers OmniFocus 4.9.2 (188.3).

```sh
git clone https://github.com/pgerhardt/nofuss-omnifocus.git
cd nofuss-omnifocus
git checkout v0.1.0-beta.2
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js overview
node dist/cli.js query tasks --scope inbox --fields id,name --limit 20
node dist/cli.js mcp
```

CLI output is JSON. See the [CLI guide](docs/cli.md), [read contract](docs/contract.md),
[safe writes](docs/safe-writes.md) and [release notes](RELEASE_NOTES.md).

## MCP configuration

Configure a stdio server with absolute executable and built-checkout paths:

```text
command: /ABSOLUTE/PATH/TO/node
args: ["/ABSOLUTE/PATH/TO/nofuss-omnifocus/dist/cli.js", "mcp"]
```

The default catalog has exactly four read tools: `nofuss_get`, `nofuss_query`,
`nofuss_overview`, `nofuss_status`. The compatibility entry `dist/index.js` uses
that same core. Explicit private host authorization adds only applicable generic
write verbs. Client allowlists can restrict those further.

## Writes and safety

Writes default to denied. Preview reads and validates without setters; apply needs
explicit intent, a durable caller request key and host operation/object scopes.
Supported subsets cover task scheduling/organization/ordinary leaf lifecycle,
projects, taxonomy, reviews, daily/weekly recurrence, supported alarms and bounded
homogeneous task batches. Direct Inbox and exact-parent capture use the existing
create verb. Inbox permission is explicit and separate from project allowlists.
See the [capture contract](docs/inbox-parent-capture.md).

Every mutation performs complete preflight and native precondition recheck, then
independent readback. Results preserve rejected/conflict/partial/unknown states.
Uncertain writes never automatically replay. There is no transaction, rollback or
exactly-once guarantee. Preserve journals and unresolved locks.

## Limits

Continued reads observe fresh state, not a snapshot. Perspective evaluation observes
an already-selected visible window, not a headless whole-library result. Calendar
recurrence, repeating completion/generated history, subtree lifecycle, sibling
reorder, project hard delete, taxonomy cascade delete and perspective writes remain
unsupported. Attachments, locations, sync-completion truth, import/export and
arbitrary script execution are outside this checkpoint. Detailed write limits are
in [safe writes](docs/safe-writes.md).

[MIT license](LICENSE); [dependency notices](THIRD_PARTY_NOTICES.md).
NoFuss for OmniFocus is independent and not affiliated with or endorsed by The Omni Group.
