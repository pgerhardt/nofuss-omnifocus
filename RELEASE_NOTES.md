# NoFuss for OmniFocus — 0.1.0-alpha.1

First read-only alpha of the **CLI + MCP interface for AI agents**, distributed as
a GitHub source release. Build and run using the [README](README.md). No npm
registry package is published. This public repository is a sanitized release
snapshot; it does not contain the private development history.

## Included

- Two interfaces over the same verified core: direct `nofuss-omnifocus` commands
  and the stdio MCP entry `nofuss-omnifocus mcp`.
- Exact task/project reads, selected fields, Inbox and project-scoped task queries,
  project inventory, and project trees in native hierarchy order.
- Workload/review overviews and request-scoped waiting classification using explicit
  tag IDs. Task/project states, dates, notes, tags and supported notification reads.
- Bounded pagination and text/collection/tree continuation, with explicit coverage,
  errors, truncation and unavailable fields. Continuations are live, not snapshots.
- JSON CLI output and `doctor` diagnostics; MCP tools `nofuss_get`, `nofuss_query`,
  `nofuss_overview` and `nofuss_status`.
- Repository/package identity `nofuss-omnifocus`. The executable
  `nofuss-omnifocus-mcp` remains an MCP compatibility alias; the former npm registry
  name is not automatically aliased.

## Interface choice and presentation

MCP is recommended for the specifically measured Codex read-only sandbox. In one
controlled evaluation, MCP completed the tested workflows while direct CLI native
execution was unavailable. Direct CLI and MCP both returned equivalent domain facts
in host-level tests. Direct CLI remains useful in native-permitted shell environments.

No direct-CLI workflow token advantage was demonstrated. One observation per
workflow/interface does not establish general performance superiority, and failed
CLI workflows are not comparable successful completions.

Retrieve complete needed data, retain/process it deterministically, aggregate before
display where appropriate, and expose one domain representation to the model where
the client permits. Preserve every row in explicitly requested complete hierarchies.

## Safety and material limitations

Read-only: no writes, task/project mutation, raw-script tool or sync trigger.
Task text and notes are untrusted data. Connectivity does not establish sync completion.

Requires macOS, Node.js 22+ and an already running OmniFocus with Automation access.
Direct CLI native access depends on its process environment. Live behavior was
validated on OmniFocus 4.9.2 (188.3), not all runtime versions or clients.

Attachment CRUD and perspectives are unavailable. Relative notification offsets are
publicly expressed in minutes, including fractions; reads normalize native raw seconds.
Defer-relative notifications are unsupported. Rare notification states and every
repeat/date/floating edge case are not certified. See the [read contract](docs/contract.md) for exact scope.

The local runtime package passed its read-conformance and exact-artifact checks;
this source release does not broaden those guarantees or activate an installation.
The package retains `private:true`; npm is used for locked dependencies and build
scripts, not registry publication.

[MIT license](LICENSE); [third-party notices](THIRD_PARTY_NOTICES.md) preserved.
NoFuss for OmniFocus is independent and is not affiliated with or endorsed by The Omni Group.
