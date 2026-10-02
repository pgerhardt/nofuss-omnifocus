function syncOperation(envelope) {
  const app = Application("OmniFocus"),
    a = envelope.args,
    d = app.defaultDocument;
  function fail(code, message) {
    const e = Error(message);
    e.code = code;
    throw e;
  }
  function facts() {
    const id = d.id();
    if (typeof id !== "string" || !id)
      fail("NATIVE_UNAVAILABLE", "Default document identity unavailable");
    const unavailable = [],
      out = {
        document_id: id,
        sync_completion: "unavailable",
        last_attempted_sync: "unavailable",
        last_successful_sync: "unavailable",
        pending_local_changes: "unavailable",
        remote_acknowledgement: "unavailable",
      };
    for (const [field, getter] of [
      ["syncing", "syncing"],
      ["last_sync_date", "lastSyncDate"],
      ["last_sync_error", "lastSyncError"],
    ]) {
      try {
        const v = d[getter]();
        if (field === "syncing" && typeof v !== "boolean") throw Error();
        if (field === "last_sync_date" && v !== null && !(v instanceof Date))
          throw Error();
        if (field === "last_sync_error" && v !== null && typeof v !== "string")
          throw Error();
        out[field] =
          v instanceof Date
            ? v.toISOString()
            : field === "last_sync_error"
              ? v === null
                ? null
                : { present: v.length > 0 }
              : v;
      } catch (_) {
        out[field] = null;
        unavailable.push(field);
      }
    }
    out.unavailable = unavailable;
    out.observed_at = new Date().toISOString();
    return out;
  }
  try {
    if (envelope.op === "sync_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: facts(),
      });
    const req = a.request,
      receipt = {
        request_key: req.request_key,
        input_hash: a.input_hash,
        finished: true,
        setter_count: 0,
        document_id: null,
        accepted: false,
        error: null,
      };
    try {
      const item = req.items[0],
        ref = item.targets[0],
        before = facts();
      receipt.document_id = before.document_id;
      if (
        req.operation.kind !== "sync.trigger" ||
        req.operation.version !== 1 ||
        req.items.length !== 1 ||
        item.targets.length !== 1 ||
        item.references.length ||
        ref.entity !== "document" ||
        ref.id !== before.document_id ||
        !a.allow_sync
      )
        fail(
          "WRITE_NOT_AUTHORIZED",
          "Exact default document sync authorization required",
        );
      const pre = item.preconditions.concat(a.plan.items[0].preconditions);
      if (
        !pre.length ||
        pre.some(
          (f) =>
            f.reference.entity !== "document" ||
            f.reference.id !== ref.id ||
            f.field !== "document_id" ||
            f.expected !== before.document_id,
        )
      )
        fail("PRECONDITION_CONFLICT", "Default document changed");
      receipt.setter_count++;
      d.synchronize();
      receipt.accepted = true;
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_SYNC_UNCERTAIN",
        message: e.code
          ? e.message
          : "Sync dispatch failed; acceptance unknown",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_UNAVAILABLE",
        message: e.code ? e.message : "Native sync facts unavailable",
      },
    });
  }
}
