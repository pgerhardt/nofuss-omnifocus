# Direct Inbox and parent capture — NFO-38

Included in the 0.1.0-beta.2 checkpoint. Writes still require explicit host authorization.

## Destinations

The existing `task.create` / CLI `create task` / MCP `nofuss_create` accept exactly one destination with a required nonempty `name`:

```json
{ "project_id": "EXACT_PROJECT_ID", "name": "Project task" }
```

```json
{ "destination": { "kind": "inbox" }, "name": "Inbox task" }
```

```json
{
  "destination": { "kind": "parent", "task_id": "EXACT_ORDINARY_TASK_ID" },
  "name": "Child task"
}
```

Missing destinations, project plus destination, unknown discriminators and extra destination properties reject before setters. Exact-project syntax and semantics remain. No names, staging project, create-then-move composition or inferred created identity are used. Native constructors are respectively `new Task(name, project)`, `new Task(name, null)` and `new Task(name, parent)` in the existing fixed synchronous operation.

Create and scalar update support `name`, `note`, `flagged`, `tag_ids`, nullable `due_at`, `defer_at`, capability-gated `planned_at`, and nullable nonnegative integer `estimated_minutes`. Existing size bounds, tag-set rules and NFO-30 scheduling validation apply. Inbox update uses an exact `task_id` and the existing `changes` object; recurrence and alarm writes are outside this extension.

## Explicit host policy

```json
{
  "schema_version": 1,
  "scopes": ["task.create", "task.update"],
  "project_ids": [],
  "allow_inbox": true
}
```

`allow_inbox` is a strict boolean, default false. It authorizes only the supported create/update operations in Inbox containment, with the corresponding operation scope. Absent, malformed, unsafe or revoked policy fails closed. Project allowlists do not authorize Inbox; Inbox permission does not authorize any project. No wildcard or request-carried permission exists. Existing policy permissions, version and exact task authorizations for unrelated lifecycle/move operations remain unchanged.

For parent capture, native containing-project facts determine authorization. Project parents require their exact authorized active project. A parent with no containing project requires `allow_inbox`. Scalar update also supports descendants of an Inbox parent under that explicit scope, and rejects tentative containment on the target or any ancestor. The existing batch machinery shares these scalar contracts and requires `task.batch` plus the scalar scope; it grants no extra permissions. Existing generic MCP verbs stay unchanged. Without policy the catalog remains four read tools.

## Eligible parents and truthful state

An exact ordinary parent may be a leaf or group, including deeper descendants, in an active project or beneath Inbox. Missing/wrong entities and project-root tasks reject. Locally/effectively completed or dropped parents, local or inherited repetition, parent or ancestor automatic completion by children, and tentative assigned containers on the parent or any ancestor reject before setters. Inactive containing projects reject. Safe inherited dates, sequential ordering and native blocked availability are allowed; availability is observed rather than promised.

Containment readback returns the real `parent_id` and `project_id` (null for Inbox containment). The existing public `in_inbox` means **direct child of Inbox**. It is false for a child beneath an Inbox parent even though its project is null. This native distinction is preserved.

Local due/defer/planned fields remain separate from effective inherited dates. A child can have null local dates and effective dates inherited from its parent. Explicit child dates use the established scheduling setters; independent native observations verify both local and effective results. Public exact-ID due/defer effective reads must agree with the native facts used by mutation readback. Effective planned date is observed in native fixture evidence; it is not added as a new public read field by this issue.

For top-level Inbox create, a reserved internal `{entity:"inbox",id:"inbox"}` reference represents the global constructor destination, not a persistent task/project ID. Its snapshot checks planned-date availability by reading an existing task (first Inbox root, otherwise first project root), never constructing a probe. An empty database or unavailable migrated getter conservatively denies the optional planned field. All references and relevant capability facts are checked again immediately before setters.

## Safety boundary

Preview performs reads only: it resolves destination/target/tags, checks eligibility and emits pinned `apply_input` / hash with complete snapshots. It creates no objects or journal/lock state. Apply validates under the existing NFO-9 lock, re-reads host policy at dispatch, and re-resolves snapshots in the native evaluation immediately before its first setter. Parent containment/eligibility, effective inherited dates, pending assignment and target fields are part of those snapshots. A moved parent or an Inbox target moved into a project cannot use stale Inbox authorization; stale preview rejects/conflicts before setter.

Successful construction must return its persistent ID, persist the receipt and pass separate native facts plus exact public core get. Parent/project placement, Inbox-root status, scalar/date fields and local/effective state are independently checked. Lost created identity/acknowledgement remains **unknown, no replay**. There is no name/time/order recovery, rollback or exactly-once claim. Durable request key/hash, finalized result reuse, key mismatch rejection, may-have-started marker, global lock, independent readback and reconciliation semantics remain NFO-9's existing implementation.

Validation uses disposable owned fixtures, separate native/public reads and exact cleanup. Private captures and journals are excluded from distribution.
