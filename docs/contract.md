# NoFuss for OmniFocus contract v1

The same read contract is available through the [direct CLI](cli.md) and MCP.
The core owns validation, native orchestration and domain packing; adapters own
encoding and transport errors.

This slice registers `nofuss_get`, `nofuss_query`, `nofuss_overview` and
`nofuss_status`. It is an OmniFocus integration. No writes, sync triggers,
attachments, perspectives or recurrence are implemented.

## Inputs

- `nofuss_get`: `{entity?: "task"|"project", ids: string[1..20], view?: "brief"|"detail", fields?: Field[],
text?: {field:"name"|"note", offset?:integer, length?:integer, cursor?:string},
collection?: {field:"tag_ids"|"notifications", limit?:integer, cursor?:string}, tree?: {view?, fields?, limit?, cursor?}}`.
  Entity defaults to `task`. IDs are exact persistent identifiers, including dots.
  Results retain input order and duplicates. For task gets, a project-root ID returns `PROJECT_ROOT_EXCLUDED`;
  it is never presented as an ordinary task. Unknown IDs return `not_found`.
- `nofuss_query`: `{entity:"task", scope:"inbox_roots", include_completed?:boolean,
sort?:"created_at", limit?:integer, cursor?:string, view?, fields?}`.
  Default page size 25, maximum 200. `include_completed` defaults to false.
  Project scope uses the same options with `scope:"project"`, a required exact
  `project_id`, and optional `depth:"direct"|"descendants"` (default descendants).
  `project_id` and `depth` are rejected for Inbox scope.
  Project inventories use `{entity:"project",scope:"library",status?,flagged?,view?,fields?,limit?,cursor?,sort?:"created_at"}`.
  Task-only options are rejected for inventories, and project filters for task queries.
- `nofuss_overview`: `{waiting_tag_ids?: string[1..20]}`. Returns full-scope
  Inbox/active-project counts and a compact project list with review/work
  classifications. Optional exact tag IDs explicitly configure waiting for this
  request only. No projections or pagination arguments; see workload overview below.
- `nofuss_status`: `{}`. Returns build version/source revision/hash/dirty state,
  observed native app/build, connectivity, worker state, implemented capabilities,
  narrow installed-declaration support and separate build-bound verification/gaps.

Unknown properties, entities, scopes, sort values and selected fields fail.
There is no name search, raw script, custom expression or silently ignored input.

## Workload overview

Call `nofuss_overview` with `{}` to answer: what is unfinished in the Inbox,
which projects are active, which need review, and which have remaining work but
no available action? Each project appears once, carrying both classifications.
No notes, notifications, historical dates or full task records are returned.
This is a fixed workflow scope, not a second query language.

Definitions:

- **Unfinished Inbox roots:** the native `inbox` collection, with local
  `active === true` and `completed === false`, exactly as the existing default
  Inbox query. Nested Inbox children are not counted. Deferred/blocked roots
  still count; unfinished does not imply available.
- **Active projects:** native `Project.status === Project.Status.Active` in
  `flattenedProjects`, including root-level projects and every folder depth,
  even below inactive folders. Folder effective state is not another filter.
  On-hold, done and dropped projects are excluded. Project identity remains a
  project ID, not a task row.
- **Remaining work:** at least one descendant task whose native `Task.Status`
  is neither `Completed` nor `Dropped`. This uses native effective state,
  unlike the local completion/drop filters of `nofuss_query`. Task groups are
  included, project roots excluded. No ancestor-based pruning is performed.
  Deferred, sequentially blocked or on-hold-tagged descendants remain work.
- **Available action:** at least one descendant, including a group when its
  own native status qualifies, with status `Available`, `Next`, `DueSoon` or
  `Overdue`. A blocked group alone does not qualify; its descendants are still
  inspected. This is an existence predicate, not a direct-child, leaf or
  numeric availability count. The scan can stop once existence is proven.
- **Review due:** the native `nextReviewDate` is non-null and less than or equal
  to the single `evaluated_at` instant captured at operation start. Null means
  unscheduled and `review_due:false`; a failed read is unavailable. No extra
  age, review-interval or last-review heuristic is applied.

`work_state` is `available_action`, `remaining_without_available_action`, or
`no_remaining_work`. Zero available actions alone is not a problem: the second
state requires remaining work too. It describes a native condition, not personal
importance, commitment, abandonment or a recommendation to delete a project.
Waiting is separately opt-in (`overview_waiting:true`); see explicit waiting
below. No tag-name or blocked-task heuristic is used.

The list is ordered by persistent project ID ascending (ASCII comparison), not
priority, creation date or native tree order. Existing query/tree ordering is
unchanged. Counts cover the full scope independently of list coverage.
`coverage.complete` describes membership coverage, not successful classification
of every field. Unknown/unreadable project membership fails the operation.
An unreadable Inbox count is null with `unavailable.inbox_unfinished`. If any
active project's review or work classification fails, its fact is omitted with
row-level `unavailable`, and the corresponding aggregate count is null with
an explanation; partial counts are never substituted for full counts or zero.

