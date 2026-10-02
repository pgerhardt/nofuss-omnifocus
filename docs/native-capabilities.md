# Bounded native capabilities — beta.4

All operations use the shared core and thin CLI/MCP adapters. Reads are fresh,
bounded and live rather than snapshots. Preview is default for writes; apply needs
explicit host operation/container/object authority, durable key and pinned preconditions.
No raw script, raw archive, unrestricted file root or plug-in invocation input exists.

## Additional default reads

`nofuss_attachments` reads bounded task/project-root wrapper inventory/content;
`nofuss_location` reads exact tag location; `nofuss_sync_status` reads local sync facts;
`nofuss_export` exports selected existing containers; `nofuss_plugins` discovers
installed actions without invocation; `nofuss_preferences` reads Forecast tag and
optional exact tag next-action preference. These join get/query/overview/status.
Client allowlists may restrict the default catalog further.

## Restoration, conversion and notes

Uncomplete and undrop require ordinary local leaf state, source ownership and safe
ancestors; effective-only/repeating/history/automatic cascades reject. Undrop uses
the native scripting surface with immediate container recheck. Conversion requires
source and destination authority plus explicit project creation permission; at most
50 unfinished ordinary nodes, bounded 200-peer containers and 24,000-byte snapshot.
Project and root-task identities are observed independently, never assumed equal.
Supported child IDs/metadata/styles survive; inherited anchors, named/unreadable
styles and unsafe content reject. Lost receipts remain uncertain without blind replay.
Plain replacement, including batch, rejects existing styled/linked/embedded or
ambiguous notes rather than flattening them.

## Interchange and attachments

Imports: at most 16 KiB UTF-8, 20 nodes, depth 10 into an exact existing project.
Strict TaskPaper tab-indented tasks support flag, canonical UTC due/defer, integer
estimate and plain note continuations. OPML supports task text/note/flag/due/defer/estimate;
DTD/entities, external resolution, unsupported attributes/state/tags/repeat/project
creation reject. Boundary note whitespace rejects; interior blank lines survive.
Generated IDs, complete destination and metadata are independently read back.
Exports are bounded selected-container TaskPaper or lossy OPML; neither promises
lossless rich interchange or a library dump.

Embedded attachments: 16 KiB per regular file, 20 KiB total supported inventory,
bounded wrapper counts and serialized state. Filesystem authority is separate, with
explicit roots, canonical containment and descriptor/content rechecks. Host-controlled
directories are required; hostile ancestor-directory replacement is outside the
supported threat model. Duplicate descriptors reject; no persistent occurrence IDs.
Project attachments use independently resolved root-task storage. Directory/Link
metadata does not authorize dereferencing or mutation. No output overwrite workflow.

## Preferences, review and perspectives

Forecast set/clear needs explicit document effects permission and exact referenced
tag authority; protected native objects remain protected. Next-action writes use
exact tag authority. Review interval, mark-reviewed and direct local calendar next
review/reset are distinct operations; unrelated history is preserved. Reset follows
verified calendar anchors, not a fixed elapsed-duration guess.
Typed perspectives support verified availability/flag/group/due/tag/project-focus/
search/leaf/disabled rules and icon RGB. False native predicates may disable rather
than negate; typed negation/wrappers follow proved semantics. Unsupported atoms reject.
Stored archives alone are not filtering proof; evaluation requires the already-selected
visible window. No true headless evaluator or raw archive tunnel.

## Recurrence, location, sync and plug-ins

Typed interval/weekly/monthly/planned anchors and the recorded narrow current
completion profiles are supported. Completion uses native prediction, an explicit
instant and independently verified continuing/history IDs/dates. Seconds-based
native alarm offsets are normalized; one ordinary unsnoozed nonfloating notification
is supported only on the verified regular due-only profile. Unproved dual/inherited/
floating/catch-up/yearly-selector completion rejects.
Exact location records have bounded schemas and trigger-only clear semantics.
Sync applied means accepted dispatch, never remote completion; lost receipt is uncertain.
Plug-in discovery never invokes an action.

## Residual limits

No deletion-aware revision/tombstone feed or server-side modified-date predicate;
no lossless rich HTML bridge, unrestricted files, persistent attachment occurrence
identity, opaque plug-in invocation, raw scripts or arbitrary interacting batches.
Advanced recurrence remains deferred. No exhaustive parity claim.
