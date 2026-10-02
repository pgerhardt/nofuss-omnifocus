# NoFuss for OmniFocus — 0.1.0-beta.4

Reviewed native-capability closure and stabilization, distributed as a GitHub
prerelease. Package remains `private:true`; no npm publication. This is bounded
supported coverage, not complete OmniFocus parity.

## Coverage

- Tasks: exact/global/project/Inbox reads; direct Inbox/project/parent capture;
  scalar/scheduling/tag updates; move/reparent/reorder; complete/drop/delete/duplicate;
  explicit subtree lifecycle; ordinary uncomplete/undrop and task-to-project conversion;
  bounded recurrence/repeating completion, absolute/due-relative alarms and homogeneous batches.
- Projects/taxonomy: project, folder and tag lifecycle, reorder and authorized cascade
  deletion; Forecast tag preference, tag allows-next-action and exact location metadata.
- Review: separate interval setting, mark-reviewed and direct local next-review date/reset.
- Perspectives: inventory, selected visible-window observation, typed custom
  create/update/delete with supported richer predicates and icon RGB color; no true headless evaluator.
- Interchange: bounded selected-project/folder TaskPaper/OPML exports and strict supported
  task imports, generated-ID readback and explicit lossiness. No inferred tag/project creation.
- Attachments: embedded files up to 16 KiB with 20 KiB total inventory; bounded
  directory/Link metadata and separate explicit filesystem authority.
- Sync: local facts and accepted-only trigger; no remote/all-device completion guarantee.
- Plug-ins: discovery only; invocation intentionally excluded.

## Safety and stabilization

Ten read tools by default. Writes require explicit host operation/object authority,
preview/apply intent and durable request keys. Whole-request validation and native
precondition recheck precede setters; independent readback establishes outcomes.
Uncertain mutations never blindly replay. No transaction/rollback/exactly-once promise.

Review corrections strengthen conversion/project receipt identity, inherited/unreadable
anchor checks, undrop container recheck, UTF-8 bounds and note preservation. Native
notes trim boundary whitespace; imports reject such notes before creation. A sparse
flagged query avoids full-library traversal without skipping predicates. Final reviewed
source passes 379 full-suite and 57 NFO-9 safety tests. Representative uncached MCP
results are mixed: four measured workflows faster than our maintained fork, small
project metadata read slower. No universal speedup or tail-latency claim.

## Limits

Advanced floating/travel/inherited/dual/catch-up recurrence and unproved yearly
selector completion remain excluded. No deletion-aware incremental change feed or
server-side modified-date predicate; no lossless rich HTML note bridge, persistent
attachment occurrence IDs, larger/unrestricted filesystem operations, true headless
perspective evaluator, remote sync completion, opaque plug-in invocation, unrestricted
raw scripts or arbitrary interacting/cross-entity batches. Plain replacement rejects
rich/ambiguous note state. Duplicate attachment descriptors reject. Boundary note
whitespace and unproved import metadata reject before creation.

Requires macOS, Node.js 22+ and OmniFocus Automation access. Native evidence covers
OmniFocus 4.9.2 (188.3), not every version/client. Previous releases remain rollback
points. See [native capability bounds](docs/native-capabilities.md) and
[safe writes](docs/safe-writes.md).