One coherent native operation reads the Inbox, project membership, review dates
and descendant statuses. It uses the shared project name/text mapper and stops
reading task statuses once availability is established when waiting is omitted.
Configured waiting continues through every descendant required for its count. It does not consume
public query/get pages, serialize trees or use the gated native availability
counter. `evaluated_at` is the common review comparison time; `consistency:"live"`
does not promise transactional snapshot isolation or freeze native task statuses.

Synthetic structured response (MCP also carries its JSON text counterpart):

```json
{
  "scope": "inbox_roots_and_active_projects",
  "evaluated_at": "2026-09-28T12:00:00.000Z",
  "consistency": "live",
  "counts": {
    "inbox_unfinished": 7,
    "active_projects": 2,
    "review_due": 1,
    "remaining_without_available_action": 1
  },
  "projects": [
    {
      "id": "project-a",
      "name": "Prepare workshop",
      "next_review_at": "2026-09-27T12:00:00.000Z",
      "review_due": true,
      "work_state": "available_action"
    },
    {
      "id": "project-b",
      "name": "Deferred home work",
      "next_review_at": null,
      "review_due": false,
      "work_state": "remaining_without_available_action"
    }
  ],
  "coverage": { "returned": 2, "complete": true, "reason": "complete" }
}
```

There is no default 25-project preview. The existing 65,536-byte complete MCP
safety bound includes structured content, its escaped text copy, counts and
coverage. A separate 60,000-byte native compact-list bound protects transport;
all projects still contribute to counts after list serialization stops. The
service then fits the actual duplicated MCP response by removing trailing
project rows. If necessary, `coverage.complete:false`, `reason:"response_bytes"`
and `drilldown:"nofuss_query active library; nofuss_get project tree"` explain
incomplete list coverage. There is no overview cursor or hidden result cache.
The safety limit is not a target response size. Empty scopes succeed with zero
counts and a complete empty list. Names retain normal bounded text windows and
exact-get continuation, with explicit `truncated` metadata.

For drilldown, use exact project metadata or a project tree. If the overview list
cannot fit, enumerate it through existing project-query continuation:

```json
{
  "entity": "project",
  "scope": "library",
  "status": "active",
  "fields": ["name", "next_review_at"],
  "limit": 200
}
```

Follow that query's `next_cursor` until complete. For a project's work evidence:

```json
{
  "entity": "project",
  "ids": ["project-a"],
  "fields": ["name"],
  "tree": { "fields": ["name", "status"], "limit": 200 }
}
```

Follow `tree.next_cursor` when needed. Trees include completed/dropped descendants;
filtered task queries cannot serve as a full-tree classification oracle. New
reads may observe changes, so reconstructing a budget-limited overview through
these primitives is not a snapshot of the earlier counts.

The native available-child counter remains gated. A narrow grouped-project check
found eight direct children (six available status rows and two blocked groups),
sixteen available descendant leaves, and a blocked project root. The native
counter was eight; each blocked group contained available children. This rules
out root inclusion and a full descendant-status count as explanations for that
case, but does not establish a universal counter definition. The overview uses
the independently checked descendant-status predicate instead.

### Explicit waiting

The caller defines waiting by supplying exact persistent tag IDs:

```json
{ "waiting_tag_ids": ["tag-wait", "tag-followup", "tag-wait"] }
```

The input accepts 1–20 IDs before deduplication. IDs are deduplicated and returned
in ASCII order. Every ID must resolve through `Tag.byIdentifier` before any
aggregation: missing IDs produce `TAG_NOT_FOUND`, known task/project/folder IDs
produce `WRONG_ENTITY`, and unreadable/mismatched identities fail explicitly.
An empty array is invalid; omit the option to leave waiting unconfigured.
No settings persist. `{}` retains its previous response shape and reads no tags:
absent `waiting` and project `waiting_count` mean **not requested**, never zero.

The rule is **match any** selected ID in the task's native `Task.tags` association
list, the same source as exact-get `tag_ids`. It does not union parent-task or
project tags, expand tag descendants, match names, or infer waiting from blocked,
on-hold or aged work. This is native per-task association, not a claim about
whether a user originally assigned, copied or inherited a tag. Native examples
with parent tags absent from child lists confirm these scopes are distinct.

Eligible items are the existing overview's locally unfinished Inbox **roots**
plus remaining descendants of native-active projects. Inbox eligibility uses
local active/not-completed state. Project eligibility uses effective native
Task.Status, excluding Completed/Dropped; no ancestor-based pruning occurs.
Qualifying groups count as one item, alongside qualifying descendants. Project
roots and nested Inbox children never count. This is not all tasks in the
library: on-hold, done and dropped projects are outside scope. Tag status does
not add another eligibility filter.

