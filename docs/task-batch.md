# Whole-request task batches

Available in beta.4 with explicit host authorization. The default catalog has ten reads.

`nofuss_batch` and CLI `batch task --input FILE|-` use one shared core contract. Input: `entity: "task"`, one `action` (`create`, `update`, `move`, `complete`, `drop`, `delete`), `items` (1–20), and the usual explicit apply / durable request key. Each item has a unique caller `item_key`, scalar fields/references, and optional complete native snapshot preconditions. The scalar operation authorization and `task.batch` authorization are both required. Create/update scheduling, exact move destinations and ordinary leaf completion retain their scalar restrictions. Recurrence/alarms, subtree lifecycle, mixed actions, cross-entity batches, and references to newly created IDs are outside this initial scope.

```json
{
  "entity": "task",
  "action": "update",
  "items": [
    {
      "item_key": "first",
      "task_id": "EXACT_ID_1",
      "changes": { "flagged": true }
    },
    {
      "item_key": "second",
      "task_id": "EXACT_ID_2",
      "changes": { "estimated_minutes": 30 }
    }
  ],
  "apply": true,
  "request_key": "durable-caller-key"
}
```

Preview resolves every target/reference, validates every item, captures all optimistic snapshots, and binds the complete request meaning. Apply persists one NFO-9 request, coordinates with other processes, and marks may-have-started before dispatch. The concrete scalar task planner/reader is reused internally; no scalar command is independently applied or journaled per item.

One synchronous native script invocation preflights every item's exact references, eligibility, host scopes, destination checks and full native snapshots before its first setter. Duplicate targets, ancestor/descendant targets, and target/destination overlaps reject the entire batch. These conservative exclusions prevent interactions between earlier setters and later eligibility. Setters run in input order and stop on the first native error. The acknowledgement records dispatch accounting and generated IDs, not success.

Every item is read separately through native facts and public exact get. Finalized retries reuse the entire result. Applied/partial/conflict/rejected/unknown outcomes remain per item. A settled unattempted item may be rejected while earlier items are applied or partial; missing independent evidence remains unknown and retains coordination. A missing whole-dispatch acknowledgement never permits blind replay. No database transaction, rollback, or exactly-once behavior is claimed.

## Ordinary destructive batches — NFO-44

Homogeneous `drop` and `delete` now reuse the verified ordinary leaf scalar
contract. Both `task.batch` and the matching `task.drop`/`task.delete` scope are
required. Group/subtree, repeated tasks or automatic/repeating ancestors are
excluded; no batching of generated history, reorder, projects or taxonomy.
Task IDs and stable item keys remain explicit, 1–20 items. Native all-item scope,
ownership, eligibility and snapshot validation precedes every setter. Execution
stops on a native error and independently reads each resulting item; there is no
transaction or blanket rollback claim.
