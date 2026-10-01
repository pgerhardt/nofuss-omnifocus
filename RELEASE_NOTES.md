# NoFuss for OmniFocus — 0.1.0-beta.3

Broad practical parity checkpoint, distributed as a GitHub prerelease. Package
remains `private:true`; there is no npm publication. This is bounded practical
coverage, not complete OmniFocus API parity.

## Coverage

- Tasks: broad discovery and exact reads; Inbox/project/parent capture; scalar and
  scheduling updates; tags; move/reparent/reorder; ordinary lifecycle and explicit
  subtree duplicate/drop/complete/delete; verified bounded calendar recurrence and
  repeating completion; absolute/due-relative alarms; homogeneous task batches.
- Projects and taxonomy: project lifecycle including reorder/delete; folder/tag
  hierarchy and lifecycle including reorder/delete, with explicit cascade and
  surviving-association authorization/readback.
- Review: review state, interval mutation and mark reviewed.
- Perspectives: inventory/get, already-selected visible-window observations, and
  bounded typed custom create/update/delete. No headless evaluation.

## Safety

Read-only/default-deny by default, with four MCP read tools. Writes require explicit
host scope and object authorization, preview/apply intent and durable request keys.
Whole-request validation and native precondition recheck precede setters;
independent readback determines applied/partial/unknown outcomes. Unknown outcomes
never blindly replay. No transaction, rollback or exactly-once guarantee is made.

Source review tightened outcome evidence and exact receipt identity, bounded
subtree deletion readback, and corrected capability reporting. Final reviewed
validation passed 327 repository tests and 56 write-safety tests.

## Deferred scope and exclusions

Deferred: floating/travel/custom/multiple-anchor advanced recurrence and history;
richer/headless perspectives; attachments; locations; true sync-completion truth;
import/export; plug-in effects; obscure history/counters/alarm edges. Repeating
completion remains restricted to the verified single-anchor subset; supported
weekly/monthly recurrence selectors do not imply custom-selector completion support.

Intentional exclusions: arbitrary JXA/OmniJS, raw native script escape hatches,
interacting/cross-entity arbitrary batches, and semantic-search/helper/template
parity for its own sake.

Requires macOS, Node.js 22+ and OmniFocus Automation access. Native evidence covers
OmniFocus 4.9.2 (188.3); it does not establish universal versions or clients.
See [safe writes](docs/safe-writes.md), [recurrence](docs/calendar-recurrence.md),
[hierarchy](docs/task-hierarchy.md), [taxonomy](docs/taxonomy-lifecycle.md),
[perspectives](docs/perspectives.md) and [batches](docs/task-batch.md).
Previous beta artifacts/tags remain rollback points.