A task matching several supplied tags counts once. Waiting and availability are
independent: tagged Available/Next/DueSoon/Overdue tasks can be waiting, and their
projects retain `work_state:"available_action"`. A project containing waiting
items is not automatically classified as having no available action.

Configured output adds `waiting_count` to each existing project row and a single
`waiting` object. Its `count` covers both scoped sources, `inbox_count` covers
eligible Inbox roots, and `items` contains only task IDs and owning project IDs
(null for Inbox). No full project records are duplicated. For example, with one
match in `project-a`, none in `project-b`, and one in the Inbox, the existing
project rows gain `waiting_count:1` and `waiting_count:0`, and the response gains
this synthetic fragment (core counts and other fields remain present):

```json
{
  "waiting": {
    "tag_ids": ["tag-followup", "tag-wait"],
    "count": 2,
    "inbox_count": 1,
    "items": [
      { "id": "inbox-task-a", "project_id": null },
      { "id": "project-task-b", "project_id": "project-a" }
    ],
    "coverage": { "returned": 2, "complete": true, "reason": "complete" }
  }
}
```

Item order is native Inbox-root order, then active projects in ID order, with
matches within each project in native descendant order. This is live traversal,
not a priority ranking or snapshot. A configured empty match set has count zero,
empty items and complete coverage. Omitted configuration has no waiting object.

A tag/eligibility/association read failure never becomes a nonmatch. The affected
project's `waiting_count` is omitted with row-level `unavailable`; an affected
Inbox count is null with `waiting.unavailable.inbox_count`. The total is null
with `waiting.unavailable.count`, and waiting coverage is incomplete with
`reason:"unavailable"`. Independently verified matches may still be listed.
Other project counts and core classifications remain usable. Extra waiting reads
cannot invalidate availability already proven by the existing short-circuit rule.

Counts remain complete even when match IDs or project rows cannot all fit.
Each native list has a 60,000-byte serialization bound within the unchanged native
transport cap. The existing 65,536-byte complete MCP limit then trims trailing
waiting IDs before core project rows, preserving useful per-project counts.
`waiting.coverage` independently reports returned IDs and completeness; byte-limited
coverage uses `reason:"response_bytes"`. Unavailability takes precedence if both
conditions apply. No cursor, preview item limit, result cache or new pagination
framework is added. Incomplete waiting coverage includes this drilldown hint:
`nofuss_query Inbox roots and active library; nofuss_get project trees with status/tag_ids`.

To retrieve omitted matches using existing tools:

1. Query eligible Inbox roots with
   `{"entity":"task","scope":"inbox_roots","fields":["name","tag_ids"],"limit":200}`;
   follow query continuation to completion.
2. Use complete overview project rows and their waiting counts to choose project
   inspections. If project coverage is incomplete, enumerate active projects with
   `{"entity":"project","scope":"library","status":"active","fields":["name"],"limit":200}`,
   following its continuation. Do not skip an unavailable waiting count as zero.
3. Get each needed project's tree with
   `{"entity":"project","ids":["project-a"],"fields":["name"],"tree":{"fields":["name","status","tag_ids"],"limit":200}}`.
   Follow tree continuation and exclude Completed/Dropped task statuses for waiting.
4. Match any selected tag ID locally against complete `tag_ids`. If a tag list is
   truncated, use its exact-get collection continuation before declaring a nonmatch.
   Listed task IDs can be inspected directly with `nofuss_get`.

These fresh reads can observe changes; they do not reconstruct a transactional
snapshot of the previous overview.

### Review-preparation workflow

Start with `nofuss_overview {}`. Use its complete project set, `review_due` and
`work_state` to identify review candidates and separate available work, remaining
work without an available action, and no remaining work. If coverage is incomplete
or a required count/fact is unavailable, resolve that gap before claiming a full
candidate set.

Inspect a candidate with exact project metadata and a native-order tree in one
`nofuss_get`, choosing relevant task fields and following continuation only when
needed. To add waiting evidence, explicitly supply the caller's chosen tag IDs
in another overview request, then inspect a matching task ID with exact get (or
reuse a complete earlier tree containing it). This prepares facts for a review;
it does not rank personal commitments or decide priorities.

## Exact project metadata

`nofuss_get` with `entity:"project"` resolves each ID using `Project.byIdentifier`.
All existing project states are eligible, including on-hold, completed and dropped
projects; exact reads have no list filters. A missing ID has `status:"not_found"`
and error code `NOT_FOUND`. An ordinary task ID has `status:"error"` and
`WRONG_ENTITY`. Neither case substitutes a name match or task record. Results keep
the same batch envelope, limits, ordering and duplicates, with a `project` member
in each successful result; task calls retain their existing `task` member.

The project brief fields are `id`, `name`, `status`, `type`, and `folder_id`.
Status uses `active`, `on_hold`, `done`, `dropped`. Type uses `parallel`,
`sequential`, `single_actions`; the native single-action-holder flag takes
precedence over sequential. `folder_id` identifies the immediate containing folder,
or is null for a project at the library root; no folder ancestry is fabricated.

