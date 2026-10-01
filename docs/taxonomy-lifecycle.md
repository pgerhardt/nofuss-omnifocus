# Tag and folder lifecycle writes

Shared create/update/move verbs accept `entity: "tag"` or `"folder"`. Updates
support name, plus tag status `active`, `on_hold`, `dropped`. Create/move use exact
nullable `parent_id`; null means root. Folder status, location and forecast
preference writes remain outside this contract. Verified cascade deletion and
sibling ordering are described in the NFO-42 section below.

Host policy requires the corresponding scope and exact `tag_ids` or `folder_ids`
for existing targets and referenced parents. Creation additionally requires
`allow_tag_creation` or `allow_folder_creation`. These flags default false.
Absent policy remains read-only with four MCP tools. CLI and MCP use the same core.

Whole-request reference resolution, snapshots, cycle checks and parent eligibility
complete before any setter. Self/descendant cycles and dropped ancestry reject.
Mutually exclusive tag ancestry rejects conservatively because moving into or out
of such groups can affect task associations. Every dispatch uses the existing
NFO-9 durable key/hash/locking/reconciliation boundary. Independent native facts
and public exact reads agree on identity, parent and state; preserved child IDs,
associations and forecast preference detect unintended effects. No rollback claim.

## Verified cascade deletion and exact sibling ordering — NFO-42

`project.delete`, `folder.delete`, and `tag.delete` require explicit `cascade: true`.
Every descendant folder/project/tag must be in the host allowlist; every task or
project associated with a deleted tag must also have an authorized owning project
(or exact Inbox task identity). Preview captures the complete bounded cascade and
association metadata. Apply rechecks that snapshot immediately before one native
`deleteObject` setter. Independent native and public reads prove every exact
identity absent, surviving tag associations preserved except deleted tags, and
the original direct sibling order minus the deleted target, including empty roots.

Cascade bounds are 50 containers, 100 tasks/associations, and 60 KiB facts.
Attachments, alarms and tentative assignment in deleted project tasks are excluded;
the default single-action holder and Forecast tag are protected. This is an
explicit destructive cascade contract, including completed/dropped tasks and
repeating rules; deletion does not create a next occurrence.

`project.reorder`, `folder.reorder`, and `tag.reorder` require exact same-parent
before/after peers, explicit nullable parent/folder identity, and authorization for
both objects. Project/folder peers share native mixed section order; tag peers are
tags. This changes sibling order through native `moveSections` / `moveTags`.
Native metadata and public name/container reads independently verify preservation.
Cross-container moves continue to use the existing move operations.

All six operations use the shared core, CLI and host-authorized MCP catalog, and
unchanged NFO-9 durable mutation machinery. CLI examples: `delete folder --input -`
and `reorder project --input -`. Input includes `entity` and the exact entity ID;
reorder adds `peer: {entity, id}`, `position`, and `parent_id` (folders/tags) or
`folder_id` (projects).
