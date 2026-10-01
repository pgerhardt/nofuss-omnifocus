function perspectiveOperation(envelope) {
  const a = envelope.args,
    canon = (v) =>
      JSON.stringify(v, function (k, x) {
        return x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, x[k]]),
            )
          : x;
      });
  const fail = (code, message) => {
    const e = Error(message);
    e.code = code;
    throw e;
  };
  function facts(r) {
    if (r.entity === "perspective_inventory")
      return { ids: Perspective.Custom.all.map((p) => p.identifier).sort() };
    const p = Perspective.Custom.byIdentifier(r.id);
    if (!p) return null;
    const f = {
      id: p.identifier,
      name: p.name,
      rules: p.archivedFilterRules,
      aggregation: p.archivedTopLevelFilterAggregation,
    };
    if (JSON.stringify(f).length > 16000)
      fail("INVALID_MUTATION", "Perspective snapshot exceeds 16 KiB");
    return f;
  }
  function rule(r, depth = 0) {
    if (depth > 4) fail("INVALID_MUTATION", "Rule depth");
    if (
      r.kind === "availability" &&
      ["remaining", "available", "completed"].includes(r.value) &&
      Object.keys(r).sort().join(",") === "kind,value"
    )
      return { actionAvailability: r.value };
    if (r.kind === "flagged" && Object.keys(r).join(",") === "kind")
      return { actionStatus: "flagged" };
    if (
      r.kind === "group" &&
      ["all", "any", "none"].includes(r.aggregation) &&
      Array.isArray(r.rules) &&
      r.rules.length > 0 &&
      r.rules.length <= 10 &&
      Object.keys(r).sort().join(",") === "aggregation,kind,rules"
    )
      return {
        aggregateType: r.aggregation,
        aggregateRules: r.rules.map((x) => rule(x, depth + 1)),
      };
    fail("INVALID_MUTATION", "Unverified typed rule");
  }
  function validate() {
    const req = a.request,
      item = req.items[0],
      kind = req.operation.kind;
    if (
      req.operation.version !== 1 ||
      req.items.length !== 1 ||
      a.plan.items.length !== 1 ||
      ![
        "perspective.create",
        "perspective.update",
        "perspective.delete",
      ].includes(kind) ||
      !a.policy.scopes.includes(kind)
    )
      fail("WRITE_NOT_AUTHORIZED", "Perspective scope denied");
    const create = kind === "perspective.create";
    if (
      create
        ? !a.policy.allow_perspective_creation
        : !a.policy.perspective_ids.includes(item.targets[0].id)
    )
      fail("WRITE_NOT_AUTHORIZED", "Perspective ownership denied");
    const refs = [...item.targets, ...item.references],
      conditions = [...item.preconditions, ...a.plan.items[0].preconditions];
    if (
      refs.some(
        (r) =>
          !conditions.some(
            (f) => canon(f.reference) === canon(r) && f.field === "snapshot",
          ),
      )
    )
      fail("INVALID_MUTATION", "Missing exact snapshot");
    for (const f of conditions)
      if (
        f.field !== "snapshot" ||
        !refs.some((r) => canon(r) === canon(f.reference)) ||
        canon(facts(f.reference)) !== canon(f.expected)
      )
        fail("PRECONDITION_CONFLICT", "Perspective snapshot changed");
    const c = item.changes;
    if (
      c.name !== undefined &&
      (typeof c.name !== "string" || !c.name || c.name.length > 512)
    )
      fail("INVALID_MUTATION", "Perspective name bound");
    if (
      c.aggregation !== undefined &&
      !["all", "any", "none"].includes(c.aggregation)
    )
      fail("INVALID_MUTATION", "Aggregation");
    if (c.rules !== undefined) {
      if (!Array.isArray(c.rules) || !c.rules.length || c.rules.length > 10)
        fail("INVALID_MUTATION", "Rule count");
      c.rules.forEach((x) => rule(x));
    }
    return { kind, item, create };
  }
  const receipt = {
    request_key: a.request?.request_key,
    input_hash: a.input_hash,
    finished: true,
    setter_count: 0,
    perspective_id: null,
    rolled_back: false,
    error: null,
  };
  try {
    if (envelope.op === "perspective_write_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference) },
      });
    if (envelope.op === "perspective_write_validate") {
      validate();
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { ready: true },
      });
    }
    if (envelope.op !== "perspective_write_apply")
      fail("INVALID_MUTATION", "Unsupported perspective operation");
    let checked;
    if (a.created_id) {
      // Validation ran before the JXA constructor in this same launcher dispatch.
      const req = a.request;
      if (
        req.operation.kind !== "perspective.create" ||
        !a.policy.allow_perspective_creation ||
        !a.policy.scopes.includes("perspective.create")
      )
        fail("WRITE_NOT_AUTHORIZED", "Creation denied");
      checked = { kind: req.operation.kind, item: req.items[0], create: true };
      receipt.setter_count = 1;
      receipt.perspective_id = a.created_id;
    } else checked = validate();
    const { kind, item, create } = checked,
      p = Perspective.Custom.byIdentifier(
        create ? a.created_id : item.targets[0].id,
      );
    if (!p) fail("NOT_FOUND", "Exact custom perspective absent");
    receipt.perspective_id = p.identifier;
    if (create && p.name !== item.changes.name)
      fail("INVALID_MUTATION", "Returned constructor identity/name mismatch");
    if (kind === "perspective.delete") {
      receipt.setter_count++;
      deleteObject(p);
    } else {
      for (const k of ["name", "rules", "aggregation"])
        if (item.changes[k] !== undefined) {
          const v = item.changes[k];
          receipt.setter_count++;
          if (k === "name") p.name = v;
          else if (k === "rules") p.archivedFilterRules = v.map((x) => rule(x));
          else p.archivedTopLevelFilterAggregation = v;
        }
    }
  } catch (e) {
    receipt.error = {
      code: e.code || "NATIVE_PERSPECTIVE_WRITE_FAILED",
      message: e.code
        ? e.message
        : "Native effect may have started; independently reconcile",
    };
    if (a.created_id) {
      try {
        const p = Perspective.Custom.byIdentifier(a.created_id);
        if (p && p.name === a.request.items[0].changes.name) {
          receipt.setter_count++;
          deleteObject(p);
          receipt.rolled_back = true;
        }
      } catch (_) {}
    }
    if (envelope.op !== "perspective_write_apply")
      return JSON.stringify({
        request_id: envelope.request_id,
        error: receipt.error,
      });
  }
  return JSON.stringify({ request_id: envelope.request_id, result: receipt });
}