Project detail adds `note`, `tag_ids`, `due_at`, `defer_at`, `effective_due_at`,
`effective_defer_at`, `created_at`, `modified_at`, `completed_at`, `dropped_at`,
`floating_time_zone`, `direct_task_count`, `direct_completed_task_count`,
`last_review_at`, `next_review_at`, and
`review_interval`. `planned_at` is opt-in as for tasks. Project `flagged` is also an explicit selection
(native local `Project.flagged`); existing brief/detail field sets are unchanged. Selected fields override the
view; unsupported or other-entity fields reject before native reads. `fields:[]`
returns IDs only. Project name/note support the same exact-ID Unicode text windows.

Dates retain native milliseconds and UTC ISO serialization. Creation/modification
come from the project root task; completion/drop, due/defer, effective dates and
review dates use their distinct native properties. `floating_time_zone` is the one
shared native state, not independent per-date flags. Notes use `noteText.string`;
tag IDs retain native order. Root-task content is project metadata here, never an
ordinary task result or a child record.

Counters are the native scripting `numberOfTasks` and `numberOfCompletedTasks`:
**direct children only**, including groups as one child
and excluding the project root. Total includes all local states; completed counts
local completion. These counters are
not descendant counts and are not calculated from task-query pages. Descendant
counts, availability counts
and writes are deferred. The native available-child counter can differ from counting
direct tasks whose `available` field is true; it is not exposed by this contract.

`review_interval` is `{unit,steps,fixed}`. Units are `minutes`, `hours`, `days`,
`weeks`, `months`, `years`; steps are a positive integer. The native scripting
review record preserves the boolean fixed-calendar/sliding state. Months/years
remain calendar units; no day approximation is made. An unknown unit, missing
fixed value or failed review read makes the entire selected `review_interval`
explicitly unavailable. It never invents a fixed flag or empty interval.

Project metadata uses the same bounded OmniJS operation and projection serializer
as task reads. Only selected counters/review require a narrow scripting supplement
in that request's launcher, resolving requested project IDs directly. Supplements
are keyed and checked by persistent ID, read once per unique ID within the request,
and never cached across requests. Neither full property records nor child task
collections are read to construct metadata. Brief reads require no supplement.
Supplement and OmniJS reads are sequential fresh observations, not one atomic
snapshot; concurrent external edits may affect their consistency. Failed selected
supplements affect only those fields, with explicit unavailable reasons.

Synthetic request and structured response example (the MCP result also includes
the serialized text counterpart):

```json
{ "entity": "project", "ids": ["example-project"], "view": "brief" }
```

```json
{
  "results": [
    {
      "id": "example-project",
      "status": "ok",
      "project": {
        "id": "example-project",
        "name": "Workshop shelves",
        "status": "active",
        "type": "parallel",
        "folder_id": null
      }
    }
  ],
  "read_at": "2026-09-28T04:00:00.123Z"
}
```

The strict project schema reuses task field definitions and shared schema references
for timestamps and unavailable/truncation metadata. Each successful per-ID outcome must contain
exactly one matching entity record; failures contain an explicit error. Input and
output validation are retained on the server and exercised with the direct SDK
client, including its advertised JSON Schema references.

## Project inventories and filters

`nofuss_query` with `entity:"project", scope:"library"` discovers native projects
without known IDs. It reads `flattenedProjects`: library-root projects and projects
at every depth of folders, including projects in inactive/dropped folders. Folder
state does not impose an additional filter. Folder objects, Inbox items and project
root tasks are not returned as projects. Exact gets remain unfiltered.

Omitted `status` includes `active`, `on_hold`, `done` and `dropped`. Explicit status
matches native `Project.status`, not task completion, effective ancestor state or
availability. Omitted `flagged` means no flag filter; both `true` and `false` are
meaningful tests of local native `Project.flagged`. Combined predicates use AND.
There are no implicit due-date, age, availability or task-count predicates. A failed
predicate or sort-key read fails the page; unreadable projects are never silently
excluded from a successful complete inventory. Predicates short-circuit after a
known nonmatch, before full serialization.

```json
{
  "entity": "project",
  "scope": "library",
  "status": "active",
  "flagged": false,
  "view": "brief",
  "limit": 25
}
```

Omit both filters for the full inventory. The response uses the existing query
page envelope (`items`, `returned`, `has_more`, `next_cursor`, `read_at`,
`consistency:"live"`, `stop_reason`); `items` are the same project records used by
exact gets. Brief/detail, selected fields, unavailable/truncated text and exact-ID
text retrieval retain their existing definitions. Unsupported task fields such as
`notifications` reject for projects; no task serializer is substituted. `flagged`
may be selected explicitly, independently of whether it is used as a filter.

Ordering is `(project.task.added, project ID)` ascending with full millisecond
precision, null dates first and ASCII ID tie-breaking. This is query ordering, not
native tree/sibling ordering. Default limit 25, maximum 200. Cursors bind entity,
library scope, optional status/flag filters (false differs from omitted), sort,
view, normalized fields and limit. Existing task-query cursor bindings remain
unchanged. Inventory error results carry explicit error text with `isError:true`,
without a fabricated successful page or an invalid structured page envelope.

