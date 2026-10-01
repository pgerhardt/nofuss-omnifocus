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
  var plannedDeclared;
  function plannedSupported(t) {
    try {
      if (plannedDeclared === undefined)
        plannedDeclared = /plannedDate:/.test(
          app.getTypeScriptDeclarations(""),
        );
      return plannedDeclared && t.plannedDate !== undefined;
    } catch (_) {
      return false;
    }
  }
  function recurrence(t) {
    var r = t.repetitionRule;
    if (r === null) return null;
    if (r === undefined) throw Error("Recurrence unavailable");
    var m = /^FREQ=(DAILY|WEEKLY);INTERVAL=([1-9][0-9]*)$/.exec(r.ruleString);
    var schedule =
      r.scheduleType === Task.RepetitionScheduleType.Regularly
        ? "regularly"
        : r.scheduleType === Task.RepetitionScheduleType.FromCompletion
          ? "from_completion"
          : null;
    var anchor =
      r.anchorDateKey === Task.AnchorDateKey.DueDate
        ? "due"
        : r.anchorDateKey === Task.AnchorDateKey.DeferDate
          ? "defer"
          : null;
    if (
      !m ||
      Number(m[2]) > 1000 ||
      !schedule ||
      !anchor ||
      typeof r.catchUpAutomatically !== "boolean" ||
      (schedule === "from_completion" && r.catchUpAutomatically)
    )
      throw Error("Recurrence outside verified representation");
    return {
      frequency: m[1].toLowerCase(),
      interval: Number(m[2]),
      schedule: schedule,
      anchor: anchor,
      catch_up: r.catchUpAutomatically,
    };
  }
  function extendedFacts(t) {
    var r = t.repetitionRule;
    var typed = null;
    try {
      typed = recurrence(t);
    } catch (_) {
      typed = { unsupported: true };
    }
    return {
      recurrence: typed,
      recurrence_raw:
        r === null
          ? null
          : {
              rule: r.ruleString,
              schedule: String(r.scheduleType),
              anchor: String(r.anchorDateKey),
              catch_up: r.catchUpAutomatically,
            },
      sibling_ids: (t.parent ? t.parent.tasks : inbox).map(id),
      effective_due_at: date(t.effectiveDueDate),
      effective_defer_at: date(t.effectiveDeferDate),
      notifications: t.notifications.map(function (n) {
        var kind =
          n.kind === Task.Notification.Kind.Absolute
            ? "absolute"
            : n.kind === Task.Notification.Kind.DueRelative
              ? "due_relative"
              : null;
        if (!kind || id(n.task) !== id(t))
          fail("INVALID_MUTATION", "Unsupported alarm kind/ownership");
        return {
          id: id(n),
          task_id: id(n.task),
          kind: kind,
          initial_fire_at: date(n.initialFireDate),
          next_fire_at: date(n.nextFireDate),
          absolute_fire_at:
            kind === "absolute" ? date(n.absoluteFireDate) : null,
          relative_offset_minutes:
            kind === "due_relative" ? n.relativeFireOffset / 60 : null,
          repeat_interval_seconds: n.repeatInterval,
          is_snoozed: n.isSnoozed,
          floating_time_zone: n.usesFloatingTimeZone,
        };
      }),
    };
  }
  function inboxFacts() {
    // Read an existing task only to establish database migration support; never construct a probe.
    var sample =
      inbox[0] ||
      (typeof flattenedProjects !== "undefined" && flattenedProjects[0]?.task);
    return {
      exists: true,
      id: "inbox",
      project_id: null,
      planned_supported: !!sample && plannedSupported(sample),
    };
  }
  function facts(ref) {
    if (ref.entity === "inbox") return ref.id === "inbox" ? inboxFacts() : null;
    if (ref.entity === "project") {
      var p = Project.byIdentifier(ref.id);
      if (!p) return null;
      return {
        exists: true,
        id: id(p),
        root_id: id(p.task),
        active: p.status === Project.Status.Active && p.task.effectiveActive,
        repeating: repeating(p.task),
        auto_complete: p.completedByChildren,
        planned_supported: plannedSupported(p.task),
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
      auto = false,
      tentative = false,
      ancestorIds = [];
    while (ancestor) {
      if (ancestorIds.indexOf(id(ancestor)) >= 0)
        fail("INVALID_MUTATION", "Native parent cycle.");
      ancestorIds.push(id(ancestor));
      ancestorRepeats = ancestorRepeats || repeating(ancestor);
      auto = auto || ancestor.completedByChildren;
      tentative = tentative || ancestor.assignedContainer !== null;
      ancestor = ancestor.parent;
    }
    return {
      ...(envelope.args.extended ? extendedFacts(t) : {}),
      exists: true,
      id: id(t),
      project_id: id(t.containingProject),
      parent_id: id(t.parent),
      in_inbox: t.inInbox,
      available: [
        Task.Status.Available,
        Task.Status.Next,
        Task.Status.DueSoon,
        Task.Status.Overdue,
      ].includes(t.taskStatus),
      effective_due_at: date(t.effectiveDueDate),
      effective_defer_at: date(t.effectiveDeferDate),
      effective_planned_at: plannedSupported(t)
        ? date(t.effectivePlannedDate)
        : null,
      assigned_container_id: t.assignedContainer
        ? id(t.assignedContainer)
        : null,
      project_active:
        t.containingProject !== null &&
        t.containingProject.status === Project.Status.Active &&
        t.containingProject.task.effectiveActive,
      name: t.name,
      note: t.noteText.string,
      flagged: t.flagged,
      tag_ids: t.tags.map(id).sort(),
      completed: t.completed,
      effective_completed: t.effectiveCompletionDate !== null,
      dropped: t.effectiveDropDate !== null,
      dropped_at: date(t.dropDate),
      attachment_count: t.attachments.length,
      completed_at: date(t.completionDate),
      repeating: repeating(t),
      ancestor_repeating: ancestorRepeats,
      ancestor_auto_complete: auto,
      ancestor_tentative: tentative,
      has_children: t.hasChildren,
      ancestor_ids: ancestorIds,
      due_at: date(t.dueDate),
      defer_at: date(t.deferDate),
      planned_supported: plannedSupported(t),
      planned_at: plannedSupported(t) ? date(t.plannedDate) : null,
      estimated_minutes: t.estimatedMinutes,
      floating: t.shouldUseFloatingTimeZone,
      preserved: {
        added: date(t.added),
        sequential: t.sequential,
        completed_by_children: t.completedByChildren,
        notification_ids: t.notifications.map(id),
      },
    };
  }
  function validate(request, plan) {
    if (
      !request ||
      request.operation.version !== 1 ||
      [
        "task.create",
        "task.update",
        "task.complete",
        "task.move",
        "task.drop",
        "task.duplicate",
        "task.delete",
      ].indexOf(request.operation.kind) < 0 ||
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
        (k) =>
          [
            "name",
            "note",
            "flagged",
            "tag_ids",
            "due_at",
            "defer_at",
            "planned_at",
            "estimated_minutes",
            "recurrence",
            "notifications",
          ].indexOf(k) < 0,
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
    if (
      (kind === "task.complete" || kind === "task.move") &&
      Object.keys(changes).length
    )
      fail("INVALID_MUTATION", "Completion accepts no fields.");
    ["due_at", "defer_at", "planned_at"].forEach(function (k) {
      if (
        k in changes &&
        changes[k] !== null &&
        (typeof changes[k] !== "string" ||
          !Number.isFinite(Date.parse(changes[k])) ||
          new Date(changes[k]).toISOString() !== changes[k])
      )
        fail("INVALID_MUTATION", "Invalid canonical scheduling date.");
    });
    if (
      "estimated_minutes" in changes &&
      changes.estimated_minutes !== null &&
      (typeof changes.estimated_minutes !== "number" ||
        !Number.isSafeInteger(changes.estimated_minutes) ||
        changes.estimated_minutes < 0)
    )
      fail("INVALID_MUTATION", "Invalid estimate.");
    if (
      ("recurrence" in changes || "notifications" in changes) &&
      envelope.args.extended !== true
    )
      fail("INVALID_MUTATION", "Extended exact snapshots required");
    var compiledRule;
    if ("recurrence" in changes) {
      if (kind !== "task.update")
        fail("INVALID_MUTATION", "Recurrence is update-only");
      var r = changes.recurrence;
      if (
        r !== null &&
        (!r ||
          Object.keys(r).sort().join(",") !==
            "anchor,catch_up,frequency,interval,schedule" ||
          !["daily", "weekly"].includes(r.frequency) ||
          !Number.isSafeInteger(r.interval) ||
          r.interval < 1 ||
          r.interval > 1000 ||
          !["regularly", "from_completion"].includes(r.schedule) ||
          !["due", "defer"].includes(r.anchor) ||
          typeof r.catch_up !== "boolean" ||
          (r.schedule === "from_completion" && r.catch_up))
      )
        fail("INVALID_MUTATION", "Invalid bounded recurrence");
      compiledRule =
        r === null
          ? null
          : new Task.RepetitionRule(
              "FREQ=" + r.frequency.toUpperCase() + ";INTERVAL=" + r.interval,
              null,
              r.schedule === "regularly"
                ? Task.RepetitionScheduleType.Regularly
                : Task.RepetitionScheduleType.FromCompletion,
              r.anchor === "due"
                ? Task.AnchorDateKey.DueDate
                : Task.AnchorDateKey.DeferDate,
              r.catch_up,
            );
    }
    if ("notifications" in changes) {
      if (
        kind !== "task.update" ||
        !Array.isArray(changes.notifications) ||
        changes.notifications.length > 20
      )
        fail("INVALID_MUTATION", "Invalid alarm replacement");
      changes.notifications.forEach(function (n) {
        if (
          !n ||
          !(n.kind === "absolute"
            ? Object.keys(n).sort().join(",") === "fire_at,kind" &&
              typeof n.fire_at === "string" &&
              Number.isFinite(Date.parse(n.fire_at)) &&
              new Date(n.fire_at).toISOString() === n.fire_at
            : n.kind === "due_relative" &&
              Object.keys(n).sort().join(",") ===
                "kind,relative_offset_minutes" &&
              Number.isSafeInteger(n.relative_offset_minutes) &&
              Math.abs(n.relative_offset_minutes) <= 10080)
        )
          fail("INVALID_MUTATION", "Invalid alarm specification");
      });
    }
    var all = item.targets.concat(item.references),
      resolved = all.map((ref) => ({ reference: ref, facts: facts(ref) }));
    if (resolved.some((x) => !x.facts))
      fail("INVALID_MUTATION", "Exact native reference missing or wrong type.");
    var target =
      kind === "task.create" ? null : Task.byIdentifier(item.targets[0].id);
    var createDest = kind === "task.create" ? item.payload.destination : null;
    if (
      kind === "task.create" &&
      ((item.payload.project_id ? 1 : 0) + (createDest ? 1 : 0) !== 1 ||
        (createDest && !["inbox", "parent"].includes(createDest.kind)))
    )
      fail(
        "INVALID_MUTATION",
        "Exactly one explicit create destination required.",
      );
    var createRef =
      kind === "task.create"
        ? item.payload.project_id
          ? { entity: "project", id: item.payload.project_id }
          : createDest.kind === "parent"
            ? { entity: "task", id: createDest.task_id }
            : { entity: "inbox", id: "inbox" }
        : null;
    if (
      createRef &&
      !item.references.some((r) => canonical(r) === canonical(createRef))
    )
      fail("INVALID_MUTATION", "Create destination not pre-resolved.");
    var createFacts = createRef ? facts(createRef) : null;
    var projectId =
      kind === "task.create"
        ? createRef.entity === "project"
          ? createFacts.id
          : createFacts.project_id
        : id(target.containingProject);
    if (plan.items[0].payload.project_id !== projectId)
      fail("PRECONDITION_CONFLICT", "Project scope changed.");
    var inboxOperation =
      projectId === null &&
      (kind === "task.create" ||
        (kind === "task.update" &&
          !("recurrence" in changes || "notifications" in changes)));
    if (
      !["task.move", "task.drop", "task.duplicate", "task.delete"].includes(
        kind,
      ) &&
      !inboxOperation &&
      (kind === "task.create"
        ? createRef.entity === "project"
          ? !createFacts.active
          : !createFacts.project_active
        : !facts(item.targets[0]).project_active)
    )
      fail("INVALID_MUTATION", "Active exact project required.");
    if (
      !(
        (projectId !== null &&
          envelope.args.authorized_project_ids.indexOf(projectId) >= 0) ||
        (inboxOperation && envelope.args.authorized_inbox === true) ||
        (["task.move", "task.drop", "task.duplicate", "task.delete"].includes(
          kind,
        ) &&
          projectId === null &&
          (envelope.args.authorized_task_ids || []).indexOf(id(target)) >= 0)
      )
    )
      fail("WRITE_NOT_AUTHORIZED", "Container not authorized.");
    if (
      (createRef?.entity === "task" ||
        (inboxOperation && kind === "task.update")) &&
      (facts(createRef || item.targets[0]).assigned_container_id !== null ||
        facts(createRef || item.targets[0]).ancestor_tentative)
    )
      fail(
        "INVALID_MUTATION",
        "Tentative target or ancestor containment is unsafe.",
      );
    var createPosition = null;
    if (createRef?.entity === "task") {
      if (
        createFacts.completed ||
        createFacts.effective_completed ||
        createFacts.dropped ||
        createFacts.repeating ||
        createFacts.ancestor_repeating ||
        createFacts.ancestor_auto_complete ||
        createFacts.preserved.completed_by_children ||
        createFacts.assigned_container_id !== null
      )
        fail("INVALID_MUTATION", "Unsafe parent state.");
      createPosition = Task.byIdentifier(createRef.id);
    } else if (createRef?.entity === "project")
      createPosition = Project.byIdentifier(projectId);
    var destination = null;
    if (kind === "task.move") {
      var tf = facts(item.targets[0]);
      if (
        tf.completed ||
        tf.effective_completed ||
        tf.dropped ||
        tf.repeating ||
        tf.ancestor_repeating ||
        tf.ancestor_auto_complete
      )
        fail("INVALID_MUTATION", "Invalid move source state.");
      var d = item.payload.destination;
      if (!d || ["project", "parent", "inbox"].indexOf(d.kind) < 0)
        fail("INVALID_MUTATION", "Invalid destination.");
      if (d.kind === "inbox") destination = inbox.ending;
      else {
        var ref = {
          entity: d.kind === "project" ? "project" : "task",
          id: d.kind === "project" ? d.project_id : d.task_id,
        };
        if (!item.references.some((r) => canonical(r) === canonical(ref)))
          fail("INVALID_MUTATION", "Destination not pre-resolved.");
        var dest = facts(ref),
          dp = d.kind === "project" ? dest.id : dest.project_id;
        if (d.kind === "project") {
          if (!dest.active || dest.repeating || dest.auto_complete)
            fail("INVALID_MUTATION", "Invalid destination project.");
          destination = Project.byIdentifier(ref.id).task.ending;
        } else {
          if (
            dest.id === tf.id ||
            dest.ancestor_ids.indexOf(tf.id) >= 0 ||
            dest.completed ||
            dest.effective_completed ||
            dest.dropped ||
            dest.repeating ||
            dest.ancestor_repeating ||
            dest.ancestor_auto_complete ||
            dest.preserved.completed_by_children ||
            (dp !== null && !dest.project_active)
          )
            fail("INVALID_MUTATION", "Invalid parent or cycle.");
          destination = Task.byIdentifier(ref.id).ending;
        }
        if (
          !(dp !== null
            ? envelope.args.authorized_project_ids.indexOf(dp) >= 0
            : (envelope.args.authorized_task_ids || []).indexOf(dest.id) >= 0)
        )
          fail("WRITE_NOT_AUTHORIZED", "Destination not authorized.");
      }
    }
    if (
      "planned_at" in changes &&
      !(createFacts ? createFacts.planned_supported : plannedSupported(target))
    )
      fail("INVALID_MUTATION", "Planned date unavailable.");
    var due =
      "due_at" in changes
        ? changes.due_at
        : target
          ? date(target.dueDate)
          : null;
    var defer =
      "defer_at" in changes
        ? changes.defer_at
        : target
          ? date(target.deferDate)
          : null;
    if (
      ("due_at" in changes || "defer_at" in changes) &&
      due !== null &&
      defer !== null &&
      Date.parse(defer) > Date.parse(due)
    )
      fail("INVALID_MUTATION", "Defer date must not follow due date.");
    if ("recurrence" in changes || "notifications" in changes) {
      var tf = facts(item.targets[0]);
      if (
        tf.has_children ||
        tf.completed ||
        tf.effective_completed ||
        tf.dropped ||
        tf.ancestor_repeating ||
        tf.ancestor_auto_complete
      )
        fail(
          "INVALID_MUTATION",
          "Rule/alarm edits require an unfinished ordinary leaf",
        );
      // Bound anchor changes separately; no inherited/cleared or jointly edited anchors.
      if (
        "due_at" in changes ||
        "defer_at" in changes ||
        "planned_at" in changes
      )
        fail(
          "INVALID_MUTATION",
          "Anchor dates must be set in a separate request before rule/alarm edits",
        );
      if (
        changes.recurrence &&
        !(changes.recurrence.anchor === "due"
          ? target.dueDate
          : target.deferDate)
      )
        fail("INVALID_MUTATION", "Exact local recurrence anchor required");
      if (
        (changes.notifications || []).some((n) => n.kind === "due_relative") &&
        target.dueDate === null
      )
        fail("INVALID_MUTATION", "Exact local due anchor required");
      if (target.notifications.length > 20)
        fail(
          "INVALID_MUTATION",
          "Existing alarm collection exceeds verification bounds",
        );
      target.notifications.forEach((n) => {
        if (id(n.task) !== id(target))
          fail("INVALID_MUTATION", "Existing alarm owner mismatch");
      });
    }
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
    if (["task.drop", "task.duplicate", "task.delete"].includes(kind)) {
      var tf = facts(item.targets[0]);
      if (
        Object.keys(changes).length ||
        tf.has_children ||
        tf.repeating ||
        tf.ancestor_repeating ||
        tf.ancestor_auto_complete ||
        (kind !== "task.delete" &&
          (tf.completed || tf.effective_completed || tf.dropped))
      )
        fail("INVALID_MUTATION", "Invalid ordinary lifecycle target");
      if (
        kind === "task.duplicate" &&
        tf.tag_ids.some((x) => Tag.byIdentifier(x) === null)
      )
        fail("INVALID_MUTATION", "Copied exact tag missing before duplicate");
      if (
        kind === "task.duplicate" &&
        (tf.attachment_count !== 0 || tf.preserved.notification_ids.length)
      )
        fail(
          "INVALID_MUTATION",
          "Duplicate attachments/notifications unsupported",
        );
    }
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
      createPosition: createPosition,
      compiledRule: compiledRule,
      target: target,
      project: projectId === null ? null : Project.byIdentifier(projectId),
      destination: destination,
      tags: tags.map((r) => Tag.byIdentifier(r.reference.id)),
    };
  }
  function applyOne(request, ready, receipt) {
    var item = request.items[0],
      changes = item.changes,
      t = ready.target;
    if (request.operation.kind === "task.create") {
      receipt.setter_count++;
      t = new Task(changes.name, ready.createPosition);
    }
    receipt.task_id = id(t);
    if (request.operation.kind === "task.move") {
      receipt.setter_count++;
      moveTasks([t], ready.destination);
    } else if (request.operation.kind === "task.drop") {
      receipt.setter_count++;
      t.drop(true);
    } else if (request.operation.kind === "task.delete") {
      receipt.setter_count++;
      deleteObject(t);
    } else if (request.operation.kind === "task.duplicate") {
      receipt.source_task_id = id(t);
      receipt.task_id = null;
      receipt.setter_count++;
      var copies = duplicateTasks([t], t.after);
      if (copies.length !== 1 || id(copies[0]) === receipt.source_task_id)
        fail("INVALID_MUTATION", "Unexpected duplicate identities");
      receipt.task_id = id(copies[0]);
    } else if (request.operation.kind === "task.complete") {
      receipt.setter_count++;
      t.markComplete();
    } else {
      if ("name" in changes && request.operation.kind !== "task.create") {
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
      // Preserve the shared floating setting; no independent floating flags.
      var order = ["defer_at", "due_at"];
      if (
        "due_at" in changes &&
        changes.due_at !== null &&
        (t.deferDate === null ||
          Date.parse(changes.due_at) >= t.deferDate.getTime())
      )
        order = ["due_at", "defer_at"];
      order.concat(["planned_at", "estimated_minutes"]).forEach(function (k) {
        if (!(k in changes)) return;
        receipt.setter_count++;
        var property = {
          due_at: "dueDate",
          defer_at: "deferDate",
          planned_at: "plannedDate",
          estimated_minutes: "estimatedMinutes",
        }[k];
        t[property] =
          changes[k] === null || k === "estimated_minutes"
            ? changes[k]
            : new Date(changes[k]);
      });
      if ("recurrence" in changes) {
        receipt.setter_count++;
        t.repetitionRule = ready.compiledRule;
      }
      if ("notifications" in changes) {
        t.notifications.slice().forEach((n) => {
          receipt.setter_count++;
          t.removeNotification(n);
        });
        changes.notifications.forEach((n) => {
          receipt.setter_count++;
          t.addNotification(
            n.kind === "absolute"
              ? new Date(n.fire_at)
              : n.relative_offset_minutes * 60,
          );
        });
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
  }
  function batch(request, plan) {
    var a = envelope.args,
      receipt = {
        request_key: request.request_key,
        input_hash: a.input_hash,
        finished: true,
        setter_count: 0,
        error: null,
        items: request.items.map((i) => ({
          item_key: i.item_key,
          setter_count: 0,
          task_id: i.targets[0]?.id ?? null,
          error: null,
          attempted: false,
        })),
      };
    try {
      if (
        request.operation.version !== 1 ||
        !request.items.length ||
        request.items.length > 20 ||
        request.items.length !== plan.items.length ||
        request.items.some(
          (item, i) => item.item_key !== plan.items[i].item_key,
        ) ||
        new Set(request.items.map((i) => i.item_key)).size !==
          request.items.length ||
        !(a.authorized_scopes || []).includes("task.batch")
      )
        fail("INVALID_MUTATION", "Invalid batch scope/shape");
      var scalar = request.items.map((i) => ({
        operation: { kind: i.payload.scalar_kind, version: 1 },
        request_key: request.request_key,
        items: [{ ...i, payload: i.payload.scalar_payload }],
      }));
      scalar.forEach((r) => {
        if (
          ![
            "task.create",
            "task.update",
            "task.move",
            "task.complete",
          ].includes(r.operation.kind) ||
          !(a.authorized_scopes || []).includes(r.operation.kind) ||
          Object.keys(r.items[0].changes).some((k) =>
            ["recurrence", "notifications"].includes(k),
          )
        )
          fail("INVALID_MUTATION", "Unverified batch operation/field");
      });
      if (new Set(scalar.map((r) => r.operation.kind)).size !== 1)
        fail("INVALID_MUTATION", "Batch action must be uniform");
      var targets = request.items.flatMap((i) => i.targets);
      if (new Set(targets.map((r) => canonical(r))).size !== targets.length)
        fail("INVALID_MUTATION", "Duplicate batch target");
      request.items.forEach((i) => {
        if (
          i.references.some((r) =>
            targets.some((t) => canonical(r) === canonical(t)),
          )
        )
          fail("INVALID_MUTATION", "Batch target/destination overlap");
        i.targets.forEach((r) => {
          var f = facts(r);
          if (
            f &&
            targets.some(
              (t) => t.entity === "task" && f.ancestor_ids.includes(t.id),
            )
          )
            fail("INVALID_MUTATION", "Batch ancestor overlap");
        });
      });
      // ALL native references, scalar eligibility and optimistic snapshots before ANY setter.
      var ready = scalar.map((r, i) => validate(r, { items: [plan.items[i]] }));
      for (var i = 0; i < scalar.length; i++) {
        var itemReceipt = receipt.items[i];
        itemReceipt.attempted = true;
        try {
          applyOne(scalar[i], ready[i], itemReceipt);
        } catch (e) {
          itemReceipt.error = {
            code: e.code || "NATIVE_TASK_WRITE_FAILED",
            message: e.code
              ? e.message
              : "Batch stopped after native error; independently reconcile",
          };
          receipt.error = itemReceipt.error;
          break;
        }
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_TASK_WRITE_FAILED",
        message: e.code ? e.message : "Native batch validation failed",
      };
    }
    receipt.setter_count = receipt.items.reduce(
      (n, i) => n + i.setter_count,
      0,
    );
    if (receipt.error)
      receipt.items.forEach((i) => {
        if (!i.attempted) i.error = receipt.error;
      });
    return receipt;
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
    var a = envelope.args;
    if (a.request.operation.kind === "task.batch")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: batch(a.request, a.plan),
      });
    var receipt = {
      request_key: a.request.request_key,
      input_hash: a.input_hash,
      finished: true,
      setter_count: 0,
      task_id: null,
      error: null,
    };
    try {
      var ready = validate(a.request, a.plan);
      applyOne(a.request, ready, receipt);
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
