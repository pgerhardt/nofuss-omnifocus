function locationOperation(envelope) {
  const app = Application("OmniFocus"),
    doc = app.defaultDocument,
    a = envelope.args;
  function fail(code, message) {
    const e = Error(message);
    e.code = code;
    throw e;
  }
  function canonical(v) {
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
  function facts(id) {
    let t;
    try {
      t = doc.flattenedTags.byId(id);
      if (t.id() !== id) return null;
    } catch (_) {
      return null;
    }
    const v = t.location();
    let location = null,
      native_unset = null;
    if (
      v &&
      Object.keys(v).length === 1 &&
      ["notify when arriving", "notify when leaving"].includes(v.trigger)
    ) {
      native_unset =
        v.trigger === "notify when arriving" ? "arrival" : "departure";
    }
    if (v !== null && native_unset === null) {
      if (
        !["notify when arriving", "notify when leaving"].includes(v.trigger) ||
        typeof v.name !== "string" ||
        typeof v.latitude !== "number" ||
        typeof v.longitude !== "number" ||
        typeof v.radius !== "number" ||
        Object.keys(v).some(
          (k) =>
            !["name", "latitude", "longitude", "radius", "trigger"].includes(k),
        )
      )
        fail(
          "UNSUPPORTED_LOCATION",
          "Location contains unverified fields/direction",
        );
      location = {
        name: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
        radius_km: v.radius,
        trigger: v.trigger === "notify when arriving" ? "arrival" : "departure",
      };
    }
    return { id, exists: true, location, native_unset };
  }
  function literal(s) {
    if (typeof s !== "string" || /[\u0000-\u001f]/.test(s))
      fail("INVALID_MUTATION", "Control characters unsupported");
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  function record(v) {
    if (v === null) return "missing value";
    return (
      "{name:" +
      literal(v.name) +
      ",latitude:" +
      v.latitude +
      ",longitude:" +
      v.longitude +
      ",radius:" +
      v.radius_km +
      ",trigger:" +
      (v.trigger === "arrival"
        ? "notify when arriving"
        : "notify when leaving") +
      "}"
    );
  }
  try {
    if (envelope.op === "location_facts")
      return JSON.stringify({
        request_id: envelope.request_id,
        result: { reference: a.reference, facts: facts(a.reference.id) },
      });
    const req = a.request,
      ref = req.items[0].targets[0],
      receipt = {
        request_key: req.request_key,
        input_hash: a.input_hash,
        finished: true,
        setter_count: 0,
        resource_id: ref.id,
        error: null,
      };
    try {
      const item = req.items[0],
        f = facts(ref.id);
      if (
        req.operation.kind !== "tag.set_location" ||
        req.operation.version !== 1 ||
        req.items.length !== 1 ||
        item.targets.length !== 1 ||
        item.references.length ||
        ref.entity !== "tag" ||
        !a.authorized_tag_ids.includes(ref.id) ||
        !f
      )
        fail(
          "WRITE_NOT_AUTHORIZED",
          "Exact host tag location authority required",
        );
      const pre = item.preconditions.concat(a.plan.items[0].preconditions);
      if (
        !pre.length ||
        pre.some(
          (p) =>
            p.reference.entity !== "tag" ||
            p.reference.id !== ref.id ||
            p.field !== "snapshot" ||
            canonical(p.expected) !== canonical(f),
        )
      )
        fail("PRECONDITION_CONFLICT", "Tag location changed");
      const desired = item.changes.location;
      let check =
        f.native_unset !== null
          ? "if observedLocation is not {trigger:" +
            (f.native_unset === "arrival"
              ? "notify when arriving"
              : "notify when leaving") +
            '} then return "conflict"'
          : f.location === null
            ? 'if observedLocation is not missing value then return "conflict"'
            : 'if observedLocation is missing value then return "conflict"\nif name of observedLocation is not ' +
              literal(f.location.name) +
              " or latitude of observedLocation is not " +
              f.location.latitude +
              " or longitude of observedLocation is not " +
              f.location.longitude +
              " or radius of observedLocation is not " +
              f.location.radius_km +
              " or trigger of observedLocation is not " +
              (f.location.trigger === "arrival"
                ? "notify when arriving"
                : "notify when leaving") +
              ' then return "conflict"';
      const script =
        'tell application "OmniFocus"\ntell default document\nset ownedTag to tag id ' +
        literal(ref.id) +
        "\nif id of ownedTag is not " +
        literal(ref.id) +
        ' then return "conflict"\nset observedLocation to location of ownedTag\n' +
        check +
        "\nset location of ownedTag to " +
        record(desired) +
        '\nreturn "applied"\nend tell\nend tell';
      const nativeScript = $.NSAppleScript.alloc.initWithSource(script),
        err = $();
      receipt.setter_count = 1;
      const result = nativeScript.executeAndReturnError(err);
      const ack = ObjC.unwrap(result.stringValue);
      if (ack === "conflict") {
        receipt.setter_count = 0;
        fail(
          "PRECONDITION_CONFLICT",
          "Tag location changed at native setter boundary",
        );
      }
      if (ack !== "applied")
        fail(
          "NATIVE_LOCATION_UNCERTAIN",
          "Location setter acknowledgement unavailable",
        );
    } catch (e) {
      receipt.error = {
        code: e.code || "NATIVE_LOCATION_UNCERTAIN",
        message: e.code
          ? e.message
          : "Location setter failed; independently reconcile",
      };
    }
    return JSON.stringify({ request_id: envelope.request_id, result: receipt });
  } catch (e) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: e.code || "NATIVE_UNAVAILABLE",
        message: e.code ? e.message : "Native tag location unavailable",
      },
    });
  }
}
