function containerLifecycleOperation(envelope) {
  const a = envelope.args,
    id = (o) => (o == null ? null : o.id.primaryKey),
    date = (d) => {
      if (d === undefined) throw Error("Date unavailable");
      return d === null ? null : d.toISOString();
    };
  const canon = (v) =>
    JSON.stringify(v, function (k, x) {
      return x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, x[k]]),
          )
        : x;
    });
  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  function lookup(r) {
    return r.entity === "project"
      ? Project.byIdentifier(r.id)
      : r.entity === "folder"
        ? Folder.byIdentifier(r.id)
        : r.entity === "tag"
          ? Tag.byIdentifier(r.id)
          : r.entity === "task"
            ? Task.byIdentifier(r.id)
            : null;
  }
  function entity(o) {
    return o instanceof Folder
      ? "folder"
      : o instanceof Project
        ? "project"
        : "tag";
  }
  function task(t) {
    if (t.name.length > 512 || t.noteText.string.length > 2048)
      fail("INVALID_MUTATION", "Text bounds");
    return {
      id: id(t),
      entity: t.project !== null ? "project" : "task",
      project_id: id(t.containingProject),
      parent_id: id(t.parent),
      name: t.name,
      note: t.noteText.string,
      flagged: t.flagged,
      tag_ids: t.tags.map(id).sort(),
      due_at: date(t.dueDate),
      defer_at: date(t.deferDate),
      planned_at: date(t.plannedDate),
      completed: t.completed,
      completed_at: date(t.completionDate),
      dropped_at: date(t.dropDate),
      repeating: t.repetitionRule !== null,
      attachments: t.attachments.length,
      notifications: t.notifications.length,
      automatic: t.completedByChildren,
      assigned: id(t.assignedContainer),
      child_ids: t.tasks.map(id),
    };
  }
  function describe(o) {
    const e = entity(o);
    return {
      entity: e,
      id: id(o),
      name: o.name,
      parent_id: id(e === "project" ? o.parentFolder : o.parent),
      status: String(o.status),
      active: e === "project" ? o.task.active : o.active,
      effective_active:
        e === "project" ? o.task.effectiveActive : o.effectiveActive,
      ...(e === "project"
        ? {
            root_id: id(o.task),
            root: task(o.task),
            default_holder: o.defaultSingletonActionHolder,
            type: o.containsSingletonActions
              ? "single_actions"
              : o.sequential
                ? "sequential"
                : "parallel",
          }
        : e === "tag"
          ? { exclusive: o.childrenAreMutuallyExclusive }
          : {}),
    };
  }
  function siblings(o) {
    const e = entity(o),
      parent = e === "project" ? o.parentFolder : o.parent;
    return (
      e === "tag"
        ? parent
          ? parent.tags
          : tags
        : parent
          ? parent.sections
          : library
    ).map((x) => ({ entity: entity(x), id: id(x) }));
  }
  function facts(ref, shallow = false) {
    const o = lookup(ref);
    if (!o) return null;
    if (ref.entity === "task") return { id: ref.id, task: task(o) };
    const nodes = [],
      tasks = [],
      associations = [],
      seen = new Set();
    function walk(x) {
      if (seen.has(id(x)) || nodes.length >= 50)
        fail("INVALID_MUTATION", "Hierarchy cycle or container bound");
      seen.add(id(x));
      nodes.push(describe(x));
      if (shallow) return;
      const e = entity(x);
      if (e === "folder") x.sections.forEach(walk);
      else if (e === "project") {
        const all = [x.task, ...x.flattenedTasks];
        if (tasks.length + all.length > 100)
          fail("INVALID_MUTATION", "Task cascade exceeds 100");
        all.forEach((t) => tasks.push(task(t)));
      } else {
        x.tags.forEach(walk);
        x.tasks.forEach((t) => {
          if (!associations.some((n) => n.id === id(t)))
            associations.push(task(t));
        });
      }
    }
    walk(o);
    if (associations.length > 100)
      fail("INVALID_MUTATION", "Association bound");
    const value = {
      id: ref.id,
      target: describe(o),
      nodes,
      tasks,
      associations,
      sibling_ids: siblings(o),
      forecast_tag_id: id(Tag.forecastTag),
    };
    if (JSON.stringify(value).length > 60000)
      fail("INVALID_MUTATION", "Cascade snapshot exceeds 60 KiB");
    return value;
  }
  function owned(p, ref, b, kind) {
    if (!p.scopes.includes(kind)) return false;
    const nodes = kind.endsWith(".delete") ? b.nodes : [b.target];
    return (
      nodes.every((n) =>
        (n.entity === "project"
          ? p.project_ids
          : n.entity === "folder"
            ? p.folder_ids
            : p.tag_ids
        ).includes(n.id),
      ) &&
      b.associations.every((t) =>
        t.project_id !== null
          ? p.project_ids.includes(t.project_id)
          : p.task_ids.includes(t.id),
      )
    );
  }
  const receipt = {
    request_key: a.request?.request_key,
    input_hash: a.input_hash,
    finished: true,
    setter_count: 0,
    resource_id: null,
    error: null,
  };
  try {
    if (envelope.op === "container_lifecycle_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          reference: a.reference,
          facts: facts(a.reference, a.shallow),
        },
      });
    if (envelope.op === "container_lifecycle_order") {
      const parent =
        a.parent_id === null
          ? null
          : a.entity === "tag"
            ? Tag.byIdentifier(a.parent_id)
            : Folder.byIdentifier(a.parent_id);
      if (a.parent_id !== null && !parent)
        fail("NOT_FOUND", "Exact order container absent");
      const values =
        a.entity === "tag"
          ? parent
            ? parent.tags
            : tags
          : parent
            ? parent.sections
            : library;
      return JSON.stringify({
        request_id: envelope.request_id,
        result: values.map((x) => ({ entity: entity(x), id: id(x) })),
      });
    }
    if (envelope.op === "container_lifecycle_absence")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: a.references.map((r) => ({
          reference: r,
          absent: lookup(r) === null,
        })),
      });
    if (envelope.op !== "container_lifecycle_apply")
      fail("INVALID_MUTATION", "Unsupported container operation");
    const req = a.request,
      item = req.items[0],
      plan = a.plan.items[0],
      kind = req.operation.kind,
      ref = item.targets[0],
      del = kind.endsWith(".delete"),
      b = facts(ref, !del);
    if (
      req.operation.version !== 1 ||
      req.items.length !== 1 ||
      a.plan.items.length !== 1 ||
      ![
        "project.delete",
        "folder.delete",
        "tag.delete",
        "project.reorder",
        "folder.reorder",
        "tag.reorder",
      ].includes(kind) ||
      !b
    )
      fail("INVALID_MUTATION", "Invalid container request");
    if (!owned(a.policy, ref, b, kind))
      fail("WRITE_NOT_AUTHORIZED", "Cascade/association ownership denied");
    if (
      del &&
      (item.payload.cascade !== true ||
        b.nodes.some((n) => n.default_holder || n.id === b.forecast_tag_id) ||
        b.tasks.some((t) => t.attachments || t.notifications || t.assigned))
    )
      fail("INVALID_MUTATION", "Unsupported cascade side effects");
    const refs = [...item.targets, ...item.references];
    if (
      refs.some(
        (r) =>
          !plan.preconditions.some(
            (f) => canon(f.reference) === canon(r) && f.field === "snapshot",
          ),
      )
    )
      fail("INVALID_MUTATION", "Missing exact snapshots");
    for (const f of plan.preconditions)
      if (
        f.field !== "snapshot" ||
        !refs.some((r) => canon(r) === canon(f.reference)) ||
        canon(facts(f.reference, !del)) !== canon(f.expected)
      )
        fail("PRECONDITION_CONFLICT", "Cascade/order snapshot changed");
    const o = lookup(ref);
    let peer;
    if (!del) {
      peer = lookup(item.payload.peer);
      if (
        !peer ||
        id(peer) === id(o) ||
        describe(peer).parent_id !== b.target.parent_id ||
        item.payload.parent_id !== b.target.parent_id ||
        (ref.entity === "tag") !== (item.payload.peer.entity === "tag") ||
        !owned(
          a.policy,
          item.payload.peer,
          facts(item.payload.peer, true),
          kind,
        )
      )
        fail(
          "INVALID_MUTATION",
          "Exact authorized same-container peers required",
        );
    }
    receipt.resource_id = id(o);
    receipt.setter_count++;
    if (del) deleteObject(o);
    else if (ref.entity === "tag")
      moveTags(
        [o],
        item.payload.position === "before" ? peer.before : peer.after,
      );
    else
      moveSections(
        [o],
        item.payload.position === "before" ? peer.before : peer.after,
      );
  } catch (e) {
    if (envelope.op !== "container_lifecycle_apply")
      return JSON.stringify({
        request_id: envelope.request_id,
        error: {
          code: e.code || "NATIVE_CONTAINER_READ_FAILED",
          message: e.message,
        },
      });
    receipt.error = {
      code: e.code || "NATIVE_CONTAINER_WRITE_FAILED",
      message: e.code
        ? e.message
        : "Native dispatch failed; independently reconcile",
    };
  }
  return JSON.stringify({ request_id: envelope.request_id, result: receipt });
}
