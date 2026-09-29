# Local source installation

Use the GitHub tag and source-build commands in the [README](../README.md).
Node.js 22+, macOS, a running OmniFocus and native Automation access are required.
No npm registry publication or global installation is assumed.

Use absolute paths in client configurations. A generic read-only configuration
for a client supporting this TOML form is:

```toml
[mcp_servers.nofuss]
command = "/ABSOLUTE/PATH/TO/node"
args = ["/ABSOLUTE/PATH/TO/nofuss-omnifocus/dist/cli.js", "mcp"]
enabled_tools = ["nofuss_get", "nofuss_query", "nofuss_overview", "nofuss_status"]
```

Both `dist/cli.js mcp` and compatibility `dist/index.js` expose the same default
four-read catalog. Native access can differ between shell and MCP host processes;
connectivity does not prove sync completion or universal client support.

Writes require a separate private host policy with exact project IDs and operation
scopes. To use them through a restricted MCP client, also add only the intended
`nofuss_create`, `nofuss_update`, `nofuss_complete` tools to its allowlist. Editing
that list grants no host authorization. See [task writes](task-writes.md).
Restart the host after changing startup policy/tool discovery configuration.

Before changing any existing installation, preserve its exact config and built
source revision. Keep runtime builds separate from writable journal/policy state.
Restoring an earlier config does not undo native effects; preserve durable records
and investigate unknown outcomes rather than deleting state or replaying requests.
Revoke host policy separately when disabling writes.

Source builds record their actual public Git revision, working-tree state and
source hash. No custom binary asset is required for this release. `private:true`
remains set; npm is used only to install locked dependencies and run build/tests.
