# Perspectives

Read perspective state and make explicitly authorized bounded typed custom perspective mutations.

Use existing `nofuss_get` with `entity: "perspective"`, or `nofuss_query` library scope. CLI equivalents: `get perspective ID` and `query perspectives --scope library`. The default MCP catalog stays four reads.

Brief fields: name, kind, identity_kind. Custom identities are exact native persistent identifiers; built-ins use explicit stable enum keys such as `builtin_inbox`, `builtin_projects`, `builtin_forecast`, and `builtin_review`. Built-in keys are not advertised as persistent database IDs or localized names. Detail adds created/modified timestamps, rule_archive, rule_aggregation and evaluation. Ordering/pagination remains created_at ascending (null first for built-ins), then exact ID, with complete projection binding and live-not-snapshot semantics. Names retain owner-bound Unicode continuation.

`rule_archive` is a read-only wrapper `{ format: "native_unversioned", application_version, rules }`. Native JSON is preserved without interpreting or executing it. Null aggregation is preserved as null; recognized non-null values are all/any/none. Built-in archives/aggregation are explicitly unavailable. Oversized archives are unavailable rather than silently truncated. No raw rule write surface exists.

`evaluation` observes only an already-selected, unique window's revealed content tree. It returns status available/no_window/not_selected/ambiguous_windows, scope visible_window, ordinary task IDs, project IDs, has_more, and native_visible_preorder. It does not switch perspectives, create/close windows, change focus, expand nodes, or infer complete rule evaluation. Window filters, focus and collapsed state may affect results. At most 100 combined identities and 2048 visited tree nodes are examined; an incomplete bound is explicit. Native content failures are field-level unavailable.

## Typed custom mutation — NFO-43

`perspective.create` requires name, rules and aggregation. `perspective.update`
accepts an exact `perspective_id` and nonempty changes to those fields;
`perspective.delete` accepts the exact ID. Built-ins cannot be mutated. CLI verbs
are `create`, `update`, `delete` with entity `perspective`; host-authorized MCP uses
the same verbs and shared core. Preview is default; apply requires a durable key.
Host policy requires the exact scope, `allow_perspective_creation` for creation,
and `perspective_ids` for update/delete. A newly created ID is never implicitly
added to the host policy.

Rules are a typed tree: `{kind:"availability",value:"remaining"|"available"|"completed"}`,
`{kind:"flagged"}`, or `{kind:"group",aggregation:"all"|"any"|"none",rules:[...]}`.
No raw archive or script fields are accepted. Maximum 10 root/child rules, 50 total
nodes and depth 4; native snapshots are bounded to 16 KiB. Other native predicates,
disabled wrappers, icons, layout and richer perspective settings are deferred.
Native archive setters normalize no supported fields in observed roundtrips.

On installed 4.9.2, `new Perspective.Custom` fails and JXA `make` of **custom
perspective** fails. JXA `defaultDocument.make` of the generic **perspective** class
succeeds and returns the persistent ID. The launcher validates all typed fields,
policy and inventory snapshots in OmniJS before this constructor, then configures
that exact returned ID in OmniJS inside the same process dispatch. Names can be
duplicated and are never used to select generated identity. Configuration failure
attempts exact owned shell rollback inside the operation; missing constructor
identity/reply remains unknown and never permits replay.

Delete uses OmniJS `deleteObject`. Looking up the same perspective in that same
invocation can throw **scheduled for deletion**, so the setter receipt avoids a
post-delete lookup. Independent later native and public reads prove absence.
Updates independently compare preserved name/archive/aggregation, and creations
verify inventory membership plus the exact returned ID. NFO-9 coordination and
may-have-started persistence remain unchanged.

The installed API exposes no headless evaluator. Visible selected-window reads
remain useful and honest; rule mutation does not switch or create user windows and
does not assert a complete task result. Richer rule/settings support remains deferred.
