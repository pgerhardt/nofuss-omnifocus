# NoFuss for OmniFocus — 0.1.0-beta.2

Post-capture parity checkpoint, distributed as a sanitized GitHub source prerelease.
Build using the [README](README.md). `private:true` remains set; no npm publication.

## Included since beta.1

- Library task filters, tag/folder inventories and hierarchy.
- Task due/defer/planned dates and estimates; exact project/parent/Inbox moves.
- Project create/metadata/type/status/complete/drop/folder move; taxonomy create,
  rename, parent move and supported tag status.
- Ordinary leaf drop/duplicate/hard delete; calendar review intervals and mark-reviewed.
- Typed daily/weekly anchored recurrence and absolute/due-relative notifications.
- Whole-request homogeneous task create/update/move/ordinary-complete batches.
- Perspective inventory/get, native custom archives and bounded selected-window reads.
- Explicit direct Inbox creation, exact ordinary project/Inbox-parent creation and
  scoped scalar/scheduling Inbox updates, including nested Inbox descendants.

Source review added a narrow guard against tentative containment on an Inbox update
or on an ancestor of an exact parent. Both planning and native apply reject before
setters. No extra product capability was added during review.

## Safety and limitations

Default MCP catalog remains four read tools. Host authorization is fail-closed;
Inbox permission defaults false and never authorizes a project. Generic write verbs
share CLI/core/MCP semantics, durable keys, locks, preconditions and independent
readback. Unknown identity stays unknown, with no automatic replay.

Requires macOS, Node.js 22+ and OmniFocus Automation access. Native evidence covers
OmniFocus 4.9.2 (188.3), not universal versions/clients. Monthly/yearly/custom/inherited
recurrence, repeating completion, subtree lifecycle, reorder, project hard delete,
taxonomy destructive operations and perspective writes remain deferred. Perspective
evaluation is visible-window observation. Attachments, locations, true sync completion,
advanced floating/history/alarm states and import/export remain outside scope.

See [safe writes](docs/safe-writes.md), [capture](docs/inbox-parent-capture.md),
[read contract](docs/contract.md) and [local artifact discipline](docs/local-release.md).
Prior alpha/beta tags and artifacts remain valid rollback points.
