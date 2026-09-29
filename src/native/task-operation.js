function taskOperation(envelope) {
  // Fixed, synchronous task operations. No eval, timers, callbacks, or retries.
  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    throw e;
  }
  function id(x) {
    return x === null ? null : x.id.primaryKey;
  }
  function date(x) {
    if (x === undefined) fail("INVALID_MUTATION", "Required date unavailable.");
    return x === null ? null : x.toISOString();
  }
  function canonical(x) {
    if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
    if (x && typeof x === "object")
      return (
        "{" +
        Object.keys(x)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
          .join(",") +
        "}"
      );
    if (x === undefined)
      fail("INVALID_MUTATION", "Required native fact unavailable.");
    return JSON.stringify(x);
  }
  function repeating(t) {
    if (t.repetitionRule === undefined)
      fail("INVALID_MUTATION", "Repetition state unavailable.");
    return t.repetitionRule !== null;
  }
  function facts(ref) {
    if (ref.entity === "project") {
      var p = Project.byIdentifier(ref.id);
      if (!p) return null;
      return {
        exists: true,
        id: id(p),
        root_id: id(p.task),
        active: p.status === Project.Status.Active,
        repeating: repeating(p.task),
        auto_complete: p.completedByChildren,
      };
    }
    if (ref.entity === "tag") {
      var tag = Tag.byIdentifier(ref.id);
      if (!tag) return null;
      var groups = [],
        cursor = tag.parent;
      while (cursor) {
        if (cursor.childrenAreMutuallyExclusive) groups.push(id(cursor));
        cursor = cursor.parent;
      }
      return { exists: true, id: id(tag), exclusive_ancestors: groups.sort() };
    }
    if (ref.entity !== "task")
      fail("INVALID_MUTATION", "Unsupported reference entity.");
    var t = Task.byIdentifier(ref.id);
    if (!t || t.project !== null) return null;
    var ancestor = t.parent,
      ancestorRepeats = false,
      auto = false;
    while (ancestor) {
      ancestorRepeats = ancestorRepeats || repeating(ancestor);
      auto = auto || ancestor.completedByChildren;
      ancestor = ancestor.parent;
    }
    return {
      exists: true,
      id: id(t),
      project_id: id(t.containingProject),
      parent_id: id(t.parent),
      project_active:
        t.containingProject !== null &&
        t.containingProject.status === Project.Status.Active,
      name: t.name,
      note: t.noteText.string,
      flagged: t.flagged,
      tag_ids: t.tags.map(id).sort(),
      completed: t.completed,
      effective_completed: t.effectiveCompletionDate !== null,
      dropped: t.effectiveDropDate !== null,
      completed_at: date(t.completionDate),
      repeating: repeating(t),
      ancestor_repeating: ancestorRepeats,
      ancestor_auto_complete: auto,
      has_children: t.hasChildren,
      preserved: {
        due_at: date(t.dueDate),
        defer_at: date(t.deferDate),
        added: date(t.added),
        estimated_minutes: t.estimatedMinutes,
        sequential: t.sequential,
        completed_by_children: t.completedByChildren,
        floating: t.shouldUseFloatingTimeZone,
        notification_ids: t.notifications.map(id),
      },
    };
  }
  function validate(request, plan) {
    if (
      !request ||
      request.operation.version !== 1 ||
      ["task.create", "task.update", "task.complete"].indexOf(
        request.operation.kind,
      ) < 0 ||
      request.items.length !== 1 ||
      plan.items.length !== 1
    )
      fail("INVALID_MUTATION", "Unsupported task operation.");
    var item = request.items[0],
      kind = request.operation.kind,
      changes = item.changes;
    if (
      !changes ||
      Object.keys(changes).some(
        (k) => ["name", "note", "flagged", "tag_ids"].indexOf(k) < 0,
      )
    )
      fail("INVALID_MUTATION", "Unsupported task field.");
    if (
      "name" in changes &&
      (typeof changes.name !== "string" ||
        changes.name.length === 0 ||
        changes.name.length > 512)
    )
      fail("INVALID_MUTATION", "Invalid name.");
    if (
      "note" in changes &&
      (typeof changes.note !== "string" || changes.note.length > 2048)
    )
      fail("INVALID_MUTATION", "Invalid note.");
    if ("flagged" in changes && typeof changes.flagged !== "boolean")
      fail("INVALID_MUTATION", "Invalid flag.");
    if (
      "tag_ids" in changes &&
      (!Array.isArray(changes.tag_ids) ||
        changes.tag_ids.length > 20 ||
        new Set(changes.tag_ids).size !== changes.tag_ids.length ||
        changes.tag_ids.some((x) => typeof x !== "string" || !x))
    )
      fail("INVALID_MUTATION", "Invalid/duplicate tags.");
    if (kind === "task.create" && !("name" in changes))
      fail("INVALID_MUTATION", "Name required.");
    if (kind === "task.update" && !Object.keys(changes).length)
      fail("INVALID_MUTATION", "Empty update.");
    if (kind === "task.complete" && Object.keys(changes).length)
      fail("INVALID_MUTATION", "Completion accepts no fields.");
    var all = item.targets.concat(item.references),
      resolved = all.map((ref) => ({ reference: ref, facts: facts(ref) }));
    if (resolved.some((x) => !x.facts))
      fail("INVALID_MUTATION", "Exact native reference missing or wrong type.");
    var target =
      kind === "task.create" ? null : Task.byIdentifier(item.targets[0].id);
    var projectId =
      kind === "task.create"
        ? item.payload.project_id
        : id(target.containingProject);
    if (plan.items[0].payload.project_id !== projectId)
      fail("PRECONDITION_CONFLICT", "Project scope changed.");
    if (
      kind === "task.create"
        ? !resolved.some(
            (x) =>
              x.reference.entity === "project" &&
              x.reference.id === projectId &&
              x.facts.active,
          )
        : !facts(item.targets[0]).project_active
    )
      fail("INVALID_MUTATION", "Active exact project required.");
    if (envelope.args.authorized_project_ids.indexOf(projectId) < 0)
      fail("WRITE_NOT_AUTHORIZED", "Project not authorized.");
    var tags = (changes.tag_ids || []).map((x) => {
      var r = resolved.find(
        (r) => r.reference.entity === "tag" && r.reference.id === x,
      );
      if (!r) fail("INVALID_MUTATION", "Tag not pre-resolved.");
      return r;
    });
    var groups = [];
    tags.forEach((r) =>
      r.facts.exclusive_ancestors.forEach((g) => {
        if (groups.indexOf(g) >= 0)
          fail("INVALID_MUTATION", "Mutually exclusive tag set.");
        groups.push(g);
      }),
    );
    if (kind === "task.complete") {
      var tf = facts(item.targets[0]);
      if (tf.repeating || tf.ancestor_repeating)
        fail(
          "REPEATING_COMPLETION_UNSUPPORTED",
          "Repeating completion is unsupported.",
        );
      if (
        tf.completed ||
        tf.effective_completed ||
        tf.dropped ||
        tf.has_children ||
        tf.ancestor_auto_complete
      )
        fail(
          "INVALID_MUTATION",
          "Completion requires an unfinished ordinary leaf without automatic ancestor completion.",
        );
    }
    if (
      all.some(
        (ref) =>
          !plan.items[0].preconditions.some(
            (f) =>
              f.field === "snapshot" &&
              canonical(f.reference) === canonical(ref),
          ),
      )
    )
      fail(
        "INVALID_MUTATION",
        "Every exact reference requires a planned snapshot.",
      );
    // Full validation above; re-resolve ALL exact facts immediately before setters.
    plan.items[0].preconditions.forEach((f) => {
      if (
        f.field !== "snapshot" ||
        !all.some((r) => canonical(r) === canonical(f.reference))
      )
        fail("INVALID_MUTATION", "Invalid precondition reference.");
      if (canonical(facts(f.reference)) !== canonical(f.expected))
        fail("PRECONDITION_CONFLICT", "Native pre-setter fact mismatch.");
    });
    return {
      target: target,
      project: Project.byIdentifier(projectId),
      tags: tags.map((r) => Tag.byIdentifier(r.reference.id)),
    };
  }
  try {
    if (envelope.op === "task_write_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          reference: envelope.args.reference,
          facts: facts(envelope.args.reference),
        },
      });
    if (envelope.op !== "task_write_apply")
      fail("INVALID_MUTATION", "Unsupported native task operation.");
    var a = envelope.args,
      receipt = {
        request_key: a.request.request_key,
        input_hash: a.input_hash,
        finished: true,
        setter_count: 0,
        task_id: null,
        error: null,
      };
    try {
      var ready = validate(a.request, a.plan),
        item = a.request.items[0],
        changes = item.changes,
        t = ready.target;
      if (a.request.operation.kind === "task.create") {
        receipt.setter_count++;
        t = new Task(changes.name, ready.project);
      }
      receipt.task_id = id(t);
      if (a.request.operation.kind === "task.complete") {
        receipt.setter_count++;
        t.markComplete();
      } else {
        if ("name" in changes && a.request.operation.kind !== "task.create") {
          receipt.setter_count++;
          t.name = changes.name;
        }
        if ("note" in changes) {
          receipt.setter_count++;
          t.note = changes.note;
        }
        if ("flagged" in changes) {
          receipt.setter_count++;
          t.flagged = changes.flagged;
        }
        if ("tag_ids" in changes) {
          receipt.setter_count++;
          t.clearTags();
          if (ready.tags.length) {
            receipt.setter_count++;
            t.addTags(ready.tags);
          }
        }
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_TASK_WRITE_FAILED",
        message: e.code
          ? e.message
          : "Native task operation failed; independently reconcile.",
      };
    }
    // This acknowledgement records dispatch facts/identity, never final-state proof.
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_TASK_READ_FAILED",
        message: e.code ? e.message : "Native task facts unavailable.",
      },
    });
  }
}
