// JXA launcher. The operation file is shipped with this server; argv[1] is data.
ObjC.import("Foundation");
function run(argv) {
  var envelope = JSON.parse(argv[1]);
  var of = Application("OmniFocus");
  if (!of.running()) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: "NOT_RUNNING",
        message: "OmniFocus must already be running.",
      },
    });
  }
  var source = ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError(
      ["task_write_facts", "task_write_apply"].includes(envelope.op)
        ? argv[0].replace(/operation\.js$/, "task-operation.js")
        : argv[0],
      $.NSUTF8StringEncoding,
      null,
    ),
  );
  if (typeof source !== "string") throw new Error("Missing native operation");
  function evaluate(request) {
    var literal = JSON.stringify(JSON.stringify(request))
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    return of.evaluateJavascript(
      "(" + source + ")(JSON.parse(" + literal + "))",
    );
  }
  var getters = {
    direct_task_count: "numberOfTasks",
    direct_completed_task_count: "numberOfCompletedTasks",
    review_interval: "reviewInterval",
  };
  // Prepare a byte-bounded base page, fetch its selected supplement columns,
  // then finish those records with the same mapper in the same deadline.
  if (envelope.op === "query" && envelope.args.entity === "project") {
    var columns = envelope.args.fields.filter(function (field) {
      return Object.prototype.hasOwnProperty.call(getters, field);
    });
    if (columns.length) {
      var planned = JSON.parse(
        evaluate({
          request_id: envelope.request_id,
          op: "project_select",
          args: envelope.args,
        }),
      );
      if (planned.error) return JSON.stringify(planned);
      envelope.args.selection = planned.result;
      var ids = planned.result.keys.map(function (k) {
        return k.id;
      });
      var batch = Object.create(null);
      ids.forEach(function (id) {
        batch[id] = { id: id, values: {}, unavailable: {} };
      });
      if (ids.length) {
        try {
          var collection = of.defaultDocument.flattenedProjects.whose({
            _or: ids.map(function (id) {
              return { id: id };
            }),
          });
          // Columns belong to this SAME bounded native selection. Guard its ID
          // sequence before/after reads; never align OmniJS and JXA collections.
          var before = collection.id();
          if (
            before.length !== ids.length ||
            new Set(before).size !== ids.length ||
            before.some(function (id) {
              return !Object.prototype.hasOwnProperty.call(batch, id);
            })
          )
            throw Error("Membership changed");
          columns.forEach(function (field) {
            try {
              var values = collection[getters[field]]();
              var after = collection.id();
              if (
                values.length !== before.length ||
                JSON.stringify(after) !== JSON.stringify(before)
              )
                throw Error("Association changed");
              before.forEach(function (id, i) {
                batch[id].values[field] = values[i];
              });
            } catch (_) {
              ids.forEach(function (id) {
                batch[id].unavailable[field] = true;
              });
            }
          });
        } catch (_) {
          ids.forEach(function (id) {
            columns.forEach(function (field) {
              batch[id].unavailable[field] = true;
            });
          });
        }
      }
      envelope.args.project_supplements = batch;
    }
  }
  // Native direct-child counters and review fixed are not exposed by OmniJS.
  // Resolve only requested IDs, and never materialize child records or full properties.
  if (envelope.op === "get" && envelope.args.entity === "project") {
    var selected = envelope.args.fields.filter(function (field) {
      return Object.prototype.hasOwnProperty.call(getters, field);
    });
    if (selected.length) {
      var supplements = Object.create(null);
      envelope.args.ids.forEach(function (id) {
        if (Object.prototype.hasOwnProperty.call(supplements, id)) return;
        var row = { id: id, values: {}, unavailable: {} };
        supplements[id] = row;
        try {
          var p = of.defaultDocument.flattenedProjects.byId(id);
          row.id = p.id(); // Associate native results by persistent ID, never by position.
          if (row.id !== id) throw new Error("Supplement ID mismatch");
          selected.forEach(function (field) {
            try {
              row.values[field] = p[getters[field]]();
            } catch (_) {
              row.unavailable[field] = true;
            }
          });
        } catch (_) {
          selected.forEach(function (field) {
            row.unavailable[field] = true;
          });
        }
      });
      envelope.args.project_supplements = supplements;
    }
  }
  return evaluate(envelope);
}
