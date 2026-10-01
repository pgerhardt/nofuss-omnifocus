import { z } from "zod";

export const API_VERSION = "1";
export const RESPONSE_BYTES = 65_536;
export const BRIEF_FIELDS = [
  "name",
  "project_id",
  "parent_id",
  "in_inbox",
  "completed",
  "dropped",
  "effective_completed",
  "effective_dropped",
  "available",
  "blocked",
  "flagged",
  "status",
] as const;
export const DETAIL_FIELDS = [
  ...BRIEF_FIELDS,
  "note",
  "tag_ids",
  "due_at",
  "defer_at",
  "effective_due_at",
  "effective_defer_at",
  "created_at",
  "modified_at",
  "completed_at",
  "dropped_at",
  "estimated_minutes",
  "sequential",
  "completed_by_children",
  "floating_time_zone",
  "notifications",
  "recurrence",
] as const;
export const FIELDS = ["id", ...DETAIL_FIELDS, "planned_at"] as const;
export type Field = (typeof FIELDS)[number];
export const PROJECT_BRIEF_FIELDS = [
  "name",
  "status",
  "type",
  "folder_id",
] as const;
export const PROJECT_DETAIL_FIELDS = [
  ...PROJECT_BRIEF_FIELDS,
  "note",
  "tag_ids",
  "due_at",
  "defer_at",
  "effective_due_at",
  "effective_defer_at",
  "created_at",
  "modified_at",
  "completed_at",
  "dropped_at",
  "floating_time_zone",
  "direct_task_count",
  "direct_completed_task_count",
  "last_review_at",
  "next_review_at",
  "review_interval",
] as const;
export const PROJECT_FIELDS = [
  "id",
  ...PROJECT_DETAIL_FIELDS,
  "planned_at",
  "flagged",
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];
export const TAXONOMY_BRIEF_FIELDS = [
  "name",
  "parent_id",
  "status",
  "active",
  "effective_active",
] as const;
export const TAG_FIELDS = [
  "id",
  ...TAXONOMY_BRIEF_FIELDS,
  "child_ids",
  "created_at",
  "modified_at",
] as const;
export const FOLDER_FIELDS = [...TAG_FIELDS, "project_ids"] as const;
export const PERSPECTIVE_BRIEF_FIELDS = [
  "name",
  "kind",
  "identity_kind",
] as const;
export const PERSPECTIVE_FIELDS = [
  "id",
  ...PERSPECTIVE_BRIEF_FIELDS,
  "created_at",
  "modified_at",
  "rule_archive",
  "rule_aggregation",
  "evaluation",
] as const;
export type Entity = "task" | "project" | "tag" | "folder" | "perspective";
export type ReadField =
  | Field
  | ProjectField
  | (typeof FOLDER_FIELDS)[number]
  | (typeof PERSPECTIVE_FIELDS)[number];
