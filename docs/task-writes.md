# Task writes

The beta supports only task create/update/complete, with preview by default and
explicit host/project authorization for apply. See the [README](../README.md)
for the policy schema and the separate MCP client allowlist gate.

## Strict input examples

Create directly in an exact active project:

```json
{
  "project_id": "PROJECT_ID",
  "name": "Plan workshop",
  "note": "",
  "flagged": false,
  "tag_ids": []
}
```

Update an exact task:

```json
{
  "task_id": "TASK_ID",
  "changes": { "note": "Replacement note", "tag_ids": [] }
}
```

Complete an exact ordinary leaf task:

```json
{ "task_id": "TASK_ID" }
```

`entity`, if supplied, must be `task`. Unknown fields and empty updates reject.
Update fields are exactly `name`, `note`, `flagged`, `tag_ids`. Omission preserves;
empty note clears; tags replace the whole set and an empty array clears it.
All tags must resolve by exact ID; duplicates and mutually exclusive combinations
reject. Tag objects themselves are not changed. Project roots are not task targets.

Names must be nonempty, at most 512 JavaScript string units; notes at most 2,048;
tag arrays at most 20; IDs/request keys at most 256. Oversized existing fields
needed for preservation checks reject instead of relying on truncated readback.

## Preview, apply and retry

```sh
node dist/cli.js create task --input create.json
node dist/cli.js update task --input update.json
node dist/cli.js complete task --input complete.json
```

`--input -` reads stdin. Preview returns a plan, `input_hash`, `apply_input` with
captured preconditions, and `apply_input_hash`. Save the exact `apply_input` to
retain those preconditions; submitting original fields again plans from fresh facts.

```sh
node dist/cli.js update task --input apply.json --apply --request-key YOUR_DURABLE_REQUEST_KEY
```

CLI JSON `apply:true` alone cannot authorize apply. MCP uses `apply:true` plus
`request_key`. Both additionally require the current host policy. A finalized
same-key/same-input attempt returns its durable result without setters; changed
input under the same key rejects. Unresolved attempts reconcile read-only and
never automatically replay. The state directory contains private durable records;
do not delete those records or locks to force a retry.

## Outcomes and exits

| Outcome  | Meaning                                                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| applied  | All postconditions proven by separate native/core exact-ID reads after acknowledged execution |
| rejected | No setters ran; validation or authorization rejected the request                              |
| conflict | No setters ran; captured facts no longer match                                                |
| partial  | Some requested effects are independently proven, but postconditions are incomplete            |
| unknown  | Persistent identity, execution completion or final state cannot safely be established         |

Inspect the full envelope, including `reconciliation_required`, evidence and errors.
CLI exits are 0 for preview/applied, 2 for invalid input/key mismatch/unsupported
repeating completion, 4 for unauthorized, 5 for busy, 8 for journal/internal error,
9 for conflict, and 10 for partial/unknown/reconciliation required. MCP represents
rejected/conflict/partial/unknown as error results, preserving the domain envelope.

Timeout or process exit does not prove native work stopped. Lost create identity
is unknown, not permission to retry or identify a task by name/time/order. No
transaction or automatic rollback is claimed; locks coordinate NoFuss writers,
not user-interface actions or sync. Preserve uncertain evidence for independent
operator review.

## Completion restrictions

Completion requires an unfinished, effectively unfinished, non-dropped leaf task
in an active project. Repeating tasks/ancestors, groups, and ancestors configured
for automatic completion by children are unsupported before any setter. Successful
readback establishes local/effective completion and a completion timestamp while
preserving unrelated fields. A new request for an already completed task rejects.

No project, review, recurrence, attachment, location, perspective, arbitrary-script,
date, move or delete mutation is provided. Live verification is limited to
OmniFocus 4.9.2 (188.3); it does not certify every crash or concurrency scenario.