Brief and selections without counter/review supplements use one coherent in-app
OmniJS query. With supplements selected, the launcher first filters/orders projects
and prepares a byte-bounded base page using the shared mapper. It then reads only
requested scalar columns for those IDs and finishes the prepared records with the
same mapper in a second OmniJS evaluation. Output-only fields already read during
preparation are reused within this request. Counts use native `numberOfTasks` and
`numberOfCompletedTasks`, never a task-child traversal. Review retains unit/steps/fixed.

The final page can be smaller after adding supplements or enforcing the complete
MCP byte budget; some prepared records/supplements can therefore be lookaheads.
There is no fixed estimate of row size or change to the caller's item limit. Each
subsequent page enumerates and orders the live project collection again; small
browse pages trade complete-traversal latency for small individual responses.

Supplement vectors use the same exact-ID-bounded native collection, with its IDs
checked before reading and again after each column. Missing/duplicate IDs, changed
ID order, length mismatches or failed column reads make the affected selected fields
explicitly unavailable. Rows cross the JXA/OmniJS boundary keyed by persistent ID;
independent native collections are never joined by position. No full property-record
or per-project external getter loop is used for inventories. Exact metadata gets
retain their existing narrow supplement path.

Selection, vector reads and serialization are sequential live observations, not a
snapshot or transaction. Prepared projects are resolved by ID and their predicate
and sort key rechecked before completing their records; detected changes fail with
`INVENTORY_CHANGED`. Between pages, external edits may move records across cursors.
Continue unchanged arguments until `has_more:false`; byte-bound pages use the
existing 65536-byte complete MCP result limit. There is no result cache, database
mirror, inventory total or promise of atomic traversal.

## Bounded project trees

Add `tree:{view:"brief",limit:25}` to an exact project get. Tree mode requires
`entity:"project"` and exactly one ID, rejecting task and multi-ID tree requests
before native execution. Ordinary metadata batches keep their existing behavior.
Top-level `view`, `fields` and `text` still select project metadata. Under `tree`,
`view` independently defaults to brief, `fields` uses the same task field definitions,
and `limit` defaults to 25 (maximum 200). Unknown tree options reject.

Every descendant is eligible, including task groups, locally completed/dropped work,
and descendants of completed, dropped or on-hold ancestors. There is no availability
filter, ancestor pruning or hierarchy-depth cutoff. Local/effective state mappings
are unchanged; both default views retain those distinct facts. The root is returned
as project metadata, never duplicated as a task. `root_id` identifies its native task
identity. An empty project returns a successful complete tree with `items:[]`.

A successful per-ID result adds one flat `tree` collection:

```json
{
  "id": "example-project",
  "status": "ok",
  "project": { "id": "example-project" },
  "tree": {
    "root_id": "example-project",
    "items": [
      {
        "id": "example-group",
        "parent_id": "example-project",
        "project_id": "example-project"
      }
    ],
    "returned": 1,
    "has_more": true,
    "next_cursor": "<opaque continuation>",
    "order": "native_preorder_v1",
    "consistency": "live",
    "stop_reason": "page_limit"
  }
}
```

This example selects `fields:[]` for both projections and a tree limit of one.
Every tree row always contains `id`, nonnull `parent_id` and `project_id`, even with
`tree.fields:[]`; other task fields obey the existing projection and field-state
rules. Failed mandatory structural reads fail the tree rather than fabricate edges.
A direct child's parent is `root_id`; other parents are task IDs. The complete
traversal reconstructs the hierarchy. Parents can appear on earlier pages and are
not copied onto later pages. Only project metadata is repeated on every page.

`native_preorder_v1` is depth-first, parent-before-child preorder of `Project.tasks`
and each descendant's native `Task.tasks` sibling collection. An iterative walk
preserves native ordering, including sequential projects, without sorting by
creation date. Query ordering/filtering remain unchanged. Each page is one coherent
in-app walk; only page candidates use the shared task serializer (byte boundaries
may require serializing the next candidate to measure it). Cursor prefixes read
structure only, with no per-node external calls or persistent cache.

Continue by putting `tree.next_cursor` into `tree.cursor`, keeping other arguments
unchanged, until `tree.has_more:false` and `next_cursor:null`. Continuations share the
existing version/checksum/strict decoding machinery. They bind the exact project ID,
traversal version, normalized task view/field set/page size, and project projection
and text/collection window options. Query and tree cursors cannot cross operations. Malformed/mismatched
cursors fail before native execution. A missing/wrong-entity project has the same
per-ID `NOT_FOUND`/`WRONG_ENTITY` outcome as metadata gets.

