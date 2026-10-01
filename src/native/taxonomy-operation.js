function taxonomyOperation(envelope) {
  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }
  const id = (o) => (o === null ? null : o.id.primaryKey);
  function canonical(v) {
    if (v === undefined)
      fail("INVALID_MUTATION", "Required taxonomy fact absent");
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
  function lookup(ref) {
    return ref.entity === "tag"
      ? Tag.byIdentifier(ref.id)
      : ref.entity === "folder"
        ? Folder.byIdentifier(ref.id)
        : fail("INVALID_MUTATION", "Unsupported taxonomy reference");
  }
  function facts(ref) {
    const o = lookup(ref);
    if (!o) return null;
    const ancestors = [],
      exclusive = [];
    let parent = o.parent;
    while (parent) {
      if (ancestors.includes(id(parent)))
        fail("INVALID_MUTATION", "Native hierarchy cycle");
      ancestors.push(id(parent));
      if (ref.entity === "tag" && parent.childrenAreMutuallyExclusive)
        exclusive.push(id(parent));
      parent = parent.parent;
    }
    const tag = ref.entity === "tag";
    const state = tag
      ? o.status === Tag.Status.Active
        ? "active"
        : o.status === Tag.Status.OnHold
          ? "on_hold"
          : o.status === Tag.Status.Dropped
            ? "dropped"
            : null
      : o.status === Folder.Status.Active
        ? "active"
        : o.status === Folder.Status.Dropped
          ? "dropped"
          : null;
    if (!state) fail("INVALID_MUTATION", "Unknown native taxonomy status");
    return {
      exists: true,
      id: id(o),
      name: o.name,
      parent_id: id(o.parent),
      status: state,
      active: o.active,
      effective_active: o.effectiveActive,
      ancestor_ids: ancestors,
      exclusive_ancestors: exclusive,
      children_exclusive: tag ? o.childrenAreMutuallyExclusive : false,
      preserved: {
        added: o.added === null ? null : o.added.toISOString(),
        child_ids: (tag ? o.tags : o.folders).map(id),
        project_ids: tag ? [] : o.projects.map(id),
        associations: tag
          ? o.tasks
              .map((t) => ({ id: id(t), tag_ids: t.tags.map(id) }))
              .sort((a, b) => a.id.localeCompare(b.id))
          : [],
        children_exclusive: tag ? o.childrenAreMutuallyExclusive : false,
        forecast_tag_id: tag ? id(Tag.forecastTag) : null,
      },
    };
  }
  const a = envelope.args;
  try {
    if (envelope.op === "taxonomy_write_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference) },
      });
    if (envelope.op !== "taxonomy_write_apply")
      fail("INVALID_MUTATION", "Unsupported taxonomy operation");
    const req = a.request,
      kind = req.operation.kind,
      entity = kind.split(".")[0],
      verb = kind.split(".")[1];
    const receipt = {
      request_key: req.request_key,
      input_hash: a.input_hash,
      finished: true,
      setter_count: 0,
      resource_id: null,
      error: null,
    };
    try {
      if (
        req.operation.version !== 1 ||
        ![
          "tag.create",
          "tag.update",
          "tag.move",
          "folder.create",
          "folder.update",
          "folder.move",
        ].includes(kind) ||
        req.items.length !== 1 ||
        a.plan.items.length !== 1
      )
        fail("INVALID_MUTATION", "Unsupported taxonomy request");
      const item = req.items[0],
        change = item.changes;
      const refs = item.targets.concat(item.references);
      if (refs.some((r) => r.entity !== entity))
        fail("INVALID_MUTATION", "Taxonomy reference entity mismatch");
      const resolved = refs.map((ref) => {
        const f = facts(ref);
        if (!f) fail("INVALID_MUTATION", "Exact taxonomy reference absent");
        return { ref, f };
      });
      const pre = item.preconditions.concat(a.plan.items[0].preconditions);
      for (const fact of pre) {
        const r = resolved.find(
          (r) => canonical(r.ref) === canonical(fact.reference),
        );
        if (
          !r ||
          fact.field !== "snapshot" ||
          canonical(r.f) !== canonical(fact.expected)
        )
          fail("PRECONDITION_CONFLICT", "Taxonomy native state changed");
      }
      if (
        resolved.some(
          (r) => !pre.some((f) => canonical(f.reference) === canonical(r.ref)),
        )
      )
        fail("INVALID_MUTATION", "Every exact reference requires precondition");
      const authorized =
        entity === "tag" ? a.authorized_tag_ids : a.authorized_folder_ids;
      const target =
        verb === "create"
          ? null
          : resolved.find((r) => r.ref.id === item.targets[0]?.id);
      let o = null;
      if (verb === "create") {
        if (
          item.targets.length ||
          !(entity === "tag"
            ? a.allow_tag_creation
            : a.allow_folder_creation) ||
          !("name" in change)
        )
          fail("WRITE_NOT_AUTHORIZED", "Taxonomy constructor not authorized");
      } else {
        if (
          item.targets.length !== 1 ||
          !target ||
          !authorized.includes(target.ref.id)
        )
          fail("WRITE_NOT_AUTHORIZED", "Taxonomy target not authorized");
        o = lookup(target.ref);
        receipt.resource_id = target.ref.id;
      }
      const parentId =
        item.payload && "parent_id" in item.payload
          ? item.payload.parent_id
          : null;
      const destination =
        typeof parentId === "string"
          ? resolved.find((r) => r.ref.id === parentId)
          : null;
      let parent = null;
      if (parentId !== null) {
        if (
          !destination ||
          !authorized.includes(parentId) ||
          !destination.f.effective_active
        )
          fail("WRITE_NOT_AUTHORIZED", "Exact active parent not authorized");
        parent = lookup(destination.ref);
      }
      if (
        verb === "move" &&
        (parentId === target.ref.id ||
          destination?.f.ancestor_ids.includes(target.ref.id))
      )
        fail("INVALID_MUTATION", "Hierarchy self/descendant cycle");
      if (
        entity === "tag" &&
        (target?.f.exclusive_ancestors.length ||
          destination?.f.exclusive_ancestors.length ||
          destination?.f.children_exclusive)
      )
        fail("INVALID_MUTATION", "Exclusive tag ancestry unsupported");
      if (
        Object.keys(change).some(
          (k) => k !== "name" && (entity !== "tag" || k !== "status"),
        ) ||
        (verb === "move" && Object.keys(change).length) ||
        (verb === "update" && !Object.keys(change).length)
      )
        fail("INVALID_MUTATION", "Unexpected taxonomy field");
      if (
        "name" in change &&
        (typeof change.name !== "string" ||
          !change.name.length ||
          change.name.length > 512)
      )
        fail("INVALID_MUTATION", "Invalid taxonomy name");
      if (
        "status" in change &&
        !["active", "on_hold", "dropped"].includes(change.status)
      )
        fail("INVALID_MUTATION", "Invalid tag status");
      for (const r of resolved)
        if (canonical(facts(r.ref)) !== canonical(r.f))
          fail(
            "PRECONDITION_CONFLICT",
            "Native taxonomy state changed during preflight",
          );
      if (verb === "create") {
        receipt.setter_count++;
        o =
          entity === "tag"
            ? new Tag(change.name, parent)
            : new Folder(change.name, parent);
        receipt.resource_id = id(o);
      }
      if (verb === "move") {
        receipt.setter_count++;
        if (entity === "tag")
          moveTags([o], parent ? parent.ending : tags.ending);
        else moveSections([o], parent ? parent.ending : library.ending);
      } else {
        if ("name" in change) {
          receipt.setter_count++;
          o.name = change.name;
        }
        if ("status" in change) {
          receipt.setter_count++;
          o.status = {
            active: Tag.Status.Active,
            on_hold: Tag.Status.OnHold,
            dropped: Tag.Status.Dropped,
          }[change.status];
        }
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_TAXONOMY_WRITE_FAILED",
        message: e.code
          ? e.message
          : "Taxonomy operation failed; independently reconcile",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_TAXONOMY_READ_FAILED",
        message: e.code ? e.message : "Taxonomy facts unavailable",
      },
    });
  }
}
