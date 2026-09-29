// NATIVE-ALGORITHM DOUBLE: plain JS records only; no OmniFocus/osascript access.
import { MutationBoundary } from "../dist/mutation.js";
import { MutationJournal } from "../dist/mutation-journal.js";
import { MutationError } from "../dist/mutation-contract.js";
export const operation = { kind: "test.scalar", version: 1 };
export const ref = (id = "a") => ({ entity: "test-object", id });
export const request = (key = "key", ids = ["a"]) => ({
  operation,
  request_key: key,
  items: ids.map((id) => ({
    item_key: id,
    targets: [ref(id)],
    references: [],
    changes: { value: 2 },
    preconditions: [{ reference: ref(id), field: "value", expected: 1 }],
    payload: null,
  })),
});
export function fixture(directory, options = {}) {
  const events = [],
    objects = new Map([
      ["a", { value: 1 }],
      ["b", { value: 1 }],
    ]);
  let setterCalls = 0,
    readbackCalls = 0;
  const reader = {
    async resolve(reference) {
      events.push(`resolve:${reference.id}`);
      const facts = objects.get(reference.id);
      return facts ? { reference, facts: { ...facts } } : null;
    },
    async readFact(fact) {
      events.push(`fact:${fact.reference.id}`);
      return objects.get(fact.reference.id)?.[fact.field] ?? null;
    },
    async readback(req) {
      readbackCalls++;
      events.push("readback");
      if (options.readback) return options.readback(req, objects);
      return {
        settled: true,
        items: req.items.map((i) => ({
          item_key: i.item_key,
          all_postconditions:
            objects.get(i.targets[0].id)?.value === i.changes.value,
          some_effects: false,
          evidence: ["independent double read"],
        })),
      };
    },
  };
  const planner = {
    operation,
    validate(item) {
      events.push(`validate:${item.item_key}`);
      if (
        Object.keys(item.changes).join(",") !== "value" ||
        typeof item.changes.value !== "number"
      )
        throw new MutationError(
          "INVALID_MUTATION",
          "Unsupported double field/value",
        );
      return {
        item_key: item.item_key,
        preconditions: [],
        predicted_changes: item.changes,
        payload: null,
      };
    },
  };
  const writer = {
    async apply(req) {
      setterCalls++;
      events.push("setter");
      if (options.setter) return options.setter(req, objects);
      for (const item of req.items)
        objects.get(item.targets[0].id).value = item.changes.value;
    },
  };
  const journal = options.journal ?? new MutationJournal(directory);
  const boundary = new MutationBoundary(
    planner,
    reader,
    writer,
    journal,
    options.auth ?? { mode: "apply-authorized" },
    options.checkpoint,
  );
  return {
    boundary,
    reader,
    writer,
    planner,
    journal,
    objects,
    events,
    get setterCalls() {
      return setterCalls;
    },
    get readbackCalls() {
      return readbackCalls;
    },
  };
}
