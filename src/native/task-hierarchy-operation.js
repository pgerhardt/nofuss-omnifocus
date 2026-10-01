function taskHierarchyOperation(envelope) {
  const a = envelope.args;
  const id = (o) => (o == null ? null : o.id.primaryKey);
  const date = (d) => {
    if (d === undefined) throw Error("Required native date unavailable");
    return d === null ? null : d.toISOString();
  };
  const canon = (v) =>
    JSON.stringify(v, function (k, x) {
      if (x && !Array.isArray(x) && typeof x === "object")
        return Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        );
      return x;
    });
  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  function node(t) {
    if (t.name.length > 512 || t.noteText.string.length > 2048)
      fail(
        "INVALID_MUTATION",
        "Task text exceeds independent verification bounds",
      );
    return {
      id: id(t),
      is_project_root: t.project !== null,
      parent_id: id(t.parent),
      project_id: id(t.containingProject),
      name: t.name,
      note: t.noteText.string,
      flagged: t.flagged,
      tag_ids: t.tags.map(id).sort(),
      due_at: date(t.dueDate),
      defer_at: date(t.deferDate),
      planned_at: date(t.plannedDate),
      estimated_minutes: t.estimatedMinutes,
      sequential: t.sequential,
      completed_by_children: t.completedByChildren,
      floating_time_zone: t.shouldUseFloatingTimeZone,
      completed: t.completed,
      completed_at: date(t.completionDate),
      dropped_at: date(t.dropDate),
      effective_completed: t.effectiveCompletionDate !== null,
      effective_dropped: t.effectiveDropDate !== null,
      effective_due_at: date(t.effectiveDueDate),
      effective_defer_at: date(t.effectiveDeferDate),
      repeating: t.repetitionRule !== null,
      attachment_count: t.attachments.length,
      notification_count: t.notifications.length,
      assigned_container_id: id(t.assignedContainer),
      child_ids: t.tasks.map(id),
    };
  }
  function tree(t) {
    const out = [],
      seen = new Set();
    function walk(x) {
      if (seen.has(id(x)) || out.length >= 50)
        fail("INVALID_MUTATION", "Subtree cycle or more than 50 tasks");
      seen.add(id(x));
      out.push(node(x));
      x.tasks.forEach(walk);
    }
    walk(t);
    return out;
  }
  function facts(ref) {
    if (ref.entity === "inbox")
      return ref.id === "inbox"
        ? { id: "inbox", root_id: null, sibling_ids: inbox.map(id) }
        : null;
    if (ref.entity === "project") {
      const p = Project.byIdentifier(ref.id);
      return p
        ? {
            id: id(p),
            root_id: id(p.task),
            root: node(p.task),
            sibling_ids: p.tasks.map(id),
            active: p.status === Project.Status.Active,
          }
        : null;
    }
    const t = Task.byIdentifier(ref.id);
    if (!t || t.project !== null) return null;
    const ancestors = [];
    let p = t.parent;
    while (p) {
      if (ancestors.some((x) => x.id === id(p)) || ancestors.length > 50)
        fail("INVALID_MUTATION", "Ancestor cycle/bound");
      ancestors.push(node(p));
      p = p.parent;
    }
    const value = {
      id: id(t),
      tree: tree(t),
      ancestors,
      sibling_ids: (t.parent ? t.parent.tasks : inbox).map(id),
    };
    if (JSON.stringify(value).length > 60000)
      fail("INVALID_MUTATION", "Hierarchy exceeds snapshot byte bound");
    return value;
  }
  function eligible(f, kind) {
    if (!f?.tree) fail("INVALID_MUTATION", "Exact ordinary subtree required");
    const all = f.tree.concat(f.ancestors);
    if (
      all.some(
        (n) =>
          n.repeating ||
          n.completed_by_children ||
          n.assigned_container_id !== null,
      )
    )
      fail(
        "INVALID_MUTATION",
        "Repeating/automatic/tentative hierarchy excluded",
      );
    if (f.tree.some((n) => n.attachment_count || n.notification_count))
      fail("INVALID_MUTATION", "Hierarchy attachments/alarms excluded");
    if (
      kind !== "task.delete" &&
      all.some(
        (n) => n.completed || n.effective_completed || n.effective_dropped,
      )
    )
      fail(
        "INVALID_MUTATION",
        "Unfinished effective ordinary hierarchy required",
      );
  }
  const receipt = {
    request_key: a.request?.request_key,
    input_hash: a.input_hash,
    finished: true,
    setter_count: 0,
    task_id: null,
    generated_ids: [],
    error: null,
  };
  try {
    if (envelope.op === "task_hierarchy_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference) },
      });
    if (envelope.op === "task_hierarchy_absence") {
      if (
        !Array.isArray(a.references) ||
        !a.references.length ||
        a.references.length > 50 ||
        a.references.some((r) => r.entity !== "task")
      )
        fail("INVALID_MUTATION", "Bounded exact task absence required");
      return JSON.stringify({
        request_id: envelope.request_id,
        result: a.references.map((r) => ({
          reference: r,
          absent: Task.byIdentifier(r.id) === null,
        })),
      });
    }
    if (envelope.op === "task_hierarchy_order") {
      const r = a.reference;
      let values;
      if (r.entity === "inbox" && r.id === "inbox") values = inbox;
      else if (r.entity === "project") {
        const p = Project.byIdentifier(r.id);
        if (!p) fail("NOT_FOUND", "Exact project container absent");
        values = p.tasks;
      } else if (r.entity === "task") {
        const t = Task.byIdentifier(r.id);
        if (!t || t.project !== null)
          fail("NOT_FOUND", "Exact ordinary parent absent");
        values = t.tasks;
      } else fail("INVALID_MUTATION", "Exact hierarchy container required");
      const value = { reference: r, ids: values.map(id) };
      if (JSON.stringify(value).length > 60000)
        fail("INVALID_MUTATION", "Container order exceeds snapshot bound");
      return JSON.stringify({ request_id: envelope.request_id, result: value });
    }
    if (envelope.op !== "task_hierarchy_apply")
      fail("INVALID_MUTATION", "Unsupported hierarchy operation");
    const req = a.request,
      item = req.items[0],
      plan = a.plan.items[0],
      kind = req.operation.kind;
    if (
      req.operation.version !== 1 ||
      req.items.length !== 1 ||
      a.plan.items.length !== 1 ||
      ![
        "task.duplicate",
        "task.delete",
        "task.drop",
        "task.complete",
        "task.reorder",
      ].includes(kind)
    )
      fail("INVALID_MUTATION", "Invalid hierarchy request");
    const ref = item.targets[0],
      baseline = facts(ref);
    eligible(baseline, kind);
    if (!a.scopes.includes(kind)) fail("WRITE_NOT_AUTHORIZED", "Scope revoked");
    const project = baseline.tree[0].project_id;
    if (
      project === null
        ? !baseline.tree.every((n) => a.task_ids.includes(n.id))
        : !a.project_ids.includes(project)
    )
      fail("WRITE_NOT_AUTHORIZED", "Whole subtree ownership denied");
    const refs = [...item.targets, ...item.references];
    if (
      refs.some(
        (ref) =>
          !plan.preconditions.some(
            (f) => canon(f.reference) === canon(ref) && f.field === "snapshot",
          ),
      )
    )
      fail("INVALID_MUTATION", "Missing exact snapshot");
    for (const f of plan.preconditions)
      if (
        f.field !== "snapshot" ||
        !refs.some((r) => canon(r) === canon(f.reference)) ||
        canon(facts(f.reference)) !== canon(f.expected)
      )
        fail("PRECONDITION_CONFLICT", "Hierarchy snapshot changed");
    const t = Task.byIdentifier(ref.id);
    receipt.task_id = id(t);
    let peer;
    if (kind === "task.reorder") {
      const c = item.payload.container,
        expectedParent =
          c.kind === "inbox"
            ? null
            : c.kind === "parent"
              ? c.task_id
              : Project.byIdentifier(c.project_id)?.task.id.primaryKey;
      peer = Task.byIdentifier(item.payload.peer_id);
      if (
        !peer ||
        id(peer) === id(t) ||
        id(t.parent) !== expectedParent ||
        id(peer.parent) !== expectedParent ||
        id(peer.containingProject) !== project
      )
        fail(
          "INVALID_MUTATION",
          "Reorder requires distinct exact same-container peers",
        );
    } else if (item.payload?.subtree !== true)
      fail("INVALID_MUTATION", "Explicit subtree authorization required");
    receipt.setter_count++;
    if (kind === "task.delete") deleteObject(t);
    else if (kind === "task.drop") t.drop(true);
    else if (kind === "task.complete") t.markComplete();
    else if (kind === "task.reorder")
      moveTasks(
        [t],
        item.payload.position === "before" ? peer.before : peer.after,
      );
    else {
      const copies = duplicateTasks([t], t.after);
      if (copies.length !== 1) throw Error("Unknown duplicate root identity");
      receipt.task_id = id(copies[0]);
      receipt.generated_ids = tree(copies[0]).map((n) => n.id);
    }
  } catch (e) {
    if (envelope.op !== "task_hierarchy_apply")
      return JSON.stringify({
        request_id: envelope.request_id,
        error: {
          code: e.code || "NATIVE_HIERARCHY_READ_FAILED",
          message: e.message,
        },
      });
    receipt.error = {
      code: e.code || "NATIVE_HIERARCHY_WRITE_FAILED",
      message: e.code
        ? e.message
        : "Native hierarchy dispatch failed; independently reconcile",
    };
  }
  return JSON.stringify({ request_id: envelope.request_id, result: receipt });
}