export function entityFields(entity: Entity): readonly ReadField[] {
  return entity === "perspective"
    ? PERSPECTIVE_FIELDS
    : entity === "task"
      ? FIELDS
      : entity === "project"
        ? PROJECT_FIELDS
        : entity === "tag"
          ? TAG_FIELDS
          : FOLDER_FIELDS;
}
const GET_FIELDS = [
  ...new Set([
    ...FIELDS,
    ...PROJECT_FIELDS,
    ...FOLDER_FIELDS,
    ...PERSPECTIVE_FIELDS,
  ]),
];
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+$/);
const projection = {
  view: z.enum(["brief", "detail"]).default("brief"),
  fields: z.array(z.enum(FIELDS)).max(FIELDS.length).optional(),
};
export const TREE_ORDER = "native_preorder_v1";
const TreeInput = z
  .object({
    ...projection,
    limit: z.number().int().min(1).max(200).default(25),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const GetInput = z
  .object({
    entity: z
      .enum(["task", "project", "tag", "folder", "perspective"])
      .default("task"),
    ids: z.array(id).min(1).max(20),
    ...projection,
    tree: TreeInput.optional().describe(
      "Project only, one ID. All descendants in native sibling preorder; id/parent_id/project_id always present.",
    ),
    fields: z
      .array(z.enum(GET_FIELDS))
      .max(GET_FIELDS.length)
      .optional()
      .describe(
        "Overrides view. Project fields: " +
          PROJECT_FIELDS.join(", ") +
          ". Task-only fields reject for projects and vice versa.",
      ),
    collection: z
      .object({
        field: z.enum(["tag_ids", "notifications", "child_ids", "project_ids"]),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .optional()
      .describe(
        "One exact ID and selected field. Native-order element windows; default limit 100, or continued cursor limit.",
      ),
    text: z
      .object({
        field: z.enum(["name", "note"]),
        offset: z.number().int().min(0).max(100_000_000).optional(),
        cursor: z.string().min(1).max(4096).optional(),
        length: z.number().int().min(1).max(2048).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.text?.cursor && args.text.offset !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Choose text offset or cursor, not both.",
      });
    if (
      args.collection &&
      (args.ids.length !== 1 ||
        !entityFields(args.entity).includes(args.collection.field))
    )
      ctx.addIssue({
        code: "custom",
        path: ["collection"],
        message:
          "Collection windows require one ID and an entity-supported collection.",
      });
    if (args.tree && (args.entity !== "project" || args.ids.length !== 1))
      ctx.addIssue({
        code: "custom",
        path: ["tree"],
        message: "Tree inspection requires entity project and exactly one ID.",
      });
    const supported: readonly string[] = entityFields(args.entity);
    if (args.fields && args.fields.length > supported.length)
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: `Too many selected fields for ${args.entity}.`,
      });
    args.fields?.forEach((field, i) => {
      if (!supported.includes(field))
        ctx.addIssue({
          code: "custom",
          path: ["fields", i],
          message: `${field} is unsupported for ${args.entity}.`,
        });
    });
  });
const TaskStatus = z.enum([
  "available",
  "blocked",
  "completed",
  "dropped",
  "due_soon",
  "next",
  "overdue",
]);
const DateWindow = z
  .object({
    from: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (w) => w.from !== undefined || w.before !== undefined,
    "A date bound is required.",
  )
  .refine(
    (w) => !w.from || !w.before || Date.parse(w.from) < Date.parse(w.before),
    "Date window must be increasing.",
  );
const EstimateBounds = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (w) => w.min !== undefined || w.max !== undefined,
    "An estimate bound is required.",
  )
  .refine(
    (w) => w.min === undefined || w.max === undefined || w.min <= w.max,
    "Estimate bounds must be increasing.",
  );
export const TASK_FILTERS = [
  "status",
  "available",
  "flagged",
  "tag_ids",
  "due_at",
  "defer_at",
  "planned_at",
  "effective_due_at",
  "effective_defer_at",
  "estimated_minutes",
] as const;
export const QueryInput = z
  .object({
    entity: z.enum(["task", "project", "tag", "folder", "perspective"]),
    scope: z.enum(["inbox_roots", "project", "library"]),
    status: z
      .enum(["active", "on_hold", "done", ...TaskStatus.options])
      .optional(),
    flagged: z.boolean().optional(),
    available: z.boolean().optional(),
    tag_ids: z
      .array(id)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Match any exact assigned tag ID, without ancestor/descendant expansion.",
      ),
    due_at: DateWindow.optional(),
    defer_at: DateWindow.optional(),
    planned_at: DateWindow.optional(),
    effective_due_at: DateWindow.optional(),
    effective_defer_at: DateWindow.optional(),
    estimated_minutes: EstimateBounds.optional(),
    include_dropped: z.boolean().optional(),
    project_id: id
      .optional()
      .describe("Exact project ID; required only for project scope."),
    depth: z
      .enum(["direct", "descendants"])
      .optional()
      .describe("Project scope only; defaults to descendants."),
    include_completed: z
      .boolean()
      .optional()
      .describe("Task queries only; defaults to false."),
    sort: z.literal("created_at").default("created_at"),
    limit: z.number().int().min(1).max(200).default(25),
    cursor: z.string().min(1).max(4096).optional(),
    ...projection,
    fields: z.array(z.enum(GET_FIELDS)).max(GET_FIELDS.length).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const task = args.entity === "task";
    const project = args.entity === "project";
    if (!task && args.scope !== "library")
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Inventories require library scope.",
      });
    const unsupported = task
      ? []
      : ([
          "include_completed",
          "include_dropped",
          ...TASK_FILTERS.filter((f) =>
            project && (f === "status" || f === "flagged")
              ? false
              : f !== "status",
          ),
        ] as const);
    for (const field of unsupported)
      if (args[field] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is unsupported for ${args.entity} queries.`,
        });
    const statuses: readonly string[] =
      args.entity === "perspective"
        ? []
        : task
          ? TaskStatus.options
          : project
            ? ["active", "on_hold", "done", "dropped"]
            : args.entity === "tag"
              ? ["active", "on_hold", "dropped"]
              : ["active", "dropped"];
    if (args.status !== undefined && !statuses.includes(args.status))
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Status is unsupported for this entity.",
      });
    if (
      task &&
      args.status !== undefined &&
      (args.include_completed !== undefined ||
        args.include_dropped !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Explicit native status replaces local completion/drop defaults; omit include flags.",
      });
    const supported: readonly string[] = entityFields(args.entity);
    if (
      args.fields &&
      (args.fields.length > supported.length ||
        args.fields.some((f) => !supported.includes(f)))
    )
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: `Unsupported field selection for ${args.entity}.`,
      });
    if (args.scope === "project" && args.project_id === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["project_id"],
        message: "Project scope requires an exact project_id.",
      });
    if (args.scope !== "project") {
      for (const field of ["project_id", "depth"] as const)
        if (args[field] !== undefined)
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is only supported for project scope.`,
          });
    }
  });
