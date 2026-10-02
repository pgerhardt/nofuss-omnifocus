import { NativePrimitives, PrimitiveInputs } from "./native-primitives.js";
import { OrdinaryTasks, OrdinaryTaskInputs } from "./ordinary-tasks.js";
import { plugins } from "./plugins.js";
import { Outlines } from "./outlines.js";
import { Locations } from "./locations.js";
import { Sync } from "./sync.js";
import { Attachments, AttachmentInputs } from "./attachments.js";
import { PerspectiveWrites, PerspectiveInputs } from "./perspective-writes.js";
import { ContainerLifecycle, ContainerInputs } from "./container-lifecycle.js";
import { TaskHierarchy } from "./task-hierarchy.js";
import { z } from "zod";
import { TaxonomyWrites } from "./taxonomy-writes.js";
import { ProjectWrites } from "./project-writes.js";
import { TaskBatch } from "./task-batch.js";
import { TaskWrites } from "./task-writes.js";
import {
  readWritePolicy,
  enabledWriteScopes,
  WRITE_SCOPES,
  type WriteScope,
} from "./write-authorization.js";
import {
  CAPABILITIES,
  OverviewInput,
  OverviewOutput,
  NativeApiSupport,
  StatusOutput,
  StatusInput,
  GetInput,
  GetOutput,
  QueryInput,
  QueryOutput,
  TaskRecord,
  ProjectRecord,
  TagRecord,
  FolderRecord,
  PerspectiveRecord,
  Entity,
  entityRecord,
  ReadError,
  RESPONSE_BYTES,
  selectedFields,
  treeFields,
} from "./contract.js";
import {
  decodeCursor,
  decodeFieldCursor,
  fieldHash,
  decodeTreeCursor,
  encodeCursor,
  Key,
  queryHash,
  queryPredicates,
  treeHash,
} from "./cursor.js";
import { READ_VERIFICATION } from "./verification.js";
import type { NativeWorker } from "./worker.js";

import { parseInput, parseNative, errorInfo } from "./errors.js";
import { packingCost } from "./packing.js";