The anchor is the last returned task ID. Each fresh page walks the current structure
up to that ID, then continues after it, including its children. If the anchor is no
longer in the project, `CURSOR_STALE` requires restarting; it is never treated as a
successful empty ending. This is live traversal, not snapshot isolation: external
insertions, moves and sibling reordering can change membership/order between pages,
including skipping new nodes before an anchor or revisiting moved nodes. Unchanged
data traverses each descendant once. There is no snapshot cache or exact total.

The existing 65536-byte complete MCP response budget also covers project metadata,
tree nodes, continuation and the text counterpart. Tree pages yield at node
boundaries with `stop_reason:"response_bytes"`; the item limit yields `page_limit`.
No partial page claims to be complete. If metadata plus one node cannot fit, an
explicit `RESPONSE_LIMIT` asks for narrower fields rather than an empty unfinished
page. Selected/empty/unavailable/truncated distinctions are unchanged. Brief trees
read neither notes nor notifications. To continue a task's truncated field, use its
ordinary exact task get with `text`; top-level tree-request text belongs only to the
project. Selected project metadata supplements retain their existing narrow native
reads and freshness caveat.

## Selection and field states

Unfinished means **locally incomplete and undropped**. It does not mean available.
`include_completed:true` relaxes local completion only; dropped roots remain
excluded. Inbox query membership comes from the native `inbox` root collection, never
global tasks or flattened Inbox descendants. Exact gets can return tasks outside
the Inbox, including nested descendants. Native `inInbox` is true only for roots.

Project scope resolves `Project.byIdentifier(project_id)` exactly. A missing ID
or an ID belonging to an ordinary task returns the tool error `PROJECT_NOT_FOUND`,
never an empty successful query or a name match. `depth:"direct"` reads native
`Project.tasks`; `depth:"descendants"` reads `Project.flattenedTasks`, including
all nesting levels. Both native collections exclude the project's root task.
Nested task groups are ordinary flat records with `parent_id` and `project_id`,
not recursive tree output; sorting can place a descendant before its parent.

Each candidate independently passes the same **local** completion/drop filter.
Locally completed and locally dropped descendants are excluded by default.
`include_completed:true` admits locally completed tasks but still excludes locally
dropped tasks. A locally unfinished descendant under a completed/dropped ancestor
(including the project itself) can remain in the results while its effective state
and availability explain why it is not actionable. Filtering a group does not prune
its descendants. A parent ID can therefore refer to a filtered or unreturned row.
Project status is not an additional implicit filter. Project queries remain filtered
lists, distinct from structural tree inspection; exact task gets are unchanged.

Every task record retains `id`. The default brief view adds `name`, `project_id`,
`parent_id`, `in_inbox`, `completed`, `dropped`, `effective_completed`,
`effective_dropped`, `available`, `blocked`, `flagged`, and `status`.

The detail view adds `note`, `tag_ids`, `due_at`, `defer_at`, `effective_due_at`,
`effective_defer_at`, `created_at`, `modified_at`, `completed_at`, `dropped_at`,
`estimated_minutes`, `sequential`, `completed_by_children`, `floating_time_zone`,
and `notifications`. `planned_at` is an additional explicit selection, since its
native availability depends on database migration. `fields` overrides the view;
`fields:[]` returns IDs only. The complete typed schemas are in `src/contract.ts`
and the MCP tool catalog; no unsupported field is advertised as implemented.

Unselected fields are absent. Empty notes are `""`; empty collections are `[]`;
absent dates, ownership and estimates are `null`. False and zero are preserved.
A failed selected read omits the value and includes
`unavailable[field]: {code,reason}`. It never becomes a successful empty value.
A failed selection fails the operation, since membership can no longer be trusted.

Notes use native `noteText.string`, preserving plain display text, Unicode and
attachment placeholders. They are untrusted content. Default windows are 512 Unicode
code points for names and 2048 for notes. `text` on one exact get selects a field
and an optional `length` (1–2048, default 2048 for a new explicit window).
Existing numeric `offset` calls remain supported; offset and cursor are exclusive.
Omitting both starts at zero. Numeric offsets are direct positions, not bound tokens.

`tag_ids` and task `notifications` retain native element order. They return at most
100 elements by default; `collection` on one exact get selects the field and an
optional `limit` (1–200). Projects support `tag_ids`, not notifications. The named
field must be selected by `fields` or the chosen view. Ordinary batches remain
supported; targeted field windows require exactly one owner ID. Collection values
are mapped only for the window, with at most one byte-boundary lookahead element.

A partial field retains its value and adds:

```json
{
  "truncated": {
    "tag_ids": {
      "offset": 0,
      "returned": 100,
      "total": 250,
      "next_offset": 100,
      "reason": "collection_window",
      "next_cursor": "<opaque field continuation>"
    }
  }
}
```

Text uses `reason:"text_window"` and code-point offsets; collections use element
offsets. Byte/record bounds may shorten a requested window. Readable fields remain
present with truthful truncation, rather than being removed or replaced by empty
values. Field and record continuations are independent: an oversized collection
does not prevent a query/tree cursor from advancing to the next record.

