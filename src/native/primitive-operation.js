function primitiveOperation(envelope) {
  const a = envelope.args,
    id = (o) => (o ? o.id.primaryKey : null),
    iso = (d) => (d ? d.toISOString() : null),
    key = "_ForecastBlessedTagIdentifier";
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
  function calendar(d) {
    return d
      ? String(d.getFullYear()).padStart(4, "0") +
          "-" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getDate()).padStart(2, "0")
      : null;
  }
  function date(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s))
      fail("INVALID_MUTATION", "Exact calendar date required");
    const parts = s.split("-").map(Number),
      d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (parts[0] < 1000 || calendar(d) !== s)
      fail("INVALID_MUTATION", "Invalid calendar date");
    return d;
  }
  function midnight(d) {
    return (
      !!d &&
      d.getHours() === 0 &&
      d.getMinutes() === 0 &&
      d.getSeconds() === 0 &&
      d.getMilliseconds() === 0
    );
  }
  function facts(ref) {
    if (ref.entity === "document") {
      if (ref.id !== envelope.native_document_id) return null;
      const tag = Tag.forecastTag,
        value = settings.objectForKey(key),
        override = settings.hasNonDefaultObjectForKey(key);
      if (
        typeof value !== "string" ||
        (value || null) !== id(tag) ||
        typeof override !== "boolean"
      )
        fail(
          "UNSUPPORTED_PREFERENCE",
          "Forecast native setting/property disagree",
        );
      return {
        id: ref.id,
        forecast_tag_id: id(tag),
        forecast_value: value,
        forecast_override: override,
      };
    }
    if (ref.entity === "tag") {
      const t = Tag.byIdentifier(ref.id);
      return t
        ? {
            id: id(t),
            name: t.name,
            parent_id: id(t.parent),
            active: t.active,
            allows_next_action: t.allowsNextAction,
          }
        : null;
    }
    if (ref.entity === "project") {
      const p = Project.byIdentifier(ref.id);
      if (!p) return null;
      const v = envelope.scripting_review_interval,
        units = {
          day: "days",
          week: "weeks",
          month: "months",
          year: "years",
          hour: "hours",
          minute: "minutes",
        };
      if (
        !v ||
        v.id !== ref.id ||
        units[v.unit] !== p.reviewInterval.unit ||
        v.steps !== p.reviewInterval.steps ||
        typeof v.fixed !== "boolean"
      )
        fail(
          "NATIVE_UNAVAILABLE",
          "Exact scripting/native review interval unavailable",
        );
      const interval = { unit: v.unit, steps: v.steps, fixed: v.fixed };
      let reset = null;
      if (
        ["day", "week", "month", "year"].includes(v.unit) &&
        Number.isSafeInteger(v.steps) &&
        v.steps >= 1 &&
        v.steps <= 1000 &&
        p.lastReviewDate
      ) {
        const last = p.lastReviewDate,
          today = new Date(),
          day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        let next;
        if (v.unit === "day" || v.unit === "week") {
          const step = v.steps * (v.unit === "week" ? 7 : 1),
            n = Math.max(
              1,
              Math.ceil((day(today) - day(last)) / (step * 86400000)),
            );
          next = new Date(
            last.getFullYear(),
            last.getMonth(),
            last.getDate() + n * step,
          );
        } else {
          const step = v.steps * (v.unit === "year" ? 12 : 1),
            diff =
              (today.getFullYear() - last.getFullYear()) * 12 +
              today.getMonth() -
              last.getMonth();
          let n = Math.max(1, Math.floor(diff / step));
          function candidate(n) {
            const base = new Date(
                last.getFullYear(),
                last.getMonth() + n * step,
                1,
              ),
              days = new Date(
                base.getFullYear(),
                base.getMonth() + 1,
                0,
              ).getDate();
            return new Date(
              base.getFullYear(),
              base.getMonth(),
              Math.min(last.getDate(), days),
            );
          }
          next = candidate(n);
          if (day(next) < day(today)) next = candidate(n + 1);
        }
        if (next.getFullYear() <= 9999) reset = calendar(next);
      }
      return {
        id: id(p),
        name: p.name,
        active: p.status === Project.Status.Active,
        repeat: p.repetitionRule !== null,
        tentative: p.task.assignedContainer !== null,
        last_review_at: iso(p.lastReviewDate),
        next_review_at: iso(p.nextReviewDate),
        next_review_date: calendar(p.nextReviewDate),
        next_review_midnight: midnight(p.nextReviewDate),
        review_interval: interval,
        reset_date: reset,
      };
    }
    fail("INVALID_MUTATION", "Unsupported primitive reference");
  }
  function authorized(kind, ref, p) {
    if (!p || !p.scopes.includes(kind)) return false;
    if (ref.entity === "document")
      return p.allow_preferences && ref.id === envelope.native_document_id;
    if (ref.entity === "tag") return p.tag_ids.includes(ref.id);
    if (ref.entity === "project") return p.project_ids.includes(ref.id);
    return false;
  }
  try {
    if (envelope.op === "primitive_preferences") {
      const document = facts({
          entity: "document",
          id: envelope.native_document_id,
        }),
        tag = a.tag_id ? facts({ entity: "tag", id: a.tag_id }) : null;
      if (a.tag_id && !tag) fail("NOT_FOUND", "Exact preference tag absent");
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          document_id: document.id,
          forecast_tag_id: document.forecast_tag_id,
          tag: tag
            ? { id: tag.id, allows_next_action: tag.allows_next_action }
            : null,
          observed_at: new Date().toISOString(),
        },
      });
    }
    if (envelope.op === "primitive_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference) },
      });
    const req = a.request,
      item = req.items[0],
      kind = req.operation.kind,
      ref = item.targets[0],
      receipt = {
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
        req.items.length !== 1 ||
        a.plan.items.length !== 1 ||
        item.targets.length !== 1 ||
        ![
          "document.set_forecast_tag",
          "tag.set_allows_next_action",
          "project.set_next_review_date",
        ].includes(kind)
      )
        fail("INVALID_MUTATION", "Invalid bounded primitive");
      const refs = [...item.targets, ...item.references],
        pre = [...item.preconditions, ...a.plan.items[0].preconditions];
      if (refs.some((r) => !authorized(kind, r, a.policy)))
        fail("WRITE_NOT_AUTHORIZED", "Primitive exact host authority required");
      if (
        refs.some(
          (r) =>
            !pre.some(
              (p) =>
                canonical(p.reference) === canonical(r) &&
                p.field === "snapshot",
            ),
        ) ||
        pre.some(
          (p) =>
            p.field !== "snapshot" ||
            !refs.some((r) => canonical(r) === canonical(p.reference)) ||
            canonical(facts(p.reference)) !== canonical(p.expected),
        )
      )
        fail("PRECONDITION_CONFLICT", "Primitive native snapshot changed");
      const f = facts(ref);
      if (!f) fail("NOT_FOUND", "Exact primitive target absent");
      if (kind === "document.set_forecast_tag") {
        const value = item.changes.tag_id;
        if (
          ref.entity !== "document" ||
          Object.keys(item.changes).join(",") !== "tag_id" ||
          (value === null
            ? item.references.length !== 0
            : item.references.length !== 1 ||
              item.references[0].entity !== "tag" ||
              item.references[0].id !== value)
        )
          fail("INVALID_MUTATION", "Exact Forecast tag or clear required");
        receipt.setter_count = 1;
        settings.setObjectForKey(value, key);
      } else if (kind === "tag.set_allows_next_action") {
        if (
          ref.entity !== "tag" ||
          item.references.length ||
          Object.keys(item.changes).join(",") !== "allows_next_action" ||
          typeof item.changes.allows_next_action !== "boolean"
        )
          fail("INVALID_MUTATION", "Exact next-action boolean required");
        receipt.setter_count = 1;
        Tag.byIdentifier(ref.id).allowsNextAction =
          item.changes.allows_next_action;
      } else {
        if (
          ref.entity !== "project" ||
          item.references.length ||
          Object.keys(item.changes).join(",") !== "date" ||
          !f.active ||
          f.repeat ||
          f.tentative
        )
          fail(
            "INVALID_MUTATION",
            "Active ordinary direct review target required",
          );
        const next =
          item.changes.date === null ? null : date(item.changes.date);
        if (next === null && !f.reset_date)
          fail(
            "INVALID_MUTATION",
            "Reset requires verified calendar review schedule",
          );
        receipt.setter_count = 1;
        Project.byIdentifier(ref.id).nextReviewDate = next;
      }
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_PRIMITIVE_UNCERTAIN",
        message: e.code
          ? e.message
          : "Native primitive failed; independently reconcile",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_UNAVAILABLE",
        message: e.code ? e.message : "Native primitive unavailable",
      },
    });
  }
}