export const StatusInput = z.object({}).strict();
export type GetArgs = z.infer<typeof GetInput>;
export type QueryArgs = z.infer<typeof QueryInput>;
export function selectedFields(args: {
  entity?: Entity;
  view: "brief" | "detail";
  fields?: ReadField[];
}): ReadField[] {
  return [
    ...new Set<ReadField>([
      "id",
      ...(args.fields ??
        (args.entity === "perspective"
          ? args.view === "brief"
            ? PERSPECTIVE_BRIEF_FIELDS
            : PERSPECTIVE_FIELDS
          : args.entity === "tag" || args.entity === "folder"
            ? args.view === "brief"
              ? TAXONOMY_BRIEF_FIELDS
              : entityFields(args.entity)
            : args.entity === "project"
              ? args.view === "brief"
                ? PROJECT_BRIEF_FIELDS
                : PROJECT_DETAIL_FIELDS
              : args.view === "brief"
                ? BRIEF_FIELDS
                : DETAIL_FIELDS)),
    ]),
  ].sort();
}
export function treeFields(args: z.infer<typeof TreeInput>): Field[] {
  return [
    ...new Set<Field>([
      ...(selectedFields(args) as Field[]),
      "parent_id",
      "project_id",
    ]),
  ].sort();
}
export class ReadError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const date = z.string().datetime().nullable().meta({ id: "NullableTimestamp" });
const notification = z
  .object({
    id,
    task_id: id.nullable(),
    kind: z.enum(["absolute", "due_relative"]),
    initial_fire_at: date,
    next_fire_at: date,
    absolute_fire_at: date,
    relative_offset_minutes: z
      .number()
      .nullable()
      .describe(
        "Signed minutes, including fractions; null for absolute notifications. Native second-valued offsets are divided by 60.",
      ),
    repeat_interval_seconds: z.number(),
    is_snoozed: z.boolean(),
    floating_time_zone: z.boolean(),
  })
  .strict();