A field cursor returned by any get/query/tree can be continued through `nofuss_get`:

```json
{
  "ids": ["example-task"],
  "fields": ["notifications"],
  "collection": { "field": "notifications", "cursor": "<next_cursor>" }
}
```

```json
{
  "entity": "project",
  "ids": ["example-project"],
  "fields": ["note"],
  "text": { "field": "note", "cursor": "<next_cursor>" }
}
```

Cursors bind entity, exact owner ID, field, native element/code-point order and
window size. Field continuations do not bind content revision; concatenated
windows are not snapshot-consistent. Omit size when continuing to inherit it; an explicitly different size
rejects. Other selected record fields may change, allowing a list result to be
continued as a targeted exact get. Malformed, damaged, wrong-owner, wrong-field,
wrong-entity or incompatible cursors reject before native reads. Cursors are
checksummed, portable tokens, not authentication or snapshots.

Follow `next_cursor` until null. A final noninitial window retains its offset/total
metadata with null continuation; a complete initial field needs no truncation entry.
Concatenating unchanged-data windows reproduces the full native text or ordered
collection. `total` is the observed field length, not a snapshot guarantee. External
edits can shift offsets; an offset beyond current length is explicitly unavailable
(`TEXT_OFFSET`/`COLLECTION_OFFSET`), and callers should restart after such changes.
Unknown notification kinds and native read failures remain unavailable, never empty.

## Native mappings

Verified against installed OmniFocus 4.9.2 (188.3) declarations and live reads.
No native declaration archive is shipped in this repository.

| Public field                            | Native authority                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| id / exact resolution                   | `id.primaryKey` / `Task.byIdentifier`                                                 |
| project_id / parent_id                  | `containingProject` / `parent` persistent IDs                                         |
| project-root exclusion                  | `task.project !== null`                                                               |
| completed / dropped                     | `completed` / `!active` (local)                                                       |
| effective_completed / effective_dropped | `effectiveCompletionDate !== null` / `!effectiveActive`                               |
| available                               | `taskStatus` is Available, Next, DueSoon or Overdue                                   |
| blocked                                 | `taskStatus === Task.Status.Blocked`                                                  |
| status                                  | Native enum mapped to available, next, due_soon, overdue, blocked, completed, dropped |
| flagged                                 | Local `flagged`; not an inferred effective flag                                       |
| note / tag_ids                          | `noteText.string` / native ordered `tags` IDs                                         |
| created_at / modified_at                | `added` / `modified`                                                                  |
| completed_at / dropped_at               | `completionDate` / `dropDate`                                                         |
| due_at / defer_at / planned_at          | `dueDate` / `deferDate` / `plannedDate`                                               |
| effective_due_at / effective_defer_at   | `effectiveDueDate` / `effectiveDeferDate`                                             |
| estimated_minutes                       | Nullable `estimatedMinutes`, preserving zero                                          |
| sequential / completed_by_children      | `sequential` / `completedByChildren`                                                  |
| floating_time_zone                      | One shared native `shouldUseFloatingTimeZone`                                         |

Notifications retain native order, persistent ID, owner task ID, kind,
initial/next fire date, absolute fire date or due-relative minute offset,
repeat seconds, snoozed state and floating timezone. Only native Absolute and
DueRelative kinds are supported. Unknown kinds make the selected field
unavailable. Conditional access avoids native getters that throw for other kinds.
Defer-relative creation and reads are not claimed on the tested build.

`relative_offset_minutes` is signed **minutes**, permits fractional numbers, and
is null for absolute records. It is not a raw native-unit field. NoFuss divides
raw `relativeFireOffset` by 60 without an app-version gate: -1800 becomes -30,
+900 becomes +15, and 1 becomes 1/60. This policy follows saved independent live
fire-time/getter evidence on OmniFocus **4.9.2 (188.3)**. It is not a claim that
all versions were tested. Installed/published declarations say minutes; the
runtime/documentation discrepancy and affected-version range remain unresolved.

No magnitude heuristic or integer rounding is used; ordinary JavaScript numeric
precision applies. Nonzero underflow, nonfinite/unreadable getters and unknown
kinds remain unavailable. Absolute records do not access the relative getter.
Version changes or missing app-build metadata alone do not disable reads.
The private development audit is not included in this public source snapshot.

Numeric `Task.addNotification` constructor arguments are a separate native API
concern, not this public read field. The saved fixture's -1800/+900 constructors
produced -30/+15-minute timing but also returned raw -1800/+900 getters. NoFuss has
no scheduling/write constructor path. Corrected live core/CLI/MCP notification
parity and unchanged-data continuation passed on 4.9.2 (188.3). Private fixture
captures are excluded from this public snapshot; the limitations above still apply.

All native dates use `toISOString()` with their full millisecond precision,
including fractions; null remains null. ISO output is UTC. The floating flag is
a distinct scheduling fact, not a conversion of the stored instant.

## Pagination, limits and failures

