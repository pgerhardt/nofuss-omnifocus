# Ordinary task hierarchy lifecycle and ordering

Existing leaf operations retain their default contract. Explicit `subtree:true` on
`duplicate`, `delete`, `drop`, or ordinary `complete task` operates on a bounded
ordinary tree (at most 50 tasks and 60 KiB per native snapshot). Groups, descendants
and ancestors must have no recurrence, automatic completion or tentative assignment.
Attachments/alarms remain excluded. Duplicate/drop/complete require unfinished,
effectively ordinary work. Completion changes the group locally and its descendants
effectively; it does not mark each child locally complete. Drop follows the same
local-versus-effective distinction. Delete proves every original descendant absent
and checks the exact remaining direct sibling membership/order.

Host authorization requires the existing operation scope and containing project ID,
or every exact subtree task ID for Inbox trees. Caller subtree intent is mandatory;
project-root tasks are not ordinary task targets. NFO-9 request hash/key, durability,
apply-time exact recheck and independent readback remain unchanged.

Native duplication returns the root object. Traversing that returned object's child
references records every generated persistent ID. Independent reads later resolve
those exact IDs and verify content/topology; IDs are never inferred by name, order,
clock proximity or synthesized source/clone correspondence. Missing generated
identities remain unknown with no replay. Preserved supported metadata includes
names, notes, flags, tags, scheduling, estimates, sequential/automatic flags and
floating state. Native creation timestamps are new, not copied promises.

`reorder task` / MCP `nofuss_reorder` accepts exact `task_id`,
`container:{kind:"project",project_id}` / `{kind:"parent",task_id}` /
`{kind:"inbox"}`, `position:"before"|"after"`, and `peer_id`. Target and peer
must be distinct direct siblings in the declared container. It preserves containment
and subtree identities; changing containers remains `move`. Ordering is predicted
from native sibling IDs and independently re-read through the target and container.
A stale sibling/container snapshot conflicts before the setter. No numeric-index DSL.

OmniJS handles bounded traversal, `duplicateTasks`, `deleteObject`, group lifecycle
and `moveTasks` before/after locations. Public reads are independently batched in
windows of 20 exact IDs. CLI and MCP are thin shared-core routes.

The supported native behavior was verified on OmniFocus 4.9.2 (188.3). Project-root
container identification is explicit, independent of whether project and root-task
identifiers happen to match. Deletion readback uses bounded exact-ID absence and
direct-container order projections without traversing the surviving parent's tree.