const unavailable = z
  .record(
    z.string(),
    z.object({ code: z.string(), reason: z.string() }).strict(),
  )
  .meta({ id: "FieldUnavailable" });
const truncated = z
  .record(
    z.string(),
    z
      .object({
        offset: z.number().int(),
        returned: z.number().int(),
        total: z.number().int(),
        next_offset: z.number().int().nullable(),
        reason: z.enum(["text_window", "collection_window"]),
        next_cursor: z.string().nullable().optional(),
      })
      .strict(),
  )
  .meta({ id: "FieldTruncation" });
export const Recurrence = z
  .object({
    frequency: z.enum(["daily", "weekly"]),
    interval: z.number().int().min(1).max(1000),
    schedule: z.enum(["regularly", "from_completion"]),
    anchor: z.enum(["due", "defer"]),
    catch_up: z.boolean(),
  })
  .strict()
  .refine(
    (v) => v.schedule === "regularly" || !v.catch_up,
    "Catch-up is only verified for regular schedules.",
  );
export const NotificationWrite = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("absolute"),
      fire_at: z
        .string()
        .datetime()
        .transform((v) => new Date(v).toISOString()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_relative"),
      relative_offset_minutes: z.number().int().min(-10080).max(10080),
    })
    .strict(),
]);
export const TaskRecord = z
  .object({
    id,
    name: z.string().optional(),
    project_id: id.nullable().optional(),
    parent_id: id.nullable().optional(),
    in_inbox: z.boolean().optional(),
    completed: z.boolean().optional(),
    dropped: z.boolean().optional(),
    effective_completed: z.boolean().optional(),
    effective_dropped: z.boolean().optional(),
    available: z.boolean().optional(),
    blocked: z.boolean().optional(),
    flagged: z.boolean().optional(),
    status: z
      .enum([
        "available",
        "blocked",
        "completed",
        "dropped",
        "due_soon",
        "next",
        "overdue",
      ])
      .optional(),
    note: z.string().optional(),
    tag_ids: z.array(id).optional(),
    due_at: date.optional(),
    defer_at: date.optional(),
    effective_due_at: date.optional(),
    effective_defer_at: date.optional(),
    created_at: date.optional(),
    modified_at: date.optional(),
    completed_at: date.optional(),
    dropped_at: date.optional(),
    planned_at: date.optional(),
    estimated_minutes: z.number().nullable().optional(),
    sequential: z.boolean().optional(),
    completed_by_children: z.boolean().optional(),
    floating_time_zone: z.boolean().optional(),
    notifications: z.array(notification).optional(),
    recurrence: Recurrence.nullable().optional(),
    unavailable: unavailable.optional(),
    truncated: truncated.optional(),
  })
  .strict()
  .meta({ id: "TaskRecord" });
export type TaskData = z.infer<typeof TaskRecord>;
export const TreeTaskRecord = TaskRecord.and(
  z.object({ parent_id: id, project_id: id }).passthrough(),
).superRefine((row, ctx) => {
  // Zod intersections accept keys recognized by either branch, including the
  // structural branch's passthrough. Retain TaskRecord's strict runtime shape
  // as well as its shared, strict JSON Schema reference.
  const keys = Object.keys(row).filter(
    (key) => !Object.prototype.hasOwnProperty.call(TaskRecord.shape, key),
  );
  if (keys.length) ctx.addIssue({ code: "unrecognized_keys", keys });
});
export const TreeOutput = z
  .object({
    root_id: id,
    items: z.array(TreeTaskRecord),
    returned: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    order: z.literal(TREE_ORDER),
    consistency: z.literal("live"),
    stop_reason: z.enum(["complete", "page_limit", "response_bytes"]),
  })
  .strict();
