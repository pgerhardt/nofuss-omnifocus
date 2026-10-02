function ordinaryTaskOperation(envelope) {
  const a = envelope.args,
    iso = (d) => {
      if (d === undefined)
        fail("NATIVE_UNAVAILABLE", "Required task date unavailable");
      return d ? d.toISOString() : null;
    },
    id = (o) => (o ? o.id.primaryKey : null);
  const canonical = (v) =>
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
    const e = Error(message);
    e.code = code;
    throw e;
  }
  function noteRuns(t) {
    const runs = t.noteText.attributeRuns;
    if (runs.length > 100)
      fail("UNSUPPORTED_NOTE_STYLE", "Rich note run bound");
    if (runs.some((r) => r.style.namedStyles.length !== 0))
      fail("UNSUPPORTED_NOTE_STYLE", "Named rich note styles unsupported");
    return runs.map((r) => ({
      text: r.string,
      attributes: r.style.locallyDefinedAttributes
        .map((a) => {
          const v = r.style.get(a);
          let value;
          if (v === null || ["string", "number", "boolean"].includes(typeof v))
            value = v;
          else if (a.key === Style.Attribute.Link.key)
            value = { url: v.toString() };
          else if (v instanceof Color)
            value = {
              color_space: String(v.colorSpace),
              red: v.red,
              green: v.green,
              blue: v.blue,
              alpha: v.alpha,
            };
          else
            fail("UNSUPPORTED_NOTE_STYLE", "Unsupported rich note attribute");
          return { key: a.key, value };
        })
        .sort((a, b) => a.key.localeCompare(b.key)),
    }));
  }
  function row(t) {
    return {
      id: id(t),
      parent_id: id(t.parent),
      project_id: id(t.containingProject),
      name: t.name,
      note: t.note,
      flagged: t.flagged,
      tags: t.tags.map(id),
      due: iso(t.dueDate),
      defer: iso(t.deferDate),
      planned: iso(t.plannedDate),
      effective_planned: iso(t.effectivePlannedDate),
      estimated: t.estimatedMinutes,
      completed: t.completed,
      completion: iso(t.completionDate),
      drop: iso(t.dropDate),
      effective_completion: iso(t.effectiveCompletionDate),
      effective_drop: iso(t.effectiveDropDate),
      effective_due: iso(t.effectiveDueDate),
      effective_defer: iso(t.effectiveDeferDate),
      floating: t.shouldUseFloatingTimeZone,
      sequential: t.sequential,
      auto: t.completedByChildren,
      repeat: t.repetitionRule !== null,
      tentative: t.assignedContainer !== null,
      attachments: t.attachments.length,
      notifications: t.notifications.length,
      child_ids: t.children.map(id),
      note_runs: noteRuns(t),
    };
  }
  function facts(ref) {
    if (ref.entity === "folder" || ref.entity === "library") {
      const o = ref.entity === "folder" ? Folder.byIdentifier(ref.id) : library;
      if (!o) return null;
      const children = ref.entity === "folder" ? o.children : library;
      if (children.length > 200)
        fail("UNSUPPORTED_CONVERSION", "Destination sections exceed 200");
      return { id: ref.id, child_ids: children.map(id) };
    }
    const t = ref.entity === "task" ? Task.byIdentifier(ref.id) : null;
    if (!t) return null;
    const rows = [];
    function visit(x) {
      if (rows.length >= 50)
        fail("UNSUPPORTED_CONVERSION", "Subtree exceeds 50 tasks");
      const r = row(x);
      if (r.name.length > 512 || r.note.length > 2048)
        fail("UNSUPPORTED_CONVERSION", "Complete task text exceeds bounds");
      rows.push(r);
      x.children.forEach(visit);
    }
    visit(t);
    const ancestors = [];
    let p = t.parent;
    while (p) {
      if (ancestors.length >= 50)
        fail("UNSUPPORTED_CONVERSION", "Ancestor depth exceeds 50");
      ancestors.push(row(p));
      p = p.parent;
    }
    const peers = t.parent
      ? t.parent.children
      : t.project
        ? t.project.parentFolder
          ? t.project.parentFolder.children
          : library
        : inbox;
    if (peers.length > 200)
      fail("UNSUPPORTED_CONVERSION", "Source siblings exceed 200");
    const result = {
      id: ref.id,
      root_project: id(t.project),
      rows,
      ancestors,
      sibling_ids: peers.map(id),
    };
    if (Data.fromString(JSON.stringify(result)).length > 24000)
      fail("UNSUPPORTED_CONVERSION", "Complete task snapshot exceeds 24 KiB");
    return result;
  }
  function authorized(kind, ref, f, p) {
    if (!p || !p.scopes.includes(kind)) return false;
    if (ref.entity === "folder") return p.folder_ids.includes(ref.id);
    if (ref.entity === "library") return p.allow_project_creation;
    return (
      f &&
      f.rows.every((r) =>
        r.project_id
          ? p.project_ids.includes(r.project_id)
          : p.allow_inbox && p.task_ids.includes(r.id),
      )
    );
  }
  function validate() {
    const req = a.request,
      item = req.items[0],
      kind = req.operation.kind,
      ref = item.targets[0];
    if (
      req.operation.version !== 1 ||
      req.items.length !== 1 ||
      a.plan.items.length !== 1 ||
      !["task.uncomplete", "task.undrop", "task.convert_to_project"].includes(
        kind,
      ) ||
      item.targets.length !== 1 ||
      ref.entity !== "task"
    )
      fail("INVALID_MUTATION", "Invalid ordinary task operation");
    const refs = [...item.targets, ...item.references],
      f = facts(ref);
    if (refs.some((r) => !authorized(kind, r, facts(r), a.policy)))
      fail(
        "WRITE_NOT_AUTHORIZED",
        "Exact source and destination authority required",
      );
    const pre = [...item.preconditions, ...a.plan.items[0].preconditions];
    if (
      refs.some(
        (r) =>
          !pre.some(
            (p) =>
              canonical(p.reference) === canonical(r) && p.field === "snapshot",
          ),
      ) ||
      pre.some(
        (p) =>
          p.field !== "snapshot" ||
          !refs.some((r) => canonical(r) === canonical(p.reference)) ||
          canonical(facts(p.reference)) !== canonical(p.expected),
      )
    )
      fail("PRECONDITION_CONFLICT", "Ordinary task snapshot changed");
    if (
      !f ||
      f.root_project ||
      f.id.includes(".") ||
      f.ancestors.some(
        (r) => r.repeat || r.auto || r.tentative || r.completed || r.drop,
      )
    )
      fail(
        "INVALID_MUTATION",
        "Ordinary local task without unsafe ancestors required",
      );
    const root = f.rows[0];
    if (
      f.rows.some(
        (r) =>
          r.repeat || r.auto || r.tentative || r.attachments || r.notifications,
      )
    )
      fail(
        "INVALID_MUTATION",
        "Repeating, automatic, tentative, rich, attached or alarm-bearing tasks unsupported",
      );
    if (kind === "task.convert_to_project") {
      if (
        !a.policy.allow_project_creation ||
        item.references.length !== 1 ||
        Object.keys(item.changes).join(",") !== "destination" ||
        !["library", "folder"].includes(item.references[0].entity) ||
        canonical(item.changes.destination) !== canonical(item.references[0]) ||
        f.rows.some((r) => r.completed || r.drop) ||
        root.effective_due !== root.due ||
        root.effective_defer !== root.defer ||
        root.effective_planned !== root.planned
      )
        fail(
          "INVALID_MUTATION",
          "Conversion requires explicit owned destination and unfinished independent anchors",
        );
      if (facts(item.references[0]).child_ids.length >= 200)
        fail("INVALID_MUTATION", "Destination full");
    } else if (
      item.references.length ||
      Object.keys(item.changes).length ||
      f.rows.length !== 1 ||
      (kind === "task.uncomplete"
        ? !root.completed || root.drop
        : root.completed || !root.drop)
    )
      fail(
        "INVALID_MUTATION",
        "Exact locally completed/dropped ordinary leaf required",
      );
    return {
      f,
      kind,
      t: Task.byIdentifier(ref.id),
      destination: item.references[0],
    };
  }
  try {
    if (envelope.op === "ordinary_task_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference) },
      });
    if (envelope.op === "ordinary_task_readback") {
      const p = a.project_id ? Project.byIdentifier(a.project_id) : null;
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          source: facts(a.source),
          destination: a.destination ? facts(a.destination) : null,
          source_order:
            (a.source_parent_id
              ? Task.byIdentifier(a.source_parent_id)?.children
              : inbox
            )?.map(id) ?? null,
          old_ancestors: (a.ancestor_ids || []).map((k) => {
            const t = Task.byIdentifier(k);
            return t ? row(t) : null;
          }),
          project: p
            ? {
                id: id(p),
                root_id: id(p.task),
                folder_id: id(p.parentFolder),
                status: p.status === Project.Status.Active ? "active" : "other",
              }
            : null,
        },
      });
    }
    const receipt = {
      request_key: a.request.request_key,
      input_hash: a.input_hash,
      finished: true,
      setter_count: 0,
      resource_id: a.request.items[0].targets[0].id,
      error: null,
    };
    try {
      const ready = validate();
      if (envelope.op === "ordinary_task_validate")
        return JSON.stringify({
          request_id: envelope.request_id,
          result: receipt,
        });
      receipt.setter_count = 1;
      if (ready.kind === "task.uncomplete") ready.t.markIncomplete();
      else if (ready.kind === "task.convert_to_project") {
        const position =
          ready.destination.entity === "folder"
            ? Folder.byIdentifier(ready.destination.id).ending
            : library.ending;
        const result = convertTasksToProjects([ready.t], position);
        receipt.resource_id = null;
        if (result.length !== 1)
          fail(
            "NATIVE_CONVERSION_UNCERTAIN",
            "Returned conversion identity unavailable",
          );
        receipt.resource_id = id(result[0]);
      } else
        fail("INVALID_MUTATION", "Undrop requires native scripting dispatcher");
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_TASK_UNCERTAIN",
        message: e.code
          ? e.message
          : "Native operation failed; reconcile exact objects",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_UNAVAILABLE",
        message: e.code ? e.message : "Ordinary task facts unavailable",
      },
    });
  }
}
