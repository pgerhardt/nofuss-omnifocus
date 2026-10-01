# Immutable local checkpoint artifact

Product: **NoFuss for OmniFocus**. Package/repository: `nofuss-omnifocus`.
This is local packaging, not registry publication or daily activation.
Final public installation documentation remains a separate release step.

## Interfaces and permissions

- `nofuss-omnifocus ...` calls the shared core directly.
- `nofuss-omnifocus mcp` starts the four-tool MCP adapter.
- `nofuss-omnifocus-mcp` retains equivalent MCP executable behavior. It is not an
  alias for the former npm registry package name.

Node.js 22+, an already running OmniFocus, and native Automation permission are
required. Direct CLI needs that access in the spawned process/environment. In the
measured Codex read-only sandbox, MCP completed all four workflows while direct
CLI native execution failed. Both worked in ordinary host-interface tests. Use
MCP for that measured environment; interface choice elsewhere is client-dependent.
No universal CLI-first, token-saving or performance claim is made.

Retrieve complete needed data, retain/process it where supported, and display only
answer-relevant facts. Aggregate before display, retain required hierarchy rows,
and print one domain representation instead of duplicate MCP text/structured data.
Preserve errors, unavailability, coverage and continuation; reads are not snapshots.

## Isolated layout and provenance

The reviewed local layout is `RELEASE_ROOT/SOURCE_SHA/`, containing the npm payload,
its exact locked production dependency closure, and internal executable links in
`bin/`. It also contains the npm tarball, provenance, and a sorted SHA-256 file
manifest. No runtime path resolves to the development checkout. The manifest
excludes itself; hash it separately. Symlink entries record their relative target.
The release directory is made non-writable after smoke and verification.

To reproduce from the recorded clean source commit with the pinned dependency set:

1. Build in the source checkout with `npm run build`; record build metadata,
   Node/npm versions and all dependency versions. Do not upgrade dependencies.
2. Run `npm pack --ignore-scripts --pack-destination STAGING`. Repeat into a second
   staging directory and compare tarball hashes.
3. Extract the tarball into a fresh release directory. Copy exactly the installed
   production packages identified by the lockfile, including required nested/optional
   packages and their original licenses. Exclude development dependencies and do not
   create links back to the checkout. Verify installed versions against the lockfile.
4. Create internal bin links to `../dist/cli.js` and `../dist/index.js`, respectively.
   Include the tarball and provenance; hash every payload file in sorted path order.
5. Verify a second staged assembly has the same payload hashes. Inspect privacy,
   resolve dependencies solely within the release, and smoke the exact release.
   Preserve failure evidence; never overwrite a different existing release.

The npm file allowlist includes runtime `dist/`, package metadata, licenses/notices,
README, release notes and the user docs: CLI, contract, local release, safe writes and Inbox/parent capture. Development
scripts, tests, internal evidence docs and captures are excluded. Source-checkout
commands in the README are development instructions, not runtime dependencies.
Third-party notices reuse the existing locked-dependency provenance; this is not a
new comprehensive legal review.

## Client configuration

Substitute the absolute paths from the approved artifact record. For Codex MCP:

```toml
[mcp_servers.nofuss]
command = "/ABSOLUTE/PATH/TO/node"
args = ["/ABSOLUTE/RELEASE_ROOT/SOURCE_SHA/dist/cli.js", "mcp"]
enabled_tools = ["nofuss_get", "nofuss_query", "nofuss_overview", "nofuss_status"]
```

This standalone example describes a future registration; it does not replace an
existing client's restrictions. This example enables only the four read tools. Controlled write authorization is a separate explicit policy decision. Preserve
all existing restrictions on competing integrations and write/raw-script tools.
Use an absolute Node executable to avoid client PATH ambiguity. For a native-permitted
shell, run `RELEASE_ROOT/SOURCE_SHA/bin/nofuss-omnifocus doctor` with Node on PATH.
The compatibility executable starts MCP and uses the same core.

## Later activation and rollback

No configuration is changed during packaging. Before a separately approved switch,
record the exact existing registration, executable/arguments, tool restrictions and
configuration hash privately. Preserve that prior immutable artifact.

Activation changes only the reviewed executable/arguments to the new immutable
artifact. If an existing registration uses different tool names, retain its original
configuration intact and prepare a separately approved four-read-tool registration;
do not silently broaden or mechanically translate its allowlist. Rollback restores
the exact prior registration/path/arguments and restrictions, then checks its hash
and read-only status. Neither operation deletes old artifacts or starts writes.
