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

`allow_inbox` defaults false and covers only supported create/scalar-update operations.
Project scopes use exact `project_ids`. Other exact-object scopes use `task_ids`,
`tag_ids`, `folder_ids`; project/tag/folder creation requires its corresponding
`allow_project_creation`, `allow_tag_creation`, `allow_folder_creation` boolean plus
operation scope. None defaults true. Referenced destinations and tags resolve by exact
ID and must satisfy the operation's own authorization and eligibility checks. No
wildcard, name targeting or request-supplied authorization exists.

## Supported subsets

| Area                 | Supported scope                                                                                                                                    | Exclusions                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Task capture/scalars | Exact project, explicit Inbox or exact ordinary parent; name/note/flag/tag-set; nullable due/defer/planned dates and nonnegative integer estimates | Unsafe parents, tentative containment; Inbox recurrence/alarm edits                    |
| Task organization    | Move to exact project/parent/Inbox, with cycle and destination checks                                                                              | Sibling reorder                                                                        |
| Task lifecycle       | Ordinary leaf complete/drop/duplicate/hard delete                                                                                                  | Repeating/group/subtree lifecycle, generated occurrence identity                       |
| Projects             | Create, metadata, dates, type/status, complete/drop, folder/root move                                                                              | Hard delete, reorder                                                                   |
| Taxonomy             | Tag/folder create/rename/parent-root move; supported tag status                                                                                    | Delete/cascade/association removal, reorder                                            |
| Review               | Separate `{unit,steps,fixed}` interval and mark-reviewed                                                                                           | Direct next-review/history setters                                                     |
| Recurrence           | Daily/weekly rules, local due/defer anchors, regular catch-up, set/replace/clear                                                                   | Calendar/custom/planned/inherited rules, repeating completion, joint date/anchor edits |
| Alarms               | Absolute and due-relative replacement/clear, integer-minute write offsets                                                                          | Defer-relative/obscure metadata; fractional write offsets                              |
| Batch                | Bounded homogeneous task create/update/move/ordinary-complete, complete preflight                                                                  | Delete/recurrence/project/taxonomy batches, atomic rollback                            |

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
exactly-once claim is made. Default catalog remains four reads; authorized verbs are
limited by host policy and can be further restricted by the client.

See [Inbox/parent contract](inbox-parent-capture.md) and [CLI guide](cli.md).