// Continuations belong to the exact field, so pages from queries and trees can
// be completed through get without inheriting the enclosing list projection.
function fieldCursors(
  row:
    | z.infer<typeof TaskRecord>
    | z.infer<typeof ProjectRecord>
    | z.infer<typeof TagRecord>
    | z.infer<typeof FolderRecord>
    | z.infer<typeof PerspectiveRecord>,
  entity: Entity,
  text?: { field: string; length: number },
  collection?: { field: string; limit: number },
) {
  for (const [field, page] of Object.entries(row.truncated ?? {})) {
    const isText = field === "name" || field === "note";
    const value = row[field as keyof typeof row];
    const length =
      typeof value === "string"
        ? Array.from(value).length
        : Array.isArray(value)
          ? value.length
          : -1;
    if (
      (!isText &&
        !(
          entity === "task"
            ? ["tag_ids", "notifications"]
            : entity === "project"
              ? ["tag_ids"]
              : entity === "tag"
                ? ["child_ids"]
                : ["child_ids", "project_ids"]
        ).includes(field)) ||
      page.reason !== (isText ? "text_window" : "collection_window") ||
      page.offset < 0 ||
      page.returned !== length ||
      page.total < page.offset + length ||
      page.next_offset !==
        (page.offset + length < page.total ? page.offset + length : null) ||
      (page.next_offset !== null && length === 0) ||
      page.next_cursor !== undefined
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Native field continuation is invalid.",
      );
    const limit = isText
      ? text?.field === field
        ? text.length
        : field === "name"
          ? 512
          : 2048
      : collection?.field === field
        ? collection.limit
        : 100;
    page.next_cursor =
      page.next_offset === null
        ? null
        : encodeCursor(fieldHash(entity, row.id, field), {
            offset: page.next_offset,
            limit,
          });
  }
}
type Reader = Pick<NativeWorker, "run" | "snapshot">;
export class NoFussCore {
  constructor(
    private worker: Reader,
    private build: Record<string, unknown>,
    private writeStateDirectory?: string,
  ) {}
  private async runNative(
    operation: string,
    args: unknown,
    signal?: AbortSignal,
  ) {
    try {
      return await this.worker.run(operation, args, signal);
    } catch (error) {
      const info = errorInfo(error);
      throw new ReadError(info.code, info.message);
    }
  }
  async execute(operation: string, input: unknown, signal?: AbortSignal) {
    if (WRITE_SCOPES.includes(operation as WriteScope))
      return this.mutate(operation as WriteScope, input);
    switch (operation) {
      case "preferences":
        return new NativePrimitives(
          this.worker,
          this.writeStateDirectory,
        ).preferences(input);
      case "plugins":
        return plugins(this.worker, input);
      case "export":
        return new Outlines(this.worker, this.writeStateDirectory).export(
          input,
        );
      case "location":
        return new Locations(this.worker, this.writeStateDirectory).read(input);
      case "sync-status":
        return new Sync(this.worker, this.writeStateDirectory).read(input);
      case "attachments":
        return new Attachments(this.worker, this.writeStateDirectory).read(
          input,
        );
      case "get":
        return this.get(input, signal);
      case "query":
        return this.query(input, signal);
      case "overview":
        return this.overview(input, signal);
      case "doctor":
        parseInput(StatusInput, input);
        return this.status(signal);
      default:
        throw new ReadError(
          "UNSUPPORTED_OPERATION",
          "Only read operations are supported.",
        );
    }
  }
  async mutate(scope: WriteScope, input: unknown) {
    if (scope in PrimitiveInputs)
      return new NativePrimitives(
        this.worker,
        this.writeStateDirectory,
      ).execute(scope as keyof typeof PrimitiveInputs, input);
    if (scope in OrdinaryTaskInputs)
      return new OrdinaryTasks(this.worker, this.writeStateDirectory).execute(
        scope as keyof typeof OrdinaryTaskInputs,
        input,
      );
    if (scope === "project.import_outline")
      return new Outlines(this.worker, this.writeStateDirectory).import(input);
    if (scope === "tag.set_location")
      return new Locations(this.worker, this.writeStateDirectory).write(input);
    if (scope === "sync.trigger")
      return new Sync(this.worker, this.writeStateDirectory).trigger(input);
    if (scope in AttachmentInputs)
      return new Attachments(this.worker, this.writeStateDirectory).execute(
        scope as keyof typeof AttachmentInputs,
        input,
      );
    if (scope in PerspectiveInputs)
      return new PerspectiveWrites(
        this.worker,
        this,
        this.writeStateDirectory,
      ).execute(scope as keyof typeof PerspectiveInputs, input);
    if (scope in ContainerInputs)
      return new ContainerLifecycle(
        this.worker,
        this,
        this.writeStateDirectory,
      ).execute(scope as keyof typeof ContainerInputs, input);
    if (
      scope === "task.reorder" ||
      (input &&
        typeof input === "object" &&
        "subtree" in input &&
        input.subtree === true &&
        [
          "task.duplicate",
          "task.delete",
          "task.drop",
          "task.complete",
        ].includes(scope))
    )
      return new TaskHierarchy(
        this.worker,
        this,
        this.writeStateDirectory,
      ).execute(scope, input);
    if (scope === "task.batch")
      return new TaskBatch(this.worker, this, this.writeStateDirectory).execute(
        input,
      );
    if (scope.startsWith("tag.") || scope.startsWith("folder."))
      return new TaxonomyWrites(
        this.worker,
        this,
        this.writeStateDirectory,
      ).execute(
        scope as keyof typeof import("./taxonomy-writes.js").TaxonomyInputs,
        input,
      );
    if (scope.startsWith("project."))
      return new ProjectWrites(
        this.worker,
        this,
        this.writeStateDirectory,
      ).execute(
        scope as keyof typeof import("./project-writes.js").ProjectInputs,
        input,
      );
    return new TaskWrites(this.worker, this, this.writeStateDirectory).execute(
      scope as keyof typeof import("./task-writes.js").TaskInputs,
      input,
    );
  }
  async get(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof GetOutput>> {
    const args = parseInput(GetInput, input),
      fields = selectedFields(args);
    const hash = args.tree ? treeHash(args) : undefined;
    const tree = args.tree
      ? {
          limit: args.tree.limit,
          fields: treeFields(args.tree),
        }
      : undefined;
    if (
      args.text &&
      (args.ids.length !== 1 || !fields.includes(args.text.field))
    )
      throw new ReadError(
        "INVALID_TEXT_SELECTION",
        "Text windows require one ID and the named field selected.",
      );
    if (args.collection && !fields.includes(args.collection.field))
      throw new ReadError(
        "INVALID_COLLECTION_SELECTION",
        "Collection windows require the named field selected.",
      );
    let output: z.infer<typeof GetOutput>;
    try {
      const textKey = args.text
        ? decodeFieldCursor(
            args.text.cursor,
            fieldHash(args.entity, args.ids[0]!, args.text.field),
            args.text.length,
          )
        : null;
      const collectionKey = args.collection
        ? decodeFieldCursor(
            args.collection.cursor,
            fieldHash(args.entity, args.ids[0]!, args.collection.field),
            args.collection.limit,
            200,
          )
        : null;
      const text = args.text
        ? {
            field: args.text.field,
            offset: textKey?.offset ?? args.text.offset ?? 0,
            length: textKey?.limit ?? args.text.length ?? 2048,
          }
        : undefined;
      const collection = args.collection
        ? {
            field: args.collection.field,
            offset: collectionKey?.offset ?? 0,
            limit: collectionKey?.limit ?? args.collection.limit ?? 100,
          }
        : undefined;
      output = parseNative(
        GetOutput,
        await this.runNative(
          "get",
          {
            entity: args.entity,
            ids: args.ids,
            fields,
            text,
            collection,
            ...(tree
              ? {
                  tree: {
                    ...tree,
                    after: decodeTreeCursor(args.tree!.cursor, hash!),
                  },
                }
              : {}),
          },
          signal,
        ),
      );
      for (const item of output.results) {
        if (item.status !== "ok") continue;
        fieldCursors(item[args.entity]!, args.entity, text, collection);
        const page = item.tree;
        for (const row of page?.items ?? []) fieldCursors(row, "task");
        if (
          Boolean(tree) !== Boolean(page) ||
          (page &&
            (page.returned !== page.items.length ||
              page.items.length > tree!.limit ||
              (!page.items.length && page.has_more) ||
              page.has_more !== (page.stop_reason !== "complete") ||
              page.next_cursor !== null ||
              new Set(page.items.map((t) => t.id)).size !== page.items.length ||
              page.items.some(
                (t) =>
                  t.id === page.root_id ||
                  t.project_id !== item.id ||
                  t.parent_id === t.id,
              )))
        )
          throw new ReadError(
            "INVALID_NATIVE_OUTPUT",
            "Native tree membership/continuation is invalid.",
          );
        if (page?.has_more)
          page.next_cursor = encodeCursor(hash!, { id: page.items.at(-1)!.id });
      }
    } catch (error) {
      return {
        results: args.ids.map((id) => ({
          id,
          status: "error",
          error: errorInfo(error),
        })),
        read_at: null,
      };
    }
    if (
      output.results.length !== args.ids.length ||
      output.results.some(
        (r, i) =>
          r.id !== args.ids[i] ||
          (r.status === "ok" && r[args.entity]?.id !== r.id) ||
          (r.status !== "ok" && !r.error),
      )
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Native batch result association failed.",
      );
    while (
      packingCost(
        output,
        output.results.some((r) => r.status !== "ok"),
      ) > RESPONSE_BYTES
    ) {
      const item = [...output.results].reverse().find((r) => r.status === "ok");
      if (!item)
        throw new ReadError(
          "RESPONSE_LIMIT",
          "Result envelope exceeds the byte budget.",
        );
      if (item.tree && item.tree.items.length > 1) {
        item.tree.items.pop();
        item.tree.returned = item.tree.items.length;
        item.tree.has_more = true;
        item.tree.stop_reason = "response_bytes";
        item.tree.next_cursor = encodeCursor(hash!, {
          id: item.tree.items.at(-1)!.id,
        });
        continue;
      }
      delete item[args.entity];
      delete item.tree;
      item.status = "error";
      item.error = {
        code: "RESPONSE_LIMIT",
        message:
          "Retry this ID with fewer selected fields or a smaller text window.",
      };
    }
    return output;
  }
  async query(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof QueryOutput>> {
    const args = parseInput(QueryInput, input),
      hash = queryHash(args),
      after = decodeCursor(args.cursor, hash);
    const nativeSchema = z
      .object({
        items: z.array(entityRecord[args.entity]),
        keys: z.array(Key),
        has_more: z.boolean(),
        stop_reason: z.enum(["complete", "page_limit", "response_bytes"]),
        read_at: z.string().datetime(),
      })
      .strict();
    const native = parseNative(
      nativeSchema,
      await this.runNative(
        "query",
        {
          entity: args.entity,
          scope: args.scope,
          ...queryPredicates(args),
          ...(args.scope === "project"
            ? {
                project_id: args.project_id,
                depth: args.depth ?? "descendants",
              }
            : {}),
          limit: args.limit,
          after,
          fields: selectedFields(args),
        },
        signal,
      ),
    );
    if (
      native.items.length !== native.keys.length ||
      native.items.length > args.limit ||
      native.items.some((t, i) => t.id !== native.keys[i]?.id) ||
      (!native.items.length && native.has_more)
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Native page membership/continuation is invalid.",
      );
    for (const row of native.items) fieldCursors(row, args.entity);
    const page = () =>
      parseNative(QueryOutput, {
        items: native.items,
        returned: native.items.length,
        has_more: native.has_more,
        next_cursor: native.has_more
          ? encodeCursor(hash, native.keys.at(-1)!)
          : null,
        read_at: native.read_at,
        consistency: "live",
        stop_reason: native.stop_reason,
      });
    let output = page();
    while (packingCost(output) > RESPONSE_BYTES && native.items.length > 1) {
      native.items.pop();
      native.keys.pop();
      native.has_more = true;
      native.stop_reason = "response_bytes";
      output = page();
    }
    if (packingCost(output) > RESPONSE_BYTES)
      throw new ReadError(
        "RESPONSE_LIMIT",
        "One record exceeds the response budget. Retry with fewer selected fields.",
      );
    return output;
  }
  async overview(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof OverviewOutput>> {
    const args = parseInput(OverviewInput, input);
    if (args.waiting_tag_ids)
      args.waiting_tag_ids = [...new Set(args.waiting_tag_ids)].sort();
    const output = parseNative(
      OverviewOutput,
      await this.runNative("overview", args, signal),
    );
    const { counts, coverage, projects } = output;
    if (
      coverage.returned !== projects.length ||
      projects.length > counts.active_projects ||
      coverage.complete !== (projects.length === counts.active_projects) ||
      coverage.complete !== (coverage.reason === "complete") ||
      coverage.drilldown !== undefined ||
      projects.some((p, i) => i > 0 && p.id <= projects[i - 1]!.id) ||
      (counts.review_due !== null &&
        counts.review_due > counts.active_projects) ||
      (counts.remaining_without_available_action !== null &&
        counts.remaining_without_available_action > counts.active_projects)
    )
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Native overview count/list coverage is inconsistent.",
      );
    for (const field of [
      "inbox_unfinished",
      "review_due",
      "remaining_without_available_action",
    ] as const)
      if ((counts[field] === null) !== !!output.unavailable?.[field])
        throw new ReadError(
          "INVALID_NATIVE_OUTPUT",
          "Unavailable overview counts must be explicit, never zero.",
        );
    for (const row of projects) {
      for (const field of [
        "name",
        "next_review_at",
        "review_due",
        "work_state",
      ] as const)
        if ((row[field] === undefined) !== !!row.unavailable?.[field])
          throw new ReadError(
            "INVALID_NATIVE_OUTPUT",
            "Overview facts must be present or explicitly unavailable.",
          );
      fieldCursors(row, "project");
    }
    const waiting = output.waiting;
    const invalidWaiting = () => {
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Native waiting scope, counts or coverage is inconsistent.",
      );
    };
    if (!!waiting !== !!args.waiting_tag_ids) invalidWaiting();
    for (const row of projects) {
      if (
        waiting
          ? (row.waiting_count === undefined) !==
            !!row.unavailable?.waiting_count
          : row.waiting_count !== undefined || !!row.unavailable?.waiting_count
      )
        invalidWaiting();
    }
    if (waiting) {
      const c = waiting.coverage;
      if (
        JSON.stringify(waiting.tag_ids) !==
          JSON.stringify(args.waiting_tag_ids) ||
        c.returned !== waiting.items.length ||
        c.drilldown !== undefined ||
        c.complete !==
          (waiting.count !== null && waiting.items.length === waiting.count) ||
        c.complete !== (c.reason === "complete") ||
        (waiting.count === null) !== (c.reason === "unavailable") ||
        (waiting.count === null) !== !!waiting.unavailable?.count ||
        (waiting.inbox_count === null) !== !!waiting.unavailable?.inbox_count ||
        (waiting.count !== null &&
          (waiting.items.length > waiting.count ||
            waiting.inbox_count === null ||
            waiting.inbox_count > waiting.count)) ||
        new Set(waiting.items.map((t) => t.id)).size !== waiting.items.length ||
        waiting.items.some((t) => t.id === t.project_id)
      )
        invalidWaiting();
      const listed = new Map<string | null, number>();
      for (const item of waiting.items)
        listed.set(item.project_id, (listed.get(item.project_id) ?? 0) + 1);
      if (
        waiting.inbox_count !== null &&
        (listed.get(null) ?? 0) > waiting.inbox_count
      )
        invalidWaiting();
      for (const row of projects) {
        if (
          row.waiting_count === undefined
            ? waiting.count !== null
            : (listed.get(row.id) ?? 0) > row.waiting_count
        )
          invalidWaiting();
      }
      if (coverage.complete) {
        if (
          waiting.items.some(
            (t) =>
              t.project_id !== null &&
              !projects.some((p) => p.id === t.project_id),
          )
        )
          invalidWaiting();
        if (
          waiting.count !== null &&
          waiting.count !==
            waiting.inbox_count! +
              projects.reduce((n, p) => n + p.waiting_count!, 0)
        )
          invalidWaiting();
      }
    }
    const partialWaiting = () => {
      if (!waiting) return;
      waiting.coverage.returned = waiting.items.length;
      waiting.coverage.complete = false;
      waiting.coverage.reason =
        waiting.count === null ? "unavailable" : "response_bytes";
      waiting.coverage.drilldown =
        "nofuss_query Inbox roots and active library; nofuss_get project trees with status/tag_ids";
    };
    if (waiting && !waiting.coverage.complete) partialWaiting();
    // Preserve the core project list and per-project counts before compact match IDs.
    while (packingCost(output) > RESPONSE_BYTES && waiting?.items.length) {
      waiting.items.pop();
      partialWaiting();
    }
    const partial = () => {
      coverage.returned = projects.length;
      coverage.complete = false;
      coverage.reason = "response_bytes";
      coverage.drilldown =
        "nofuss_query active library; nofuss_get project tree";
    };
    if (!coverage.complete) partial();
    while (packingCost(output) > RESPONSE_BYTES && projects.length) {
      projects.pop();
      partial();
    }
    if (packingCost(output) > RESPONSE_BYTES)
      throw new ReadError(
        "RESPONSE_LIMIT",
        "Overview envelope exceeds the response budget.",
      );
    return output;
  }
  async status(signal?: AbortSignal) {
    let native: z.infer<typeof StatusOutput>["native"];
    try {
      const observedSchema = z
        .object({
          version: z.string(),
          build: z.string(),
          api_introspection: z.boolean().nullable(),
          api_support: NativeApiSupport,
          read_at: z.string().datetime(),
        })
        .strict();
      const observed = parseNative(
        observedSchema,
        await this.runNative("status", {}, signal),
      );
      native = {
        connected: true,
        version: observed.version,
        build: observed.build,
        api_introspection: observed.api_introspection,
        api_support: observed.api_support,
        observed_at: observed.read_at,
      };
    } catch (error) {
      native = {
        connected: false,
        version: null,
        build: null,
        api_introspection: null,
        api_support: NativeApiSupport.parse({
          source: "installed_omnijs_declarations",
          state: "unavailable",
          members: Object.fromEntries(
            Object.keys(NativeApiSupport.shape.members.shape).map((key) => [
              key,
              "unknown",
            ]),
          ),
          error: errorInfo(error),
        }),
        observed_at: new Date().toISOString(),
        error: errorInfo(error),
      };
    }
    const enabledScopes = enabledWriteScopes(
      await readWritePolicy(this.writeStateDirectory),
    );
    return {
      build: this.build,
      native,
      worker: this.worker.snapshot(),
      capabilities: {
        ...CAPABILITIES,
        writes: enabledScopes.length > 0,
        perspective_rule_writes:
          enabledScopes.includes("perspective.create") ||
          enabledScopes.includes("perspective.update"),
      },
      verification: {
        ...READ_VERIFICATION,
        matches_running_build: native.connected
          ? native.version === READ_VERIFICATION.recorded_native.version &&
            native.build === READ_VERIFICATION.recorded_native.build
          : null,
      },
      sync: {
        state: "unavailable",
        reason: "Connectivity does not establish synchronization completion.",
      },
    };
  }
}
