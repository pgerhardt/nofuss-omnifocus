function projectOperation(envelope) {
  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  const id = (o) => (o === null ? null : o.id.primaryKey);
  const iso = (d) => {
    if (d === undefined)
      fail("INVALID_MUTATION", "Required native date unavailable");
    return d === null ? null : d.toISOString();
  };
  function canonical(v) {
    if (v === undefined)
      fail("INVALID_MUTATION", "Required native fact unavailable");
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (v && typeof v === "object")
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}"
      );
    return JSON.stringify(v);
  }
  let plannedDeclared;
  function planned(p) {
    try {
      if (plannedDeclared === undefined)
        plannedDeclared = /plannedDate:/.test(
          app.getTypeScriptDeclarations(""),
        );
      return plannedDeclared && p.plannedDate !== undefined;
    } catch (_) {
      return false;
    }
  }
  function status(p) {
    const vals = [
      Project.Status.Active,
      Project.Status.OnHold,
      Project.Status.Done,
      Project.Status.Dropped,
    ];
    const s = ["active", "on_hold", "done", "dropped"][vals.indexOf(p.status)];
    if (!s) fail("INVALID_MUTATION", "Unknown project status");
    return s;
  }
  function facts(ref) {
    if (ref.entity === "folder") {
      const f = Folder.byIdentifier(ref.id);
      return f
        ? {
            exists: true,
            id: id(f),
            parent_id: id(f.parent),
            effective_active: f.effectiveActive,
            children: f.sections.map(id),
          }
        : null;
    }
    if (ref.entity === "tag") {
      const t = Tag.byIdentifier(ref.id);
      if (!t) return null;
      const groups = [];
      let p = t.parent;
      while (p) {
        if (p.childrenAreMutuallyExclusive) groups.push(id(p));
        p = p.parent;
      }
      return { exists: true, id: id(t), exclusive_ancestors: groups.sort() };
    }
    if (ref.entity !== "project")
      fail("INVALID_MUTATION", "Unsupported project reference");
    const p = Project.byIdentifier(ref.id);
    if (!p) return null;
    const result = {
      exists: true,
      id: id(p),
      root_id: id(p.task),
      folder_id: id(p.parentFolder),
      name: p.name,
      note: p.note,
      flagged: p.flagged,
      tag_ids: p.tags.map(id).sort(),
      status: status(p),
      type: p.containsSingletonActions
        ? "single_actions"
        : p.sequential
          ? "sequential"
          : "parallel",
      due_at: iso(p.dueDate),
      defer_at: iso(p.deferDate),
      planned_supported: planned(p),
      planned_at: planned(p) ? iso(p.plannedDate) : null,
      completed_at: iso(p.completionDate),
      dropped_at: iso(p.dropDate),
      repeating: p.repetitionRule !== null,
      floating: p.shouldUseFloatingTimeZone,
      preserved: {
        added: iso(p.task.added),
        estimated_minutes: p.estimatedMinutes,
        completed_by_children: p.completedByChildren,
        default_singleton_holder: p.defaultSingletonActionHolder,
        last_review_at: iso(p.lastReviewDate),
        next_review_at: iso(p.nextReviewDate),
        notifications: p.task.notifications.map(id),
        children: p.flattenedTasks.map((t) => ({
          id: id(t),
          parent_id: id(t.parent),
          name: t.name,
          note: t.noteText.string,
          flagged: t.flagged,
          tag_ids: t.tags.map(id),
          due_at: iso(t.dueDate),
          defer_at: iso(t.deferDate),
          completed_at: iso(t.completionDate),
          dropped_at: iso(t.dropDate),
        })),
      },
    };
    if (args.review_interval_value) {
      const v = args.review_interval_value,
        units = {
          day: "days",
          week: "weeks",
          month: "months",
          year: "years",
          minute: "minutes",
          hour: "hours",
        };
      if (
        v.id !== id(p) ||
        !units[v.unit] ||
        !Number.isSafeInteger(v.steps) ||
        v.steps <= 0 ||
        typeof v.fixed !== "boolean" ||
        p.reviewInterval.unit !== units[v.unit] ||
        p.reviewInterval.steps !== v.steps
      )
        fail("INVALID_MUTATION", "Independent review interval facts disagree");
      result.review_interval = {
        unit: units[v.unit],
        steps: v.steps,
        fixed: v.fixed,
      };
    }
    return result;
  }
  const args = envelope.args;
  try {
    if (envelope.op === "project_write_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: args.reference, facts: facts(args.reference) },
      });
    if (
      !["project_write_apply", "project_review_preflight"].includes(envelope.op)
    )
      fail("INVALID_MUTATION", "Unsupported project operation");
    const receipt = {
      request_key: args.request.request_key,
      input_hash: args.input_hash,
      finished: true,
      setter_count: 0,
      project_id: null,
      error: null,
    };
    try {
      const req = args.request,
        plan = args.plan,
        kind = req.operation.kind;
      if (
        req.operation.version !== 1 ||
        ![
          "project.create",
          "project.update",
          "project.complete",
          "project.drop",
          "project.move",
          "project.set_review_interval",
          "project.mark_reviewed",
        ].includes(kind) ||
        req.items.length !== 1 ||
        plan.items.length !== 1
      )
        fail("INVALID_MUTATION", "Unsupported project request");
      const item = req.items[0],
        change = item.changes,
        payload = item.payload;
      const refs = item.targets.concat(item.references);
      const resolved = refs.map((ref) => {
        const f = facts(ref);
        if (!f) fail("INVALID_MUTATION", "Exact project reference absent");
        return { ref, f };
      });
      for (const fact of item.preconditions.concat(
        plan.items[0].preconditions,
      )) {
        const found = resolved.find(
          (r) => canonical(r.ref) === canonical(fact.reference),
        );
        if (
          !found ||
          fact.field !== "snapshot" ||
          canonical(found.f) !== canonical(fact.expected)
        )
          fail(
            "PRECONDITION_CONFLICT",
            "Native project snapshot changed before setters",
          );
      }
      if (
        resolved.some(
          (r) =>
            !item.preconditions
              .concat(plan.items[0].preconditions)
              .some((f) => canonical(f.reference) === canonical(r.ref)),
        )
      )
        fail(
          "INVALID_MUTATION",
          "Every reference requires a native precondition",
        );
      let p = null;
      const target = resolved.find((r) => r.ref.entity === "project");
      if (kind === "project.create") {
        if (
          item.targets.length ||
          !args.allow_project_creation ||
          !("name" in change)
        )
          fail("WRITE_NOT_AUTHORIZED", "Project constructor not authorized");
      } else {
        if (
          item.targets.length !== 1 ||
          item.targets[0].entity !== "project" ||
          !target ||
          !args.authorized_project_ids.includes(target.f.id)
        )
          fail("WRITE_NOT_AUTHORIZED", "Exact project not authorized");
        p = Project.byIdentifier(target.f.id);
        receipt.project_id = target.f.id;
        if (target.f.repeating)
          fail("INVALID_MUTATION", "Repeating project lifecycle unsupported");
        if (
          ["project.complete", "project.drop"].includes(kind) &&
          !["active", "on_hold"].includes(target.f.status)
        )
          fail("INVALID_MUTATION", "Unfinished project required");
        if (
          "status" in change &&
          !["active", "on_hold"].includes(target.f.status)
        )
          fail("INVALID_MUTATION", "Only active/on-hold transitions supported");
      }
      const folderId =
        payload && "folder_id" in payload ? payload.folder_id : null;
      let folder = null;
      if (folderId !== null) {
        const r = resolved.find(
          (r) => r.ref.entity === "folder" && r.ref.id === folderId,
        );
        if (
          !r ||
          !args.authorized_folder_ids.includes(folderId) ||
          !r.f.effective_active
        )
          fail("WRITE_NOT_AUTHORIZED", "Exact active folder not authorized");
        folder = Folder.byIdentifier(folderId);
      }
      const allowed = [
        "review_interval",
        "name",
        "note",
        "flagged",
        "tag_ids",
        "due_at",
        "defer_at",
        "planned_at",
        "type",
        "status",
      ];
      const review = [
        "project.set_review_interval",
        "project.mark_reviewed",
      ].includes(kind);
      if (
        ("review_interval" in change &&
          kind !== "project.set_review_interval") ||
        (review &&
          (kind === "project.set_review_interval"
            ? Object.keys(change).length !== 1 || !("review_interval" in change)
            : Object.keys(change).length !== 0))
      )
        fail("INVALID_MUTATION", "Review operations are distinct and bounded");
      if (review) {
        if (
          !target ||
          !["active", "on_hold"].includes(target.f.status) ||
          !target.f.review_interval
        )
          fail(
            "INVALID_MUTATION",
            "Verified unfinished review project required",
          );
        if (
          kind === "project.mark_reviewed" &&
          !["days", "weeks", "months", "years"].includes(
            target.f.review_interval.unit,
          )
        )
          fail("INVALID_MUTATION", "Sub-day review scheduling unsupported");
        if (kind === "project.set_review_interval") {
          const v = change.review_interval;
          if (
            !v ||
            Object.keys(v).sort().join(",") !== "fixed,steps,unit" ||
            !["days", "weeks", "months", "years"].includes(v.unit) ||
            !Number.isSafeInteger(v.steps) ||
            v.steps <= 0 ||
            v.steps > 1000 ||
            typeof v.fixed !== "boolean"
          )
            fail("INVALID_MUTATION", "Invalid bounded review interval");
        }
      }
      if (
        Object.keys(change).some((k) => !allowed.includes(k)) ||
        (["project.complete", "project.drop", "project.move"].includes(kind) &&
          Object.keys(change).length)
      )
        fail("INVALID_MUTATION", "Unexpected project field");
      if (
        "name" in change &&
        (typeof change.name !== "string" ||
          !change.name.length ||
          change.name.length > 512)
      )
        fail("INVALID_MUTATION", "Invalid name");
      if (
        "note" in change &&
        (typeof change.note !== "string" || change.note.length > 2048)
      )
        fail("INVALID_MUTATION", "Invalid note");
      if ("flagged" in change && typeof change.flagged !== "boolean")
        fail("INVALID_MUTATION", "Invalid flag");
      if (
        "type" in change &&
        !["parallel", "sequential", "single_actions"].includes(change.type)
      )
        fail("INVALID_MUTATION", "Invalid type");
      if ("status" in change && !["active", "on_hold"].includes(change.status))
        fail("INVALID_MUTATION", "Invalid status");
      for (const key of ["due_at", "defer_at", "planned_at"])
        if (
          key in change &&
          change[key] !== null &&
          (typeof change[key] !== "string" ||
            !Number.isFinite(Date.parse(change[key])) ||
            new Date(change[key]).toISOString() !== change[key])
        )
          fail("INVALID_MUTATION", "Invalid project date");
      if (
        "planned_at" in change &&
        !(p
          ? planned(p)
          : flattenedProjects.length
            ? planned(flattenedProjects[0])
            : inbox.length
              ? planned(inbox[0])
              : false)
      )
        fail("INVALID_MUTATION", "Planned date unavailable");
      const due = "due_at" in change ? change.due_at : target?.f.due_at;
      const defer = "defer_at" in change ? change.defer_at : target?.f.defer_at;
      if (
        ("due_at" in change || "defer_at" in change) &&
        typeof due === "string" &&
        typeof defer === "string" &&
        Date.parse(defer) > Date.parse(due)
      )
        fail("INVALID_MUTATION", "Defer follows due");
      let tags = [];
      if ("tag_ids" in change) {
        if (
          !Array.isArray(change.tag_ids) ||
          change.tag_ids.length > 20 ||
          new Set(change.tag_ids).size !== change.tag_ids.length
        )
          fail("INVALID_MUTATION", "Invalid tags");
        const groups = [];
        tags = change.tag_ids.map((x) => {
          const r = resolved.find(
            (r) => r.ref.entity === "tag" && r.ref.id === x,
          );
          if (!r) fail("INVALID_MUTATION", "Exact tag not preflighted");
          for (const g of r.f.exclusive_ancestors) {
            if (groups.includes(g)) fail("INVALID_MUTATION", "Exclusive tags");
            groups.push(g);
          }
          return Tag.byIdentifier(x);
        });
      }
      // Recheck all native preconditions after complete validation, immediately before first setter.
      for (const r of resolved)
        if (canonical(facts(r.ref)) !== canonical(r.f))
          fail(
            "PRECONDITION_CONFLICT",
            "Project reference changed during preflight",
          );
      if (envelope.op === "project_review_preflight") {
        if (kind !== "project.set_review_interval")
          fail("INVALID_MUTATION", "Only interval dispatch uses JXA preflight");
        return JSON.stringify({
          request_id: envelope.request_id,
          result: receipt,
        });
      }
      if (kind === "project.set_review_interval")
        fail(
          "INVALID_MUTATION",
          "Review fixed setter requires verified scripting record dispatcher",
        );
      if (kind === "project.create") {
        receipt.setter_count++;
        p = new Project(change.name, folder);
        receipt.project_id = id(p);
      }
      if (kind === "project.mark_reviewed") {
        const reviewed = new Date();
        receipt.setter_count++;
        p.lastReviewDate = reviewed;
        receipt.reviewed_at = reviewed.toISOString();
      } else if (kind === "project.complete") {
        receipt.setter_count++;
        p.markComplete();
      } else if (kind === "project.drop") {
        receipt.setter_count++;
        p.status = Project.Status.Dropped;
      } else if (kind === "project.move") {
        receipt.setter_count++;
        moveSections([p], folder ? folder.ending : library.ending);
      } else {
        for (const key of ["name", "note", "flagged"])
          if (key in change) {
            receipt.setter_count++;
            p[key] = change[key];
          }
        let order = ["defer_at", "due_at"];
        if (
          "due_at" in change &&
          change.due_at !== null &&
          (p.deferDate === null ||
            Date.parse(change.due_at) >= p.deferDate.getTime())
        )
          order = ["due_at", "defer_at"];
        for (const key of order.concat(["planned_at"]))
          if (key in change) {
            receipt.setter_count++;
            p[
              {
                due_at: "dueDate",
                defer_at: "deferDate",
                planned_at: "plannedDate",
              }[key]
            ] = change[key] === null ? null : new Date(change[key]);
          }
        if ("type" in change) {
          receipt.setter_count++;
          p.containsSingletonActions = change.type === "single_actions";
          receipt.setter_count++;
          p.sequential = change.type === "sequential";
        }
        if ("status" in change) {
          receipt.setter_count++;
          p.status =
            change.status === "active"
              ? Project.Status.Active
              : Project.Status.OnHold;
        }
        if ("tag_ids" in change) {
          receipt.setter_count++;
          p.clearTags();
          if (tags.length) {
            receipt.setter_count++;
            p.addTags(tags);
          }
        }
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_PROJECT_WRITE_FAILED",
        message: e.code
          ? e.message
          : "Native project operation failed; independently reconcile",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_PROJECT_READ_FAILED",
        message: e.code ? e.message : "Native project facts unavailable",
      },
    });
  }
}
