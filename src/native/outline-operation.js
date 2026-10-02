function outlineOperation(envelope) {
  const a = envelope.args,
    id = (o) => o.id.primaryKey;
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
      fail("INVALID_MUTATION", "Required outline fact absent");
    return JSON.stringify(v);
  }
  function destination(r) {
    const p = r.entity === "project" ? Project.byIdentifier(r.id) : null;
    if (!p) return null;
    if (p.task.children.length > 200)
      fail("UNSUPPORTED_IMPORT", "Destination direct children exceed 200");
    return {
      id: id(p),
      exists: true,
      active: p.status === Project.Status.Active,
      repeat: p.repetitionRule !== null,
      tentative: p.task.assignedContainer !== null,
      child_ids: p.task.children.map(id),
      root_id: id(p.task),
    };
  }
  function walk(root, limit) {
    const rows = [],
      seen = new Set();
    function visit(t, parent) {
      if (rows.length >= limit || seen.has(id(t)))
        fail("UNSUPPORTED_OUTLINE", "Outline exceeds bounded nodes or cycles");
      seen.add(id(t));
      if (t.name.length > 512 || t.note.length > 2048)
        fail(
          "UNSUPPORTED_OUTLINE",
          "Outline text exceeds complete export bounds",
        );
      rows.push({
        id: id(t),
        parent_id: parent,
        name: t.name,
        note: t.note,
        flagged: t.flagged,
        due_at: t.dueDate ? t.dueDate.toISOString() : null,
        defer_at: t.deferDate ? t.deferDate.toISOString() : null,
        attachments: t.attachments.length,
      });
      for (const child of t.children) visit(child, id(t));
    }
    visit(root, null);
    return rows;
  }
  function imported(ids) {
    return ids.map((k) => {
      const t = Task.byIdentifier(k);
      if (!t || id(t) !== k)
        fail("NATIVE_UNAVAILABLE", "Generated exact task absent");
      return {
        id: k,
        name: t.name,
        parent_id: t.parent ? id(t.parent) : null,
        project_id: t.containingProject ? id(t.containingProject) : null,
        child_ids: t.children.map(id),
        note: t.note,
        flagged: t.flagged,
        due_at: t.dueDate?.toISOString() ?? null,
        defer_at: t.deferDate?.toISOString() ?? null,
        estimated_minutes: t.estimatedMinutes,
        ordinary:
          t.tags.length === 0 &&
          t.attachments.length === 0 &&
          t.notifications.length === 0 &&
          t.repetitionRule === null &&
          t.assignedContainer === null &&
          t.plannedDate === null &&
          !t.completed &&
          !t.completedByChildren &&
          t.dropDate === null,
      };
    });
  }
  function parse(text) {
    if (typeof text !== "string" || Data.fromString(text).length > 16384)
      fail("INVALID_MUTATION", "Import text bound");
    const nodes = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const m = /^(\t*)- ([^\u0000-\u001f@]+)$/.exec(line);
      if (
        !m ||
        m[1].length > 10 ||
        !m[2].trim() ||
        m[2] !== m[2].trim() ||
        m[2].length > 512 ||
        m[2].endsWith(":") ||
        nodes.length >= 20
      )
        fail(
          "INVALID_MUTATION",
          "Only 1-20 ordinary tab-indented bullets; no metadata/notes",
        );
      const depth = m[1].length;
      let parent = -1;
      if (depth) {
        for (let i = nodes.length - 1; i >= 0; i--)
          if (nodes[i].depth === depth - 1) {
            parent = i;
            break;
          }
        if (parent < 0 || nodes.at(-1).depth < depth - 1)
          fail("INVALID_MUTATION", "Skipped outline depth");
      }
      nodes.push({ name: m[2], depth, parent });
    }
    if (!nodes.length) fail("INVALID_MUTATION", "Empty import");
    return nodes;
  }
  function validateNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 20)
      fail("INVALID_MUTATION", "Import node bound");
    nodes.forEach((n, i) => {
      if (
        Object.keys(n).sort().join(",") !==
          "defer_at,depth,due_at,estimated_minutes,flagged,name,note,parent" ||
        typeof n.name !== "string" ||
        !n.name ||
        n.name.length > 512 ||
        n.name !== n.name.trim() ||
        /[\u0000-\u001f@]/.test(n.name) ||
        n.name.endsWith(":") ||
        !Number.isInteger(n.depth) ||
        n.depth < 0 ||
        n.depth > 10 ||
        typeof n.note !== "string" ||
        n.note.length > 2048 ||
        n.note !== n.note.trim() ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(n.note) ||
        typeof n.flagged !== "boolean" ||
        (n.estimated_minutes !== null &&
          (!Number.isInteger(n.estimated_minutes) ||
            n.estimated_minutes < 0 ||
            n.estimated_minutes > 100000)) ||
        [n.due_at, n.defer_at].some(
          (s) =>
            s !== null &&
            (typeof s !== "string" ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) ||
              !Number.isFinite(Date.parse(s)) ||
              new Date(s).toISOString() !== s),
        )
      )
        fail("INVALID_MUTATION", "Unsupported import metadata");
      let parent = -1;
      if (n.depth) {
        for (let j = i - 1; j >= 0; j--)
          if (nodes[j].depth === n.depth - 1) {
            parent = j;
            break;
          }
        if (parent < 0 || nodes[i - 1].depth < n.depth - 1)
          fail("INVALID_MUTATION", "Skipped import depth");
      }
      if (parent !== n.parent)
        fail("INVALID_MUTATION", "Import parent mismatch");
    });
    return nodes;
  }
  function opml(text) {
    if (
      typeof text !== "string" ||
      Data.fromString(text).length > 16384 ||
      /<!|<\?(?!xml\s)/i.test(text)
    )
      fail(
        "INVALID_MUTATION",
        "DTD/entities/processing instructions unsupported",
      );
    const d = XML.Document.fromData(Data.fromString(text)),
      root = d.rootElement;
    if (
      root.name !== "opml" ||
      root.attributeNames.some((k) => k !== "version") ||
      !["1.0", "2.0"].includes(root.attributeNamed("version"))
    )
      fail("INVALID_MUTATION", "Strict OPML root required");
    function elements(e) {
      return e.children.filter((x) => {
        if (typeof x === "string") {
          if (x.trim()) fail("INVALID_MUTATION", "Unexpected OPML text");
          return false;
        }
        return true;
      });
    }
    const top = elements(root),
      b = top.filter((e) => e.name === "body");
    if (
      b.length !== 1 ||
      top.some((e) => !["head", "body"].includes(e.name)) ||
      top.filter((e) => e.name === "head").length > 1 ||
      b[0].attributeCount
    )
      fail("INVALID_MUTATION", "Strict OPML body required");
    const head = top.find((e) => e.name === "head");
    if (
      head &&
      (head.attributeCount ||
        elements(head).some(
          (e) =>
            e.name !== "title" ||
            e.attributeCount ||
            e.children.some((x) => typeof x !== "string"),
        ))
    )
      fail("INVALID_MUTATION", "Unsupported OPML head");
    const nodes = [];
    function visit(e, depth, parent) {
      if (
        e.name !== "outline" ||
        e.attributeNames.some(
          (k) =>
            !["text", "_note", "flagged", "due", "defer", "estimate"].includes(
              k,
            ),
        )
      )
        fail("INVALID_MUTATION", "Unsupported OPML field/type");
      const f = e.attributeNamed("flagged"),
        estimate = e.attributeNamed("estimate");
      if (
        (f !== null && !["true", "false"].includes(f)) ||
        (estimate !== null && !/^(0|[1-9]\d*)$/.test(estimate))
      )
        fail("INVALID_MUTATION", "OPML metadata form");
      const index = nodes.length;
      nodes.push({
        name: e.attributeNamed("text"),
        depth,
        parent,
        note: e.attributeNamed("_note") ?? "",
        flagged: f === "true",
        due_at: e.attributeNamed("due"),
        defer_at: e.attributeNamed("defer"),
        estimated_minutes: estimate === null ? null : Number(estimate),
      });
      if (nodes.length > 20 || depth > 10)
        fail("INVALID_MUTATION", "OPML node bound");
      elements(e).forEach((c) => visit(c, depth + 1, index));
    }
    elements(b[0]).forEach((e) => visit(e, 0, -1));
    return validateNodes(nodes);
  }
  try {
    if (envelope.op === "outline_parse_opml")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: opml(a.text),
      });
    if (envelope.op === "outline_export") {
      if (!a.project_id) {
        const folders = [],
          projects = [],
          seen = new Set();
        function folder(f, parent) {
          if (folders.length >= 20 || seen.has(id(f)))
            fail("UNSUPPORTED_EXPORT", "Folder bound/cycle");
          seen.add(id(f));
          if (f.children.length > 25 || f.name.length > 512)
            fail("UNSUPPORTED_EXPORT", "Folder section bound");
          folders.push({
            id: id(f),
            name: f.name,
            parent_id: parent,
            child_ids: f.children.map(id),
          });
          for (const c of f.children) {
            if (c instanceof Folder) folder(c, id(f));
            else if (c instanceof Project) project(c);
            else fail("UNSUPPORTED_EXPORT", "Unsupported section");
          }
        }
        function project(p) {
          if (
            projects.length >= 5 ||
            projects.some((x) => x.project_id === id(p))
          )
            fail("UNSUPPORTED_EXPORT", "Project selection bound/duplicate");
          const rows = walk(p.task, 200);
          projects.push({
            project_id: id(p),
            root_id: id(p.task),
            folder_id: p.parentFolder?.id.primaryKey ?? null,
            rows,
            data: null,
          });
          if (projects.reduce((n, p) => n + p.rows.length, 0) > 200)
            fail("UNSUPPORTED_EXPORT", "Combined node bound");
        }
        if (a.folder_id) {
          const f = Folder.byIdentifier(a.folder_id);
          if (!f) fail("NOT_FOUND", "Exact folder absent");
          folder(f, null);
        } else {
          if (
            !Array.isArray(a.project_ids) ||
            !a.project_ids.length ||
            a.project_ids.length > 5 ||
            new Set(a.project_ids).size !== a.project_ids.length
          )
            fail("INVALID_INPUT", "Exact project selection required");
          for (const k of a.project_ids) {
            const p = Project.byIdentifier(k);
            if (!p) fail("NOT_FOUND", "Exact selected project absent");
            project(p);
          }
        }
        let data = null;
        if (a.format === "taskpaper") {
          if (projects.some((p) => p.rows.some((t) => t.attachments > 0)))
            fail(
              "UNSUPPORTED_EXPORT",
              "Attachment-bearing TaskPaper unsupported",
            );
          const pb = Pasteboard.makeUnique();
          try {
            copyTasksToPasteboard(
              projects.map((p) => Project.byIdentifier(p.project_id).task),
              pb,
            );
            data = projects.length ? pb.string : "";
          } finally {
            pb.clear();
          }
        }
        return JSON.stringify({
          request_id: envelope.request_id,
          result: { projects, folders, data },
        });
      }
      const p = Project.byIdentifier(a.project_id);
      if (!p) fail("NOT_FOUND", "Exact export project absent");
      const rows = walk(p.task, 200);
      let data = null;
      if (a.format === "taskpaper") {
        if (rows.some((t) => t.attachments > 0))
          fail(
            "UNSUPPORTED_EXPORT",
            "Native TaskPaper pasteboard export excludes attachment-bearing outlines",
          );
        const pb = Pasteboard.makeUnique();
        try {
          copyTasksToPasteboard([p.task], pb);
          data = pb.string;
          if (typeof data !== "string")
            fail("NATIVE_UNAVAILABLE", "Native TaskPaper text unavailable");
        } finally {
          pb.clear();
        }
      }
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { project_id: a.project_id, root_id: id(p.task), rows, data },
      });
    }
    if (envelope.op === "import_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: destination(a.reference) },
      });
    if (envelope.op === "import_readback")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          destination: destination({ entity: "project", id: a.project_id }),
          items: imported(a.ids),
        },
      });
    const req = a.request,
      item = req.items[0],
      ref = item.targets[0],
      receipt = {
        request_key: req.request_key,
        input_hash: a.input_hash,
        finished: true,
        setter_count: 0,
        project_id: ref.id,
        inventory: [],
        roots: [],
        error: null,
      };
    try {
      if (
        req.operation.kind !== "project.import_outline" ||
        req.operation.version !== 1 ||
        req.items.length !== 1 ||
        item.targets.length !== 1 ||
        item.references.length ||
        !a.authorized_project_ids.includes(ref.id) ||
        !a.allow_inbox
      )
        fail(
          "WRITE_NOT_AUTHORIZED",
          "Exact project and transient Inbox import authority required",
        );
      const nodes = validateNodes(item.changes.nodes),
        f = destination(ref);
      if (
        !f ||
        f.child_ids.length + nodes.filter((n) => n.parent < 0).length > 200 ||
        !f.active ||
        f.repeat ||
        f.tentative
      )
        fail("INVALID_MUTATION", "Ordinary active exact project required");
      if (
        canonical(parse(item.changes.text)) !==
        canonical(
          nodes.map(({ name, depth, parent }) => ({ name, depth, parent })),
        )
      )
        fail("INVALID_MUTATION", "Canonical paste text/node mismatch");
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
        fail("PRECONDITION_CONFLICT", "Import destination changed");
      const pb = Pasteboard.makeUnique();
      let roots = [];
      try {
        pb.string = item.changes.text;
        if (!canPasteTasks(pb))
          fail("INVALID_MUTATION", "Native outline parser unavailable");
        receipt.setter_count++;
        roots = pasteTasksFromPasteboard(pb);
        // Capture generated identities BEFORE relocation, including every descendant.
        receipt.roots = roots.map(id);
        for (const root of roots) {
          const rows = walk(root, 20);
          receipt.inventory.push(
            ...rows.map((r) => ({
              id: r.id,
              name: r.name,
              parent_id: r.parent_id,
            })),
          );
        }
        if (
          receipt.inventory.length !== nodes.length ||
          new Set(receipt.inventory.map((t) => t.id)).size !== nodes.length ||
          receipt.inventory.some((r, i) => r.name !== nodes[i].name)
        )
          fail(
            "NATIVE_IMPORT_UNCERTAIN",
            "Native generated outline differs from strict parsed input",
          );
        receipt.setter_count++;
        moveTasks(roots, Project.byIdentifier(ref.id).ending);
        nodes.forEach((n, i) => {
          const t = Task.byIdentifier(receipt.inventory[i].id);
          for (const [field, value] of [
            ["note", n.note],
            ["flagged", n.flagged],
            ["dueDate", n.due_at ? new Date(n.due_at) : null],
            ["deferDate", n.defer_at ? new Date(n.defer_at) : null],
            ["estimatedMinutes", n.estimated_minutes],
          ]) {
            receipt.setter_count++;
            t[field] = value;
          }
        });
      } finally {
        pb.clear();
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_IMPORT_UNCERTAIN",
        message: e.code
          ? e.message
          : "Import failed; independently reconcile generated identities",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_READ_FAILED",
        message: e.code ? e.message : "Outline native operation unavailable",
      },
    });
  }
}
