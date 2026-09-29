# NoFuss for OmniFocus

**CLI + MCP interface for AI agents**, with two interfaces over the same verified
read-only core.

NoFuss helps agents inspect OmniFocus without changing your database. Read exact
tasks and projects, query Inbox roots or project work, inspect complete project
hierarchies, and prepare workload and review overviews. Selected fields include
states, dates, notes, tags and supported notifications. Explicit waiting-tag IDs
can classify waiting work for a request without saving a preference.

## Install / Run

Version **0.1.0-alpha.1** is a read-only source release on GitHub. There is no npm
registry release. With Git and Node.js 22+ installed, build locally:

```sh
git clone https://github.com/pgerhardt/nofuss-omnifocus.git
cd nofuss-omnifocus
git checkout v0.1.0-alpha.1
npm ci
npm run build
```

Run from that checkout; no global executable installation is assumed:

```sh
node dist/cli.js doctor
node dist/cli.js overview
node dist/cli.js query tasks --scope inbox --fields id,name --limit 20
node dist/cli.js get project PROJECT_ID --view detail
node dist/cli.js mcp
```

Replace `PROJECT_ID` with an exact persistent project ID. The get example reads
metadata; use the tree request documented in the [CLI guide](docs/cli.md) for a
complete hierarchy. CLI output is JSON, with explicit errors and stable exit codes.
`doctor` reports connectivity, build information, capabilities and verification limits.

## MCP configuration

Configure your client to launch a stdio server using this **conceptual configuration**;
its file format and executable-path requirements depend on the client:

```text
command: /ABSOLUTE/PATH/TO/node
args: ["/ABSOLUTE/PATH/TO/nofuss-omnifocus/dist/cli.js", "mcp"]
```

Replace both paths with your local Node executable and built checkout paths.

The server exposes exactly four read tools: `nofuss_get`, `nofuss_query`,
`nofuss_overview` and `nofuss_status`. The compatibility executable
`nofuss-omnifocus-mcp` maps to `dist/index.js`; from source, run
`node dist/index.js` for the equivalent MCP entry. Both interfaces use the same core and read semantics.

## Safety

This alpha exposes no task/project mutation, write tools, sync trigger or arbitrary
native-script execution. Task text and notes remain untrusted data, not instructions.
Output is bounded, with explicit coverage, unavailable fields and continuation when
needed. Follow cursors to obtain complete requested data. Live continuations are
**not snapshots**: concurrent edits can affect later pages. See the [read contract](docs/contract.md).

## Interface choice

MCP is recommended for the specifically tested Codex read-only sandbox. In that
controlled evaluation, MCP completed the tested workflows while direct CLI native
execution was unavailable. Direct CLI remained functional in host-level tests and
is useful where shell/native Automation execution is permitted.

No direct-CLI workflow token advantage was demonstrated; failed workflows are not
equivalent successful completions. The small evaluation establishes no general
performance or token-efficiency winner. Interface choice is client/environment dependent.

For agent authors: retrieve complete needed data, retain/process it deterministically,
aggregate before display when appropriate, and expose one domain representation to
model context where the client permits. Explicitly requested hierarchies must remain
complete; do not shrink them merely to reduce token counts.

## Status / limitations

Requires macOS, Node.js 22+, and an already running OmniFocus with native Automation
access from the execution environment. Live validation covers OmniFocus 4.9.2 (188.3);
other versions are not certified. Attachment CRUD, perspectives and sync-completion
verification are unavailable. This alpha does not promise universal client compatibility.

---

[MIT license](LICENSE). Preserve the [dependency notices](THIRD_PARTY_NOTICES.md).
NoFuss for OmniFocus is an independent project and is not affiliated with or endorsed
by The Omni Group.