Query sort is ascending `(created_at, id)`, null creation dates first, bytewise ASCII ID
tie-breaking. No locale-based sorting or timestamp rounding. Cursors are versioned,
checksummed and bound to entity, scope, completion option, sort, view, field set and
page size. They are portable across processes, not authentication tokens. Changes
to bound arguments require restarting a traversal. Malformed/mismatched cursors
fail before native execution.

Project cursors also bind the exact project ID and normalized depth. Omitted depth
and explicit `descendants` are equivalent. Cursors cannot cross projects, depths
or Inbox/project scopes. Existing Inbox cursor bindings are unchanged.

Selection and ordering run before expensive field serialization. Each page reads
fresh native data. There is no hidden result cache or snapshot isolation; concurrent
edits can move records across the cursor, so a traversal during edits is not an
atomic snapshot. Responses include `read_at`, `consistency:"live"`, `returned`,
`has_more`, `next_cursor` and `stop_reason` (complete/page_limit/response_bytes).
Follow the cursor until `has_more:false`. No exact total is fabricated.

The **complete serialized MCP tool result**, including structured JSON and the text
copy, is bounded to 65536 UTF-8 bytes. Query pages yield at item boundaries with a
cursor. Batches retain every requested ID; IDs that do not fit receive an explicit
`RESPONSE_LIMIT` error with a retry instruction. A mixed batch is `isError:true`
with all successful and failed per-ID outcomes retained. Not-found is explicit.

Successful payloads and typed per-ID get outcomes retain both `structuredContent`
and `content[0].text`. Top-level query failures return JSON error text with
`isError:true`, without structured content that violates the success-page schema.
This applies to task and project queries; SDK input-schema rejection retains its
protocol validation presentation.

The SDK client receives both copies for successful results. We send
both for compatibility with the MCP specification, and count duplication in wire
measurements. No claim is made about how a particular model host bills them.

If a get's native operation fails before producing a result, all requested IDs
receive errors and `read_at` is null; no native read time is fabricated.

## Execution and diagnostics

A serialized fixed native operation per read/page, launched by JXA. Exact/task/tree
reads use one `evaluateJavascript` call plus selected metadata supplements. Project
inventories with requested supplements use the bounded two-phase path above.
The launcher checks that OmniFocus is already running;
it does not activate or start it. JSON-encoded arguments are data, never executable
user expressions. No per-property native proxy loop lives outside OmniFocus.

At most eight total admitted operations per process: one running and up to seven
waiting. Independent CLI invocations do not share this queue. A 15-second end-to-end
deadline includes queue waiting. Native stdout is limited to 256 KiB and stderr
to 32 KiB. UTF-8 is decoded only after complete bytes arrive, rejecting invalid
encoding. One JSON response frame must match its unique request ID and contain
exactly one result or typed error. Only owned
launcher processes are killed on timeout/cancellation/shutdown; no retries occur.
Stopping a launcher cannot guarantee cancellation of an in-app read already sent.
Buffered results from expired launchers are discarded; separate pipes and request
IDs prevent a late response from satisfying the next request. This does not prove
that already-dispatched in-app work stopped before the next request.
No writes exist, so uncertain-write handling is outside this slice.

The controlled alpha assumes one client and one server process. Its queue coordinates
one MCP process only. Multiple clients/processes may contend
for the same application; no machine-wide coordination is claimed. A daemon/PTY
has not been introduced. Source code and metadata describe actual current support,
not every planned alpha capability. Status probes connectivity afresh; it does not
cache success or infer synchronization completion. No personal native diagnostics
are forwarded to protocol stdout or ordinary stderr logs.

An unavailable app returns `NOT_RUNNING`. A recognized macOS Automation denial
(-1743) returns `AUTOMATION_DENIED`; other failed launcher exits remain
`NATIVE_PROCESS_FAILED`. Permission/error injection uses subprocess doubles.

Status `capabilities` describes implemented server behavior. `native.api_support`
reports only fixed named members from fresh installed OmniJS declarations, with
`declared`, `not_declared` or `unknown` values. It does not prove behavior. Failed or
unrecognized introspection stays explicit/unknown; full declarations never leave
OmniFocus and are not read on other tool calls. There is no capability cache.
`native.api_introspection` is null if native readiness could not be observed.
On that failure, `observed_at` is the server's attempt timestamp.

`verification` separately identifies independently checked behavior, known gaps,
runtime exceptions and the recorded native version/build. Its `matches_running_build`
is true only for that exact observed version/build, false on another build and null
without a native observation. The shipped evidence manifest is not a promise that
every field/value has native coverage. Direct project counts and review fixed use
the verified scripting supplement despite their absence from OmniJS declarations.
Unsupported gates remain false, including locations, Inbox-forwarding mutations
(distinct from Inbox queries), numeric available-child counts and defer-relative
notifications. See read-only readiness in the source repository (`alpha-readiness.md`, not packaged) for acceptance and
remaining native fixture gaps.
