# Explicitly authorized writes

CLI and MCP use the shared mutation core. CLI commands default to preview:

```sh
node dist/cli.js create task --input create.json
node dist/cli.js update task --input update.json --apply --request-key CALLER_KEY
```

An apply requires a caller request key and explicit apply intent. Preview returns
pinned `apply_input`; use it for optimistic apply. JSON `apply:true` alone cannot
enable CLI apply. MCP takes the same domain inputs through generic semantic verbs.
Use CLI help for the strict command grammar.

## Host authorization

The state directory defaults to the application's private mutation-state directory;
`NOFUSS_STATE_DIR` overrides it for an isolated installation. It must be owned by the
current user, a real directory with mode 0700. `mutation-authorization.json` must be
a regular non-symlink file owned by that user, mode 0600. Missing/malformed/unsafe
policy fails closed. Never place authorization or journals in a public repository.

A minimal Inbox create/update policy is:

```json
{
  "schema_version": 1,
  "scopes": ["task.create", "task.update"],
  "project_ids": [],
  "allow_inbox": true
}
```

`allow_inbox` defaults false and covers supported Inbox capture/scalar-update and the explicitly bounded ordinary restoration/conversion profiles.
Project scopes use exact `project_ids`. Other exact-object scopes use `task_ids`,
`tag_ids`, `folder_ids`, `perspective_ids`; project/tag/folder/perspective creation requires its corresponding
`allow_project_creation`, `allow_tag_creation`, `allow_folder_creation`, `allow_perspective_creation` boolean plus
operation scope. Forecast preference mutation also requires `allow_preferences:true`. None defaults true. Referenced destinations and tags resolve by exact
ID and must satisfy the operation's own authorization and eligibility checks. No
wildcard, name targeting or request-supplied authorization exists.

## Supported subsets

| Area                 | Supported scope                                                                                                                                    | Exclusions                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Task capture/scalars | Exact project, explicit Inbox or exact ordinary parent; name/note/flag/tag-set; nullable due/defer/planned dates and nonnegative integer estimates | Unsafe parents, tentative containment; Inbox recurrence/alarm edits                                      |
| Task organization    | Move to exact project/parent/Inbox; exact same-container before/after reorder                                                                      | Cross-container reorder (use move)                                                                       |
| Task lifecycle       | Ordinary leaf lifecycle; explicit bounded ordinary subtree complete/drop/duplicate/delete; verified plain repeating occurrence completion          | Unsafe repeating/automatic/tentative groups; broader generated-history forms                             |
| Projects             | Create/update/type/status/complete/drop/folder move; cascade delete and sibling reorder                                                            | Protected default holder and attachment/alarm/assignment-bearing deletion                                |
| Taxonomy             | Tag/folder create/update/hierarchy/move/reorder/delete with exact cascade/association ownership                                                    | Forecast tag deletion; broader location/permission forms                                                 |
| Review               | Separate `{unit,steps,fixed}` interval, mark-reviewed and direct next-review local day/reset                                                       | Historical review backdating                                                                             |
| Recurrence           | Daily/weekly/monthly/yearly intervals, weekly weekday sets, monthly day/ordinal selectors; local due/defer anchors; set/replace/clear              | Yearly selectors, arbitrary ICS, inherited rules, advanced repeating completion, joint date/anchor edits |
| Alarms               | Absolute and due-relative replacement/clear, integer-minute write offsets                                                                          | Defer-relative/obscure metadata; fractional write offsets                                                |
| Batch                | Bounded homogeneous task create/update/move/ordinary complete/drop/delete, complete preflight                                                      | Subtree/reorder/recurrence/project/taxonomy batches, atomic rollback                                     |

Planned dates are native-capability gated. Scheduling preserves shared native floating
semantics rather than inventing per-date flags. Local and inherited effective dates
remain separate. Recurrence anchors must already be exact local dates set in a
separate request. Existing fractional-minute alarm reads remain supported.

## Durable safety and outcomes

All references/fields validate before the first setter. Apply re-reads host policy,
coordinates cooperating writers through the existing global filesystem lock, persists
may-have-started and rechecks captured native facts immediately before setters.
UI/sync/other automation can still intervene; the lock is not a native database lock.
Independent new native facts and public exact reads must establish postconditions.
Setter acknowledgement alone is insufficient.

Outcomes are `applied`, `rejected`, `conflict`, `partial`, `unknown`. CLI uses exit 4
for denial, 5 busy, 8 unsafe journal/internal failure, 9 conflict and 10 partial/unknown
or reconciliation required; invalid input/key mismatch/unsupported cases use 2.
Same finalized key/hash reuses the durable result without setters; changed input with
the same key rejects. Unresolved requests reconcile read-only and never replay.
Missing created identity is unknown: no name/time/order inference, no new-key retry,
no stale-lock deletion. Process exit or timeout does not prove mutation stopped.

Preserve private journals, receipts and lock evidence. No transaction, rollback or
exactly-once claim is made. Development default catalog has ten reads (released beta.3 has four); authorized verbs are
limited by host policy and can be further restricted by the client.

See [Inbox/parent contract](inbox-parent-capture.md) and [CLI guide](cli.md).

Current-occurrence repeating completion is separately opt-in: `occurrence:"current"`
and host `allow_repeating_completion:true`. See [calendar recurrence](calendar-recurrence.md)
for supported single-anchor regular/plain non-floating from-completion intervals,
generated history resource, clock semantics and guards.

Development perspective mutations accept only the typed rules documented in the
perspective contract, names and all/any/none aggregation. Built-ins are immutable; missing generated
identity is unknown. See [perspectives](perspectives.md), [task hierarchy](task-hierarchy.md),
[taxonomy cascades](taxonomy-lifecycle.md) and [batch lifecycle](task-batch.md).

## Ordinary closure profile

See [ordinary operations](native-capabilities.md) for exact restoration,
conversion, Forecast/next-action preferences and direct-review schemas.
[The closure checkpoint](native-capabilities.md) lists all richer
perspective, interchange, attachment and repeating-alarm bounds.
Plain task/project note replacement requires independently captured native
`note_plain_safe:true`: no attachments, links, named styles or nondefault local
formatting. Unknown content fails closed. Preview and native dispatch both validate;
a task batch rejects in full before any setter if any note is outside that profile.
Ordinary reads remain plain text; this guard does not claim rich interchange.
