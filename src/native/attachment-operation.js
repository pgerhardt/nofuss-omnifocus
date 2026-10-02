function attachmentOperation(envelope) {
  const a = envelope.args;
  function fail(code, message) {
    const e = Error(message);
    e.code = code;
    throw e;
  }
  function canonical(v) {
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
    if (v === undefined)
      fail("INVALID_MUTATION", "Required attachment facts absent");
    return JSON.stringify(v);
  }
  function owner(r) {
    const o =
      r.entity === "project"
        ? Project.byIdentifier(r.id)
        : r.entity === "task"
          ? Task.byIdentifier(r.id)
          : null;
    if (!o || o.id.primaryKey !== r.id) return null;
    if (
      r.entity === "task" &&
      o.containingProject &&
      o.containingProject.task === o
    )
      fail("WRONG_ENTITY", "Project root requires project entity");
    return o;
  }
  function directoryTree(root, budget) {
    const rows = [],
      seen = new Set();
    function visit(w, names) {
      if (
        budget.remaining-- <= 0 ||
        rows.length >= 20 ||
        names.length > 4 ||
        seen.has(w) ||
        names.some((n) => typeof n !== "string" || !n || n.length > 128)
      )
        throw Error("Directory metadata bound/cycle");
      seen.add(w);
      const type =
        w.type === FileWrapper.Type.File
          ? "file"
          : w.type === FileWrapper.Type.Directory
            ? "directory"
            : (FileWrapper.Type.Link !== undefined &&
                  w.type === FileWrapper.Type.Link) ||
                (FileWrapper.Type.SymbolicLink !== undefined &&
                  w.type === FileWrapper.Type.SymbolicLink)
              ? "symlink"
              : "unknown";
      const url =
        type === "symlink" ? (w.destination?.toString() ?? null) : null;
      if (url !== null && url.length > 2048) throw Error("Link metadata bound");
      rows.push({
        names,
        type,
        size_bytes: type === "file" ? w.contents.length : null,
        reference_url: url,
      });
      if (type === "directory") {
        if (w.children.length > 20) throw Error("Child metadata bound");
        for (const c of w.children)
          visit(c, [...names, c.preferredFilename ?? c.filename]);
      }
    }
    if (root.children.length > 20) throw Error("Child metadata bound");
    for (const c of root.children)
      visit(c, [c.preferredFilename ?? c.filename]);
    return rows;
  }
  function facts(r, strict) {
    const o = owner(r);
    if (!o) return null;
    const list = o.attachments;
    if (!Array.isArray(list) || list.length > 20)
      fail(
        "UNSUPPORTED_ATTACHMENT",
        "Attachment inventory exceeds 20 wrappers",
      );
    let bytes = 0;
    const treeBudget = { remaining: 20 };
    const items = list.map((w) => {
      const type =
        w.type === FileWrapper.Type.File
          ? "file"
          : w.type === FileWrapper.Type.Directory
            ? "directory"
            : (FileWrapper.Type.Link !== undefined &&
                  w.type === FileWrapper.Type.Link) ||
                (FileWrapper.Type.SymbolicLink !== undefined &&
                  w.type === FileWrapper.Type.SymbolicLink)
              ? "symlink"
              : "unknown";
      const name = w.preferredFilename ?? w.filename;
      if (name !== null && (typeof name !== "string" || name.length > 512))
        fail("UNSUPPORTED_ATTACHMENT", "Attachment filename exceeds bounds");
      let length = null,
        data = null;
      if (type === "file") {
        length = w.contents.length;
        bytes += length;
        if (length <= 16384 && bytes <= 20480) data = w.contents.toBase64();
      }
      if (strict && (type !== "file" || data === null))
        fail(
          "UNSUPPORTED_ATTACHMENT",
          "Mutation requires complete embedded regular-file set within 20 KiB",
        );
      const extra = {};
      if (type === "symlink") {
        const url = w.destination?.toString() ?? null;
        if (url !== null && (typeof url !== "string" || url.length > 2048))
          fail("UNSUPPORTED_ATTACHMENT", "Link metadata bound");
        extra.reference_url = url;
      }
      if (type === "directory") {
        try {
          extra.tree = directoryTree(w, treeBudget);
          extra.tree_status = "available";
        } catch (e) {
          extra.tree = null;
          extra.tree_status = "unsupported";
        }
      }
      return { filename: name, type, size_bytes: length, data, ...extra };
    });
    const t = r.entity === "project" ? o.task : o;
    return {
      id: r.id,
      exists: true,
      project_id: t.containingProject
        ? t.containingProject.id.primaryKey
        : null,
      items,
    };
  }
  try {
    if (envelope.op === "attachment_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          reference: a.reference,
          facts: facts(a.reference, a.strict === true),
        },
      });
    const req = a.request,
      item = req.items[0],
      ref = item.targets[0];
    const receipt = {
      request_key: req.request_key,
      input_hash: a.input_hash,
      finished: true,
      setter_count: 0,
      resource_id: ref.id,
      error: null,
    };
    try {
      if (
        req.operation.version !== 1 ||
        ![
          "task.attach",
          "project.attach",
          "task.detach",
          "project.detach",
        ].includes(req.operation.kind) ||
        req.items.length !== 1 ||
        item.targets.length !== 1 ||
        item.references.length
      )
        fail("INVALID_MUTATION", "Unsupported attachment request");
      const f = facts(ref, true);
      if (!f) fail("INVALID_MUTATION", "Exact attachment owner absent");
      if (!a.authorized_ids.includes(ref.id))
        fail("WRITE_NOT_AUTHORIZED", "Host denies exact attachment owner");
      const pre = item.preconditions.concat(a.plan.items[0].preconditions);
      if (
        !pre.length ||
        pre.some(
          (p) =>
            canonical(p.reference) !== canonical(ref) ||
            p.field !== "snapshot" ||
            canonical(p.expected) !== canonical(f),
        )
      )
        fail("PRECONDITION_CONFLICT", "Attachment set/owner changed");
      const o = owner(ref),
        change = item.changes;
      if (req.operation.kind.endsWith(".attach")) {
        if (
          Object.keys(change).sort().join(",") !== "data,filename" ||
          typeof change.filename !== "string" ||
          !change.filename ||
          /[\/\\\u0000]/.test(change.filename)
        )
          fail("INVALID_MUTATION", "Invalid embedded filename");
        const d = Data.fromBase64(change.data);
        if (
          d.length > 16384 ||
          f.items.length >= 20 ||
          f.items.reduce((n, w) => n + w.size_bytes, 0) + d.length > 20480
        )
          fail("INVALID_MUTATION", "Attachment set exceeds mutation bounds");
        receipt.setter_count++;
        o.addAttachment(FileWrapper.withContents(change.filename, d));
      } else {
        if (
          Object.keys(change).join(",") !== "handle" ||
          typeof a.plan.items[0].payload.selected !== "object"
        )
          fail("INVALID_MUTATION", "Exact content descriptor required");
        const matching = f.items
          .map((w, i) =>
            canonical(w) === canonical(a.plan.items[0].payload.selected)
              ? i
              : -1,
          )
          .filter((i) => i >= 0);
        if (matching.length !== 1)
          fail(
            "INVALID_MUTATION",
            "Ambiguous or absent attachment; no occurrence identity",
          );
        receipt.setter_count++;
        o.removeAttachmentAtIndex(matching[0]);
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_ATTACHMENT_WRITE_FAILED",
        message: e.code
          ? e.message
          : "Attachment setter failed; independently reconcile",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_READ_FAILED",
        message: e.code ? e.message : "Attachment facts unavailable",
      },
    });
  }
}
