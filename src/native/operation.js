function operation(envelope) {
  // Runs inside OmniFocus. No mutation, external getters, dynamic expressions or cache.
  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    throw e;
  }
  function present(value) {
    if (value === undefined)
      fail("NATIVE_UNAVAILABLE", "Native API did not expose this value.");
    return value;
  }
  function bool(value) {
    if (typeof value !== "boolean")
      fail("NATIVE_TYPE", "Expected native boolean.");
    return value;
  }
  function str(value) {
    if (typeof value !== "string")
      fail("NATIVE_TYPE", "Expected native string.");
    return value;
  }
  function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail("NATIVE_TYPE", "Expected native number.");
    return value;
  }
  function date(value) {
    present(value);
    return value === null ? null : value.toISOString();
  }
  function identifier(object) {
    return str(object.id.primaryKey);
  }
  function relation(object) {
    present(object);
    return object === null ? null : identifier(object);
  }
  function bytes(value) {
    // UTF-8 byte length of JSON, including escapes; no TextEncoder in OmniJS.
    var s = JSON.stringify(value),
      n = 0;
    for (var c of s) {
      var v = c.codePointAt(0);
      n += v < 128 ? 1 : v < 2048 ? 2 : v < 65536 ? 3 : 4;
    }
    return n;
  }
  function state(t) {
    var value = t.taskStatus;
    var names = [
      "Available",
      "Blocked",
      "Completed",
      "Dropped",
      "DueSoon",
      "Next",
      "Overdue",
    ];
    var publicNames = [
      "available",
      "blocked",
      "completed",
      "dropped",
      "due_soon",
      "next",
      "overdue",
    ];
    for (var i = 0; i < names.length; i++)
      if (value === Task.Status[names[i]]) return publicNames[i];
    fail("NATIVE_STATUS", "Unrecognized native task status.");
  }
  function relativeMinutes(n) {
    // Treat native relative offsets as seconds; preserve public fractional minutes.
    // Live-confirmed on 4.9.2 (188.3), despite declaration wording. This is not
    // a version gate or a claim that all native versions were live-verified.
    var seconds = number(n.relativeFireOffset),
      minutes = seconds / 60;
    if (seconds !== 0 && minutes === 0)
      fail(
        "NATIVE_NOTIFICATION_UNITS",
        "Relative notification offset underflows the public minute representation.",
      );
    return minutes; // Fractional minutes are permitted; never round to integers.
  }
  function alarm(n) {
    var kind = n.kind,
      label;
    if (kind === Task.Notification.Kind.Absolute) label = "absolute";
    else if (kind === Task.Notification.Kind.DueRelative)
      label = "due_relative";
    else
      fail(
        "NATIVE_NOTIFICATION_KIND",
        "Unknown notification kind; notification list unavailable.",
      );
    return {
      id: identifier(n),
      task_id: relation(n.task),
      kind: label,
      initial_fire_at: date(n.initialFireDate),
      next_fire_at: date(n.nextFireDate),
      absolute_fire_at: label === "absolute" ? date(n.absoluteFireDate) : null,
      relative_offset_minutes: label === "absolute" ? null : relativeMinutes(n),
      repeat_interval_seconds: number(n.repeatInterval),
      is_snoozed: bool(n.isSnoozed),
      floating_time_zone: bool(n.usesFloatingTimeZone),
    };
  }
  function projectState(p) {
    var values = [
      Project.Status.Active,
      Project.Status.OnHold,
      Project.Status.Done,
      Project.Status.Dropped,
    ];
    var names = ["active", "on_hold", "done", "dropped"];
    var index = values.indexOf(p.status);
    if (index < 0) fail("NATIVE_STATUS", "Unrecognized native project status.");
    return names[index];
  }
  function projectMatches(p, args) {
    // Predicate errors escape: unreadable is not a nonmatch. Short-circuit AND
    // avoids reading a flag once the status already proves rejection.
    return (
      (args.status === undefined || projectState(p) === args.status) &&
      (args.flagged === undefined || bool(p.flagged) === args.flagged)
    );
  }
  function record(
    t,
    fields,
    text,
    projectSupplements,
    structure,
    seed,
    collection,
  ) {
    var row = seed || { id: identifier(t) },
      nativeState;
    function status() {
      if (nativeState === undefined) nativeState = state(t);
      return nativeState;
    }
    function windowMeta(field, offset, returned, total) {
      if (!row.truncated) row.truncated = {};
      row.truncated[field] = {
        offset: offset,
        returned: returned,
        total: total,
        next_offset: offset + returned < total ? offset + returned : null,
        reason:
          field === "name" || field === "note"
            ? "text_window"
            : "collection_window",
      };
    }
    function elements(field, source, map) {
      var values = present(source),
        options = collection && collection.field === field ? collection : null;
      var total = values.length;
      // OmniJS host collections are array-like, not JavaScript Array objects.
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        typeof values.map !== "function"
      )
        fail("NATIVE_TYPE", "Expected a native collection.");
      var offset = options ? options.offset : 0,
        limit = options ? options.limit : 100;
      if (offset > total)
        fail(
          "COLLECTION_OFFSET",
          "Offset exceeds current native collection length. Restart this field traversal.",
        );
      var result = [],
        used = 2;
      for (var i = offset; i < total && result.length < limit; i++) {
        var value = map(values[i]),
          size = bytes(value) + (result.length ? 1 : 0);
        if (used + size > 14000) {
          if (!result.length)
            fail(
              "FIELD_OUTPUT_LIMIT",
              "One native element exceeds the supported typed field budget.",
            );
          break;
        }
        result.push(value);
        used += size;
      }
      if (offset || offset + result.length < total)
        windowMeta(field, offset, result.length, total);
      return result;
    }
    var readers = {
      name: function () {
        return str(t.name);
      },
      project_id: function () {
        return relation(t.containingProject);
      },
      parent_id: function () {
        return relation(t.parent);
      },
      in_inbox: function () {
        return bool(t.inInbox);
      },
      completed: function () {
        return bool(t.completed);
      },
      dropped: function () {
        return !bool(t.active);
      },
      effective_completed: function () {
        return date(t.effectiveCompletionDate) !== null;
      },
      effective_dropped: function () {
        return !bool(t.effectiveActive);
      },
      available: function () {
        return (
          ["available", "next", "due_soon", "overdue"].indexOf(status()) >= 0
        );
      },
      blocked: function () {
        return status() === "blocked";
      },
      flagged: function () {
        return bool(t.flagged);
      },
      status: status,
      note: function () {
        return str(t.noteText.string);
      },
      tag_ids: function () {
        return elements("tag_ids", t.tags, identifier);
      },
      due_at: function () {
        return date(t.dueDate);
      },
      defer_at: function () {
        return date(t.deferDate);
      },
      effective_due_at: function () {
        return date(t.effectiveDueDate);
      },
      effective_defer_at: function () {
        return date(t.effectiveDeferDate);
      },
      created_at: function () {
        return date(t.added);
      },
      modified_at: function () {
        return date(t.modified);
      },
      completed_at: function () {
        return date(t.completionDate);
      },
      dropped_at: function () {
        return date(t.dropDate);
      },
      planned_at: function () {
        return date(t.plannedDate);
      },
      estimated_minutes: function () {
        var v = present(t.estimatedMinutes);
        return v === null ? null : number(v);
      },
      sequential: function () {
        return bool(t.sequential);
      },
      completed_by_children: function () {
        return bool(t.completedByChildren);
      },
      floating_time_zone: function () {
        return bool(t.shouldUseFloatingTimeZone);
      },
      notifications: function () {
        return elements("notifications", t.notifications, alarm);
      },
    };
    if (projectSupplements) {
      function supplement(field) {
        var id = identifier(t);
        if (!Object.prototype.hasOwnProperty.call(projectSupplements, id))
          fail(
            "NATIVE_UNAVAILABLE",
            "Selected project supplement is unavailable.",
          );
        var data = projectSupplements[id];
        if (data.id !== id)
          fail("SUPPLEMENT_MISMATCH", "Project supplement ID does not match.");
        if (data.unavailable[field])
          fail(
            "NATIVE_READ_FAILED",
            "Selected project supplement failed; no empty value substituted.",
          );
        return present(data.values[field]);
      }
      function count(field) {
        var value = number(supplement(field));
        if (!Number.isSafeInteger(value) || value < 0)
          fail("NATIVE_TYPE", "Expected a nonnegative native integer count.");
        return value;
      }
      readers.status = function () {
        return projectState(t);
      };
      readers.type = function () {
        return bool(t.containsSingletonActions)
          ? "single_actions"
          : bool(t.sequential)
            ? "sequential"
            : "parallel";
      };
      readers.folder_id = function () {
        return relation(t.parentFolder);
      };
      readers.created_at = function () {
        return date(t.task.added);
      };
      readers.modified_at = function () {
        return date(t.task.modified);
      };
      readers.direct_task_count = function () {
        return count("direct_task_count");
      };
      readers.direct_completed_task_count = function () {
        return count("direct_completed_task_count");
      };
      readers.last_review_at = function () {
        return date(t.lastReviewDate);
      };
      readers.next_review_at = function () {
        return date(t.nextReviewDate);
      };
      readers.review_interval = function () {
        var value = supplement("review_interval");
        var units = {
          minute: "minutes",
          hour: "hours",
          day: "days",
          week: "weeks",
          month: "months",
          year: "years",
        };
        if (!Object.prototype.hasOwnProperty.call(units, value.unit))
          fail("NATIVE_REVIEW_UNIT", "Unrecognized native review unit.");
        var steps = number(value.steps);
        if (!Number.isSafeInteger(steps) || steps <= 0)
          fail("NATIVE_TYPE", "Expected positive native review steps.");
        return {
          unit: units[value.unit],
          steps: steps,
          fixed: bool(present(value.fixed)),
        };
      };
    }
    fields.forEach(function (field) {
      if (
        field === "id" ||
        (seed &&
          (Object.prototype.hasOwnProperty.call(seed, field) ||
            (seed.unavailable &&
              Object.prototype.hasOwnProperty.call(seed.unavailable, field))))
      )
        return;
      try {
        if (!Object.prototype.hasOwnProperty.call(readers, field))
          fail("UNSUPPORTED_FIELD", "Field not implemented.");
        var value = present(readers[field]());
        if (field === "name" || field === "note") {
          var chars = Array.from(value),
            offset = text && text.field === field ? text.offset : 0;
          var length =
            text && text.field === field
              ? text.length
              : field === "name"
                ? 512
                : 2048;
          if (offset > chars.length)
            fail(
              "TEXT_OFFSET",
              "Text offset exceeds current native text length.",
            );
          value = chars.slice(offset, offset + length).join("");
          if (offset > 0 || offset + length < chars.length) {
            windowMeta(field, offset, Array.from(value).length, chars.length);
          }
        }
        if (bytes(value) > 14000)
          fail(
            "FIELD_OUTPUT_LIMIT",
            "Selected field exceeds 14000 JSON bytes; no value returned. Request narrower fields or text windows.",
          );
        row[field] = value;
      } catch (error) {
        if (!row.unavailable) row.unavailable = {};
        row.unavailable[field] = {
          code: error.code || "NATIVE_READ_FAILED",
          reason: error.code
            ? error.message
            : "Native field read failed; no empty value substituted.",
        };
      }
    });
    // Leave room for owner-bound cursors and escaped transport encoding. Keep
    // every selected readable field; shorten only text/collection windows.
    while (bytes(row) > 16000) {
      var widest = null,
        width = 0;
      ["name", "note", "tag_ids", "notifications"].forEach(function (field) {
        if (row[field] === undefined) return;
        var values = Array.from(row[field]),
          size = bytes(row[field]);
        if (values.length > 1 && size > width) {
          widest = field;
          width = size;
        }
      });
      if (widest === null)
        fail(
          "RECORD_OUTPUT_LIMIT",
          "Native scalar record exceeds the supported typed record budget.",
        );
      var values = Array.from(row[widest]),
        previous = row.truncated && row.truncated[widest];
      var kept = values.slice(0, Math.max(1, Math.floor(values.length / 2)));
      row[widest] = typeof row[widest] === "string" ? kept.join("") : kept;
      windowMeta(
        widest,
        previous ? previous.offset : 0,
        kept.length,
        previous ? previous.total : values.length,
      );
    }
    return row;
  }
  function apiSupport() {
    var members = {},
      available = null,
      names = [
        "task_lookup",
        "project_lookup",
        "tag_lookup",
        "task_state",
        "project_traversal",
        "task_tags",
        "notifications",
        "planned_dates",
        "review_interval_fixed",
        "project_direct_counts",
      ],
      support = {
        source: "installed_omnijs_declarations",
        state: "unavailable",
        members: members,
      };
    names.forEach(function (name) {
      members[name] = "unknown";
    });
    try {
      available = typeof app.getTypeScriptDeclarations === "function";
      if (!available)
        fail(
          "INTROSPECTION_UNAVAILABLE",
          "Installed API declarations are unavailable.",
        );
      // Status-only, fresh and build-associated. No declarations leave OmniFocus,
      // no result/metadata cache, no type export on get/query/overview calls.
      var declarations = str(app.getTypeScriptDeclarations(""));
      if (!declarations.length)
        fail(
          "INTROSPECTION_UNAVAILABLE",
          "Installed API declarations are empty.",
        );
      var source = declarations
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      function section(pattern) {
        var match = source.match(pattern);
        return match ? match[1] : null;
      }
      var task = section(
          /^declare class Task(?: extends [^{]+)? \{([\s\S]*?)^\}/m,
        ),
        project = section(
          /^declare class Project(?: extends [^{]+)? \{([\s\S]*?)^\}/m,
        ),
        review = section(
          /^    class ReviewInterval(?: extends [^{]+)? \{([\s\S]*?)^    \}/m,
        );
      function check(name, text, patterns) {
        members[name] =
          text === null
            ? "unknown"
            : patterns.every(function (p) {
                  return p.test(text);
                })
              ? "declared"
              : "not_declared";
      }
      check(
        "task_lookup",
        section(/^declare namespace Task \{([\s\S]*?)^\}/m),
        [/\bfunction byIdentifier\(/],
      );
      check(
        "project_lookup",
        section(/^declare namespace Project \{([\s\S]*?)^\}/m),
        [/\bfunction byIdentifier\(/],
      );
      check("tag_lookup", section(/^declare namespace Tag \{([\s\S]*?)^\}/m), [
        /\bfunction byIdentifier\(/,
      ]);
      check("task_state", task, [
        /\btaskStatus:/,
        /\beffectiveCompletionDate:/,
      ]);
      // effectiveActive is inherited on the observed API. Inspect that one
      // declared base explicitly; this is not a general type-discovery engine.
      var active = section(
        /^declare class ActiveObject(?: extends [^{]+)? \{([\s\S]*?)^\}/m,
      );
      if (members.task_state === "declared")
        check(
          "task_state",
          /^declare class Task extends ActiveObject \{/m.test(source)
            ? active
            : task && /\beffectiveActive:/.test(task)
              ? task
              : null,
          [/\beffectiveActive:/],
        );
      check("project_traversal", project, [/\bflattenedTasks:/, /\btasks:/]);
      check("task_tags", task, [/\btags:/]);
      check("notifications", task, [/\bnotifications:/]);
      check("planned_dates", task, [/\bplannedDate:/]);
      check("review_interval_fixed", review, [/\bfixed:/]);
      check("project_direct_counts", project, [
        /\bnumberOfTasks:/,
        /\bnumberOfCompletedTasks:/,
      ]);
      support.state = "observed";
    } catch (error) {
      var unavailable = error.code === "INTROSPECTION_UNAVAILABLE";
      support.error = {
        code: unavailable ? error.code : "INTROSPECTION_FAILED",
        message: unavailable
          ? error.message
          : "Installed API introspection failed; support is unknown.",
      };
    }
    return { available: available, support: support };
  }
  function overview(evaluatedAt, options) {
    var counts = {
      inbox_unfinished: 0,
      active_projects: 0,
      review_due: 0,
      remaining_without_available_action: 0,
    };
    var unavailable = {},
      rows = [],
      used = 0,
      complete = true;
    function unavailableField(row, field, error) {
      if (!row.unavailable) row.unavailable = {};
      row.unavailable[field] = {
        code: error.code || "NATIVE_READ_FAILED",
        reason: error.code
          ? error.message
          : "Native field read failed; no empty value substituted.",
      };
    }
    // Omission performs no tag resolution or waiting scans. Resolve the whole
    // explicit scope before aggregation; an invalid ID never narrows it silently.
    var waiting = null,
      waitingTags,
      waitingSeen,
      waitingBytes = 0;
    if (options.waiting_tag_ids) {
      var tagIds = Array.from(new Set(options.waiting_tag_ids)).sort();
      tagIds.forEach(function (id) {
        var tag = present(Tag.byIdentifier(id));
        if (tag === null) {
          if (
            present(Task.byIdentifier(id)) !== null ||
            present(Project.byIdentifier(id)) !== null ||
            present(Folder.byIdentifier(id)) !== null
          )
            fail("WRONG_ENTITY", "A waiting tag ID belongs to another entity.");
          fail("TAG_NOT_FOUND", "An exact waiting tag ID was not found.");
        }
        if (identifier(tag) !== id)
          fail("NATIVE_STRUCTURE", "Waiting tag identity does not match.");
      });
      waitingTags = new Set(tagIds);
      waitingSeen = new Set();
      waiting = {
        tag_ids: tagIds,
        count: 0,
        inbox_count: 0,
        items: [],
        coverage: { returned: 0, complete: true, reason: "complete" },
      };
    }
    function waitingFailure(scope, field, error) {
      if (!waiting) return;
      unavailableField(scope, field, error);
      if (scope === waiting) scope[field] = null;
      else delete scope[field];
      waiting.count = null;
      unavailableField(waiting, "count", {
        code: "INCOMPLETE_CLASSIFICATION",
        message:
          "Waiting eligibility or tag membership is unavailable for part of the requested scope.",
      });
    }
    function matchWaiting(t, projectId, scope, field) {
      try {
        // Native per-task association only: no ancestor tag union, tag-name
        // inference, tag-subtree expansion, or available/remainingTasks caches.
        var tags = present(t.tags),
          length = tags.length,
          matches = false;
        if (!Number.isSafeInteger(length) || length < 0)
          fail("NATIVE_TYPE", "Expected a native tag collection.");
        for (var i = 0; i < length; i++)
          if (waitingTags.has(identifier(tags[i]))) {
            matches = true;
            break;
          }
        if (!matches) return;
        var id = identifier(t);
        if (
          present(t.project) !== null ||
          relation(t.containingProject) !== projectId ||
          (projectId === null &&
            (!bool(t.inInbox) || relation(t.parent) !== null)) ||
          waitingSeen.has(id)
        )
          fail("NATIVE_STRUCTURE", "Waiting task membership is inconsistent.");
        waitingSeen.add(id);
        if (scope[field] !== null && scope[field] !== undefined) scope[field]++;
        if (waiting.count !== null) waiting.count++;
        if (waiting.coverage.complete) {
          var item = { id: id, project_id: projectId },
            size = bytes(item) + 1;
          if (waitingBytes + size > 60000) {
            waiting.coverage.complete = false;
            waiting.coverage.reason = "response_bytes";
          } else {
            waiting.items.push(item);
            waitingBytes += size;
          }
        }
      } catch (error) {
        waitingFailure(scope, field, error);
      }
    }
    try {
      present(inbox).forEach(function (t) {
        if (bool(t.active) && !bool(t.completed)) {
          counts.inbox_unfinished++;
          if (waiting) matchWaiting(t, null, waiting, "inbox_count");
        }
      });
    } catch (error) {
      counts.inbox_unfinished = null;
      waitingFailure(waiting, "inbox_count", error);
      unavailable.inbox_unfinished = {
        code: error.code || "NATIVE_READ_FAILED",
        reason:
          "Unfinished Inbox-root count is unavailable; partial counts are not returned.",
      };
    }
    // Resolve membership before presentation. Unknown project status/identity
    // fails the operation, never silently omits an unreadable project.
    var projects = present(flattenedProjects)
      .filter(function (p) {
        return projectState(p) === "active";
      })
      .map(function (p) {
        return { project: p, id: identifier(p) };
      });
    projects.sort(function (a, b) {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    counts.active_projects = projects.length;
    projects.forEach(function (candidate, index) {
      if (index && candidate.id === projects[index - 1].id)
        fail(
          "NATIVE_STRUCTURE",
          "Duplicate project identity in the native library.",
        );
      var p = candidate.project,
        row = { id: candidate.id };
      try {
        row.next_review_at = date(p.nextReviewDate);
        row.review_due =
          row.next_review_at !== null && row.next_review_at <= evaluatedAt;
        if (row.review_due && counts.review_due !== null) counts.review_due++;
      } catch (error) {
        unavailableField(row, "next_review_at", error);
        unavailableField(row, "review_due", error);
        counts.review_due = null;
        unavailable.review_due = {
          code: "INCOMPLETE_CLASSIFICATION",
          reason: "At least one active project's review date is unavailable.",
        };
      }
      if (waiting) row.waiting_count = 0;
      try {
        // Native Task.Status accounts for inherited completion/drop, deferral,
        // sequential blocking and on-hold tags. Groups remain task rows; the
        // project root is excluded by the verified flattenedTasks collection.
        var tasks = present(p.flattenedTasks),
          length = tasks.length;
        if (!Number.isSafeInteger(length) || length < 0)
          fail("NATIVE_TYPE", "Expected a native descendant collection.");
        var work = "no_remaining_work",
          workError = null;
        for (var i = 0; i < length; i++) {
          var current;
          try {
            current = state(tasks[i]);
          } catch (error) {
            if (!waiting) throw error;
            // Extra waiting reads must not invalidate already proven availability.
            if (work !== "available_action" && workError === null)
              workError = error;
            waitingFailure(row, "waiting_count", error);
            continue;
          }
          if (current === "completed" || current === "dropped") continue;
          if (current !== "blocked") work = "available_action";
          else if (work !== "available_action")
            work = "remaining_without_available_action";
          if (waiting)
            matchWaiting(tasks[i], candidate.id, row, "waiting_count");
          else if (work === "available_action") break;
        }
        if (workError) throw workError;
        row.work_state = work;
        if (
          work === "remaining_without_available_action" &&
          counts.remaining_without_available_action !== null
        )
          counts.remaining_without_available_action++;
      } catch (error) {
        unavailableField(row, "work_state", error);
        waitingFailure(row, "waiting_count", error);
        counts.remaining_without_available_action = null;
        unavailable.remaining_without_available_action = {
          code: "INCOMPLETE_CLASSIFICATION",
          reason:
            "At least one active project's descendant state is unavailable.",
        };
      }
      // Counts always cover every active project. Only list presentation stops
      // at a bounded native-transport boundary. The service enforces the exact
      // domain packing budget; no 25-item preview or new pagination.
      if (complete) {
        row = record(p, ["name"], undefined, {}, undefined, row);
        var size = bytes(row) + 1;
        if (used + size > 60000) complete = false;
        else {
          rows.push(row);
          used += size;
        }
      }
    });
    var result = {
      scope: "inbox_roots_and_active_projects",
      evaluated_at: evaluatedAt,
      consistency: "live",
      counts: counts,
      projects: rows,
      coverage: {
        returned: rows.length,
        complete: complete,
        reason: complete ? "complete" : "response_bytes",
      },
    };
    if (Object.keys(unavailable).length) result.unavailable = unavailable;
    if (waiting) {
      if (waiting.count === null) {
        waiting.coverage.complete = false;
        waiting.coverage.reason = "unavailable";
      }
      waiting.coverage.returned = waiting.items.length;
      result.waiting = waiting;
    }
    return result;
  }
  function projectTree(project, options, budget) {
    var root = identifier(project.task),
      projectId = identifier(project),
      stack = [{ tasks: present(project.tasks), index: 0, parent: root }],
      seen = new Set([root]),
      seeking = options.after !== null,
      items = [],
      used = 0,
      stop = "complete";
    // Iterative native sibling preorder: no recursive depth cap, state filter,
    // global task scan, or serialization of the prefix preceding the cursor.
    while (stack.length) {
      var frame = stack[stack.length - 1];
      if (frame.index === frame.tasks.length) {
        stack.pop();
        continue;
      }
      if (!seeking && items.length >= options.limit) {
        stop = "page_limit";
        break;
      }
      var task = frame.tasks[frame.index++],
        id = identifier(task);
      if (seen.has(id))
        fail("NATIVE_STRUCTURE", "Duplicate node in native project hierarchy.");
      seen.add(id);
      if (seeking) {
        if (id === options.after.id) seeking = false;
      } else {
        var row = record(task, options.fields, undefined, undefined, true);
        if (row.parent_id !== frame.parent || row.project_id !== projectId)
          fail(
            "NATIVE_STRUCTURE",
            "Native parent or project identity is unavailable or inconsistent.",
          );
        var size = bytes(row) + 1;
        if (used + size > budget) {
          if (!items.length)
            fail(
              "RESPONSE_LIMIT",
              "Project metadata and one tree node exceed the page budget; select fewer fields.",
            );
          stop = "response_bytes";
          break;
        }
        items.push(row);
        used += size;
      }
      stack.push({ tasks: present(task.tasks), index: 0, parent: id });
    }
    if (seeking)
      fail(
        "CURSOR_STALE",
        "Cursor node is no longer in this project. Restart the traversal.",
      );
    return {
      root_id: root,
      items: items,
      returned: items.length,
      has_more: stop !== "complete",
      next_cursor: null,
      order: "native_preorder_v1",
      consistency: "live",
      stop_reason: stop,
    };
  }
  function key(t) {
    return { created_at: date(t.added), id: identifier(t) };
  }
  function compare(a, b) {
    // ISO UTC preserves all native milliseconds. Null timestamps precede dated rows.
    var av = a.created_at,
      bv = b.created_at;
    if (av !== bv) {
      if (av === null) return -1;
      if (bv === null) return 1;
      return av < bv ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  try {
    var args = envelope.args,
      result,
      readAt = new Date().toISOString();
    if (envelope.op === "status") {
      var api = apiSupport();
      result = {
        version: app.userVersion.versionString,
        build: app.buildVersion.versionString,
        api_introspection: api.available,
        api_support: api.support,
        read_at: readAt,
      };
    } else if (envelope.op === "overview") {
      result = overview(readAt, args);
    } else if (envelope.op === "get") {
      var used = 0;
      var results = args.ids.map(function (id) {
        try {
          var isProject = args.entity === "project";
          var t = isProject ? Project.byIdentifier(id) : Task.byIdentifier(id);
          if (
            t === null &&
            isProject &&
            present(Task.byIdentifier(id)) !== null
          )
            return {
              id: id,
              status: "error",
              error: {
                code: "WRONG_ENTITY",
                message: "This ID belongs to a task, not a project.",
              },
            };
          if (t === null)
            return {
              id: id,
              status: "not_found",
              error: {
                code: "NOT_FOUND",
                message: isProject
                  ? "No project has this persistent ID."
                  : "No task has this persistent ID.",
              },
            };
          present(t);
          if (!isProject && present(t.project) !== null)
            return {
              id: id,
              status: "error",
              error: {
                code: "PROJECT_ROOT_EXCLUDED",
                message:
                  "This ID is a project root, not an ordinary task. Use entity: project.",
              },
            };
          var item = { id: id, status: "ok" };
          item[isProject ? "project" : "task"] = record(
            t,
            args.fields,
            args.text,
            isProject ? args.project_supplements || {} : undefined,
            undefined,
            undefined,
            args.collection,
          );
          if (args.tree)
            item.tree = projectTree(t, args.tree, 30000 - bytes(item) - 512);
          var size = bytes(item);
          if (used + size > 30000)
            return {
              id: id,
              status: "error",
              error: {
                code: "RESPONSE_LIMIT",
                message:
                  "Retry this ID individually; batch response budget reached.",
              },
            };
          used += size;
          return item;
        } catch (error) {
          return {
            id: id,
            status: "error",
            error: {
              code: error.code || "NATIVE_READ_FAILED",
              message: error.code
                ? error.message
                : "Exact native read failed; no entity substituted.",
            },
          };
        }
      });
      result = { results: results, read_at: readAt };
    } else if (envelope.op === "query" || envelope.op === "project_select") {
      var source,
        projectQuery = args.entity === "project",
        planMore = false;
      if (projectQuery && args.scope === "library")
        source = args.selection ? [] : present(flattenedProjects);
      else if (args.scope === "inbox_roots") source = inbox;
      else if (args.scope === "project") {
        var project = present(Project.byIdentifier(args.project_id));
        if (project === null)
          fail("PROJECT_NOT_FOUND", "No project has this persistent ID.");
        // Both collections exclude the project root; filtering a group must not
        // prune its descendants from the flattened collection.
        source = present(
          args.depth === "direct" ? project.tasks : project.flattenedTasks,
        );
      } else fail("UNSUPPORTED_SCOPE", "Task query scope is not implemented.");
      var candidates = source
        .filter(function (t) {
          if (projectQuery) return projectMatches(t, args);
          return (
            bool(t.active) && (args.include_completed || !bool(t.completed))
          );
        })
        .map(function (t) {
          return {
            task: t,
            key: projectQuery
              ? { id: identifier(t), created_at: date(t.task.added) }
              : key(t),
          };
        });
      candidates.sort(function (a, b) {
        return compare(a.key, b.key);
      });
      if (args.after)
        candidates = candidates.filter(function (c) {
          return compare(c.key, args.after) > 0;
        });
      // Bound expensive supplement preparation by the byte-selected base page.
      // The final pass may trim further after adding supplements. Prefix records
      // live only in this request; later pages enumerate fresh native state.
      var selecting = envelope.op === "project_select";
      var fields = selecting
        ? args.fields.filter(function (field) {
            return (
              [
                "direct_task_count",
                "direct_completed_task_count",
                "review_interval",
              ].indexOf(field) < 0
            );
          })
        : args.fields;
      if (projectQuery && args.selection) {
        if (
          args.selection.items.length !== args.selection.keys.length ||
          args.selection.items.some(function (row, i) {
            return row.id !== args.selection.keys[i].id;
          })
        )
          fail(
            "SUPPLEMENT_MISMATCH",
            "Prepared record IDs do not match the selected keys.",
          );
        planMore = args.selection.has_more;
        candidates = args.selection.keys.map(function (k) {
          return { key: k, task: null };
        });
      }
      var items = [],
        keys = [],
        usedBytes = 0,
        stop = planMore ? args.selection.stop_reason : "complete";
      for (var i = 0; i < candidates.length; i++) {
        if (items.length >= args.limit) {
          stop = "page_limit";
          break;
        }
        if (projectQuery && args.selection) {
          var selectedProject = present(
            Project.byIdentifier(candidates[i].key.id),
          );
          if (
            selectedProject === null ||
            !projectMatches(selectedProject, args) ||
            compare(candidates[i].key, {
              id: identifier(selectedProject),
              created_at: date(selectedProject.task.added),
            }) !== 0
          )
            fail(
              "INVENTORY_CHANGED",
              "Selected project identity, predicate or sort key changed during this page. Restart the traversal.",
            );
          candidates[i].task = selectedProject;
        }
        var row = record(
            candidates[i].task,
            fields,
            undefined,
            projectQuery ? args.project_supplements || {} : undefined,
            undefined,
            args.selection ? args.selection.items[i] : undefined,
          ),
          size = bytes(row);
        if (items.length && usedBytes + size > 30000) {
          stop = "response_bytes";
          break;
        }
        items.push(row);
        keys.push(candidates[i].key);
        usedBytes += size;
      }
      result = {
        items: items,
        keys: keys,
        has_more: planMore || items.length < candidates.length,
        stop_reason: stop,
        read_at: readAt,
      };
    } else
      fail("UNSUPPORTED_OPERATION", "Native operation is not implemented.");
    return JSON.stringify({ request_id: envelope.request_id, result: result });
  } catch (error) {
    return JSON.stringify({
      request_id: envelope.request_id,
      error: {
        code: error.code || "NATIVE_READ_FAILED",
        message: error.code
          ? error.message
          : "Native operation failed; no empty result substituted.",
      },
    });
  }
}
