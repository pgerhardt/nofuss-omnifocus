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
      [
        "perspective_write_facts",
        "perspective_write_validate",
        "perspective_write_apply",
      ].includes(envelope.op)
        ? argv[0].replace(/operation\.js$/, "perspective-operation.js")
        : [
              "container_lifecycle_facts",
              "container_lifecycle_apply",
              "container_lifecycle_absence",
              "container_lifecycle_order",
            ].includes(envelope.op)
          ? argv[0].replace(
              /operation\.js$/,
              "container-lifecycle-operation.js",
            )
          : [
                "task_hierarchy_facts",
                "task_hierarchy_apply",
                "task_hierarchy_absence",
                "task_hierarchy_order",
              ].includes(envelope.op)
            ? argv[0].replace(/operation\.js$/, "task-hierarchy-operation.js")
            : ["task_write_facts", "task_write_apply"].includes(envelope.op)
              ? argv[0].replace(/operation\.js$/, "task-operation.js")
              : ["project_write_facts", "project_write_apply"].includes(
                    envelope.op,
                  )
                ? argv[0].replace(/operation\.js$/, "project-operation.js")
                : ["taxonomy_write_facts", "taxonomy_write_apply"].includes(
                      envelope.op,
                    )
                  ? argv[0].replace(/operation\.js$/, "taxonomy-operation.js")
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
  if (
    envelope.op === "perspective_write_apply" &&
    envelope.args.request.operation.kind === "perspective.create"
  ) {
    var checked = JSON.parse(
      evaluate({
        request_id: envelope.request_id,
        op: "perspective_write_validate",
        args: envelope.args,
      }),
    );
    if (checked.error)
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          request_key: envelope.args.request.request_key,
          input_hash: envelope.args.input_hash,
          finished: true,
          setter_count: 0,
          perspective_id: null,
          rolled_back: false,
          error: checked.error,
        },
      });
    try {
      var created = of.defaultDocument.make({
        new: "perspective",
        withProperties: { name: envelope.args.request.items[0].changes.name },
      });
      envelope.args.created_id = created.id();
    } catch (_) {
      // Constructor dispatch may have started; no guessed identity or automatic replay.
      return JSON.stringify({
        request_id: envelope.request_id,
        result: {
          request_key: envelope.args.request.request_key,
          input_hash: envelope.args.input_hash,
          finished: true,
          setter_count: 1,
          perspective_id: null,
          rolled_back: false,
          error: {
            code: "NATIVE_CREATE_UNCERTAIN",
            message:
              "Constructor outcome/identity unknown; independently reconcile",
          },
        },
      });
    }
    return evaluate(envelope);
  }
  // Exact review records require the scripting fixed flag omitted by OmniJS.
  // No user script is evaluated; source above is the shipped project operation.
  var review =
    envelope.args.review_interval === true &&
    ["project_write_facts", "project_write_apply"].includes(envelope.op);
  if (review) {
    var reference =
      envelope.op === "project_write_facts"
        ? envelope.args.reference
        : envelope.args.request.items[0].targets[0];
    var nativeBase = JSON.parse(
      evaluate({
        request_id: envelope.request_id,
        op: "project_write_facts",
        args: { reference: reference },
      }),
    );
    if (nativeBase.error || !nativeBase.result.facts)
      return JSON.stringify(nativeBase);
    var reviewProject = of.defaultDocument.flattenedProjects.byId(reference.id);
    if (reviewProject.id() !== reference.id)
      throw new Error("Review exact ID mismatch");
    var currentReview = reviewProject.reviewInterval();
    envelope.args.review_interval_value = {
      id: reference.id,
      unit: currentReview.unit,
      steps: currentReview.steps,
      fixed: currentReview.fixed,
    };
    if (
      envelope.op === "project_write_apply" &&
      envelope.args.request.operation.kind === "project.set_review_interval"
    ) {
      var preflight = JSON.parse(
        evaluate({
          request_id: envelope.request_id,
          op: "project_review_preflight",
          args: envelope.args,
        }),
      );
      if (preflight.error || preflight.result.error)
        return JSON.stringify(preflight);
      var receipt = preflight.result;
      try {
        var baseline =
          envelope.args.plan.items[0].payload.baseline.review_interval;
        var units = {
          days: "day",
          weeks: "week",
          months: "month",
          years: "year",
        };
        var observed = reviewProject.reviewInterval();
        if (
          reviewProject.id() !== reference.id ||
          units[baseline.unit] !== observed.unit ||
          baseline.steps !== observed.steps ||
          baseline.fixed !== observed.fixed
        ) {
          receipt.error = {
            code: "PRECONDITION_CONFLICT",
            message: "Review interval changed immediately before setter",
          };
        } else {
          var desired = envelope.args.request.items[0].changes.review_interval;
          receipt.setter_count++;
          reviewProject.reviewInterval = {
            unit: units[desired.unit],
            steps: desired.steps,
            fixed: desired.fixed,
          };
        }
      } catch (_) {
        receipt.error = {
          code: "NATIVE_PROJECT_WRITE_FAILED",
          message: "Review interval setter failed; independently reconcile",
        };
      }
      return JSON.stringify({
        request_id: envelope.request_id,
        result: receipt,
      });
    }
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