export const ProjectRecord = TaskRecord.pick({
  id: true,
  name: true,
  note: true,
  tag_ids: true,
  due_at: true,
  defer_at: true,
  effective_due_at: true,
  effective_defer_at: true,
  created_at: true,
  modified_at: true,
  completed_at: true,
  dropped_at: true,
  planned_at: true,
  floating_time_zone: true,
  flagged: true,
  unavailable: true,
  truncated: true,
})
  .extend({
    status: z.enum(["active", "on_hold", "done", "dropped"]).optional(),
    type: z.enum(["parallel", "sequential", "single_actions"]).optional(),
    folder_id: id.nullable().optional(),
    direct_task_count: z.number().int().nonnegative().optional(),
    direct_completed_task_count: z.number().int().nonnegative().optional(),
    last_review_at: date.optional(),
    next_review_at: date.optional(),
    review_interval: z
      .object({
        unit: z.enum(["minutes", "hours", "days", "weeks", "months", "years"]),
        steps: z.number().int().positive(),
        fixed: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .meta({ id: "ProjectRecord" });
export const ItemError = z
  .object({ code: z.string(), message: z.string() })
  .strict();
export const TagRecord = z
  .object({
    id,
    name: z.string().optional(),
    parent_id: id.nullable().optional(),
    child_ids: z.array(id).optional(),
    status: z.enum(["active", "on_hold", "dropped"]).optional(),
    active: z.boolean().optional(),
    effective_active: z.boolean().optional(),
    created_at: date.optional(),
    modified_at: date.optional(),
    unavailable: unavailable.optional(),
    truncated: truncated.optional(),
  })
  .strict()
  .meta({ id: "TagRecord" });
export const FolderRecord = TagRecord.extend({
  status: z.enum(["active", "dropped"]).optional(),
  project_ids: z.array(id).optional(),
}).meta({ id: "FolderRecord" });
type ArchiveJson =
  | null
  | boolean
  | number
  | string
  | ArchiveJson[]
  | { [key: string]: ArchiveJson };
const PerspectiveArchiveJson: z.ZodType<ArchiveJson> = z
  .lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number().finite(),
      z.string(),
      z.array(PerspectiveArchiveJson),
      z.record(z.string(), PerspectiveArchiveJson),
    ]),
  )
  .meta({ id: "PerspectiveArchiveJson" });
export const PerspectiveRecord = z
  .object({
    id,
    name: z.string().optional(),
    kind: z.enum(["builtin", "custom"]).optional(),
    identity_kind: z.enum(["builtin_enum", "persistent"]).optional(),
    created_at: date.optional(),
    modified_at: date.optional(),
    rule_archive: z
      .object({
        format: z.literal("native_unversioned"),
        application_version: z.string(),
        rules: PerspectiveArchiveJson,
      })
      .strict()
      .optional(),
    rule_aggregation: z.enum(["all", "any", "none"]).nullable().optional(),
    evaluation: z
      .object({
        status: z.enum([
          "available",
          "no_window",
          "not_selected",
          "ambiguous_windows",
        ]),
        scope: z.literal("visible_window"),
        task_ids: z.array(id).max(100),
        project_ids: z.array(id).max(100),
        has_more: z.boolean(),
        window_filters_possible: z.literal(true),
        order: z.literal("native_visible_preorder"),
      })
      .strict()
      .optional(),
    unavailable: unavailable.optional(),
    truncated: truncated.optional(),
  })
  .strict()
  .meta({ id: "PerspectiveRecord" });
export const entityRecord = {
  task: TaskRecord,
  project: ProjectRecord,
  tag: TagRecord,
  folder: FolderRecord,
  perspective: PerspectiveRecord,
};
export const GetResult = z
  .object({
    id,
    status: z.enum(["ok", "not_found", "error"]),
    task: TaskRecord.optional(),
    project: ProjectRecord.optional(),
    tag: TagRecord.optional(),
    folder: FolderRecord.optional(),
    perspective: PerspectiveRecord.optional(),
    tree: TreeOutput.optional(),
    error: ItemError.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const valid =
      r.status === "ok"
        ? Number(!!r.task) +
            Number(!!r.project) +
            Number(!!r.tag) +
            Number(!!r.folder) +
            Number(!!r.perspective) ===
            1 &&
          !r.error &&
          (r.task ?? r.project ?? r.tag ?? r.folder ?? r.perspective)?.id ===
            r.id
        : !!r.error &&
          !r.task &&
          !r.project &&
          !r.tag &&
          !r.folder &&
          !r.perspective;
    if (!valid || (r.tree && (r.status !== "ok" || !r.project)))
      ctx.addIssue({
        code: "custom",
        message:
          "Per-ID outcome must contain one matching entity record or an explicit error.",
      });
  });
export const GetOutput = z
  .object({
    results: z.array(GetResult),
    read_at: z.string().datetime().nullable(),
  })
  .strict();
export const QueryOutput = z
  .object({
    items: z.union([
      z.array(TaskRecord),
      z.array(ProjectRecord),
      z.array(TagRecord),
      z.array(FolderRecord),
      z.array(PerspectiveRecord),
    ]),
    returned: z.number().int(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    read_at: z.string().datetime(),
    consistency: z.literal("live"),
    stop_reason: z.enum(["complete", "page_limit", "response_bytes"]),
  })
  .strict();
// Fixed workload scope; overview is not a second query language.
export const OverviewInput = z
  .object({
    waiting_tag_ids: z.array(id).min(1).max(20).optional(),
  })
  .strict();
const WaitingOverview = z
  .object({
    tag_ids: z.array(id).min(1).max(20),
    count: z.number().int().nonnegative().nullable(),
    inbox_count: z.number().int().nonnegative().nullable(),
    items: z.array(z.object({ id, project_id: id.nullable() }).strict()),
    coverage: z
      .object({
        returned: z.number().int().nonnegative(),
        complete: z.boolean(),
        reason: z.enum(["complete", "response_bytes", "unavailable"]),
        drilldown: z
          .literal(
            "nofuss_query Inbox roots and active library; nofuss_get project trees with status/tag_ids",
          )
          .optional(),
      })
      .strict(),
    unavailable: unavailable.optional(),
  })
  .strict();
export const OverviewProject = ProjectRecord.pick({
  id: true,
  name: true,
  next_review_at: true,
  unavailable: true,
  truncated: true,
})
  .extend({
    waiting_count: z.number().int().nonnegative().optional(),
    review_due: z.boolean().optional(),
    work_state: z
      .enum([
        "available_action",
        "remaining_without_available_action",
        "no_remaining_work",
      ])
      .optional(),
  })
  .meta({ id: "OverviewProject" });
export const OverviewOutput = z
  .object({
    scope: z.literal("inbox_roots_and_active_projects"),
    evaluated_at: z.string().datetime(),
    consistency: z.literal("live"),
    counts: z
      .object({
        inbox_unfinished: z.number().int().nonnegative().nullable(),
        active_projects: z.number().int().nonnegative(),
        review_due: z.number().int().nonnegative().nullable(),
        remaining_without_available_action: z
          .number()
          .int()
          .nonnegative()
          .nullable(),
      })
      .strict(),
    projects: z.array(OverviewProject),
    waiting: WaitingOverview.optional(),
    coverage: z
      .object({
        returned: z.number().int().nonnegative(),
        complete: z.boolean(),
        reason: z.enum(["complete", "response_bytes"]),
        drilldown: z
          .literal("nofuss_query active library; nofuss_get project tree")
          .optional(),
      })
      .strict(),
    unavailable: unavailable.optional(),
  })
  .strict();
export const CAPABILITIES = {
  exact_task_ids: true,
  exact_project_ids: true,
  exact_tag_ids: true,
  exact_folder_ids: true,
  tag_fields: TAG_FIELDS,
  folder_fields: FOLDER_FIELDS,
  library_task_query: true,
  library_task_query_deadline_ms: 45000,
  task_filters: TASK_FILTERS,
  include_dropped: true,
  tag_inventory: true,
  folder_inventory: true,
  project_fields: PROJECT_FIELDS,
  max_batch_ids: 20,
  inbox_roots: true,
  project_task_query: true,
  project_depths: ["direct", "descendants"],
  include_completed: true,
  projections: ["brief", "detail"],
  fields: FIELDS,
  max_page_items: 200,
  response_bytes: RESPONSE_BYTES,
  pagination: "live_keyset_created_at_id",
  text_windows: true,
  collection_windows: ["tag_ids", "notifications", "child_ids", "project_ids"],
  fresh_native_reads: true,
  project_inventory: true,
  project_filters: ["status", "flagged"],
  project_trees: true,
  tree_order: TREE_ORDER,
  max_tree_projects: 1,
  overview: true,
  overview_waiting: true,
  writes: false,
  attachments: false,
  perspectives: true,
  perspective_fields: PERSPECTIVE_FIELDS,
  perspective_rule_writes: false,
  perspective_evaluation: "already_selected_visible_window",
  recurrence: true,
  sync_completion: false,
  locations: false,
  inbox_forwarding: false,
  native_available_child_count: false,
  defer_relative_notifications: false,
} as const;
const declarationState = z.enum(["declared", "not_declared", "unknown"]);
export const NativeApiSupport = z
  .object({
    source: z.literal("installed_omnijs_declarations"),
    state: z.enum(["observed", "unavailable"]),
    members: z
      .object({
        task_lookup: declarationState,
        project_lookup: declarationState,
        tag_lookup: declarationState,
        task_state: declarationState,
        project_traversal: declarationState,
        task_tags: declarationState,
        notifications: declarationState,
        planned_dates: declarationState,
        review_interval_fixed: declarationState,
        project_direct_counts: declarationState,
      })
      .strict(),
    error: ItemError.optional(),
  })
  .strict();
export const StatusOutput = z
  .object({
    build: z
      .object({
        name: z.literal("NoFuss for OmniFocus"),
        version: z.string(),
        source_revision: z.string().nullable(),
        dirty: z.boolean(),
        source_sha256: z.string(),
      })
      .strict(),
    native: z
      .object({
        connected: z.boolean(),
        version: z.string().nullable(),
        build: z.string().nullable(),
        observed_at: z.string().datetime(),
        api_introspection: z.boolean().nullable(),
        api_support: NativeApiSupport,
        error: ItemError.optional(),
      })
      .strict(),
    worker: z
      .object({
        mode: z.literal("per_call_osascript"),
        state: z.string(),
        queued: z.number(),
        timeout_ms: z.number(),
        max_pending: z.number(),
        result_cache: z.literal(false),
        coordination: z.literal("single_process"),
      })
      .strict(),
    capabilities: z.object(
      Object.fromEntries(
        Object.entries(CAPABILITIES).map(([k, v]) => [
          k,
          Array.isArray(v)
            ? z.array(z.string())
            : typeof v === "boolean"
              ? z.boolean()
              : typeof v === "number"
                ? z.number()
                : z.string(),
        ]),
      ),
    ),
    verification: z
      .object({
        recorded_native: z
          .object({ version: z.string(), build: z.string() })
          .strict(),
        matches_running_build: z.boolean().nullable(),
        basis: z.literal("independent_native_checks"),
        verified_reads: z.array(z.string()),
        gaps: z.array(z.string()),
        exceptions: z.record(z.string(), z.string()),
      })
      .strict(),
    sync: z
      .object({ state: z.literal("unavailable"), reason: z.string() })
      .strict(),
  })
  .strict();
