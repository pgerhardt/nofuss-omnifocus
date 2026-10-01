import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(
  new URL("../src/native/taxonomy-operation.js", import.meta.url),
  "utf8",
);
export function fixture() {
  const records = { tag: new Map(), folder: new Map() };
  let serial = 0;
  let setters = 0;
  const states = Object.fromEntries(
    ["Active", "OnHold", "Dropped"].map((k) => [k, { k }]),
  );
  class Node {
    constructor(entity, name, parent = null) {
      this.entity = entity;
      this.id = { primaryKey: entity + "-" + ++serial };
      this.name = name;
      this.parent = parent;
      this.added = new Date("2020-01-01Z");
      this.tags = [];
      this.folders = [];
      this.projects = [];
      this.tasks = [];
      this.childrenAreMutuallyExclusive = false;
      this.status = states.Active;
      records[entity].set(this.id.primaryKey, this);
      if (parent) parent[entity === "tag" ? "tags" : "folders"].push(this);
      setters++;
    }
    get active() {
      return this.status !== states.Dropped;
    }
    get effectiveActive() {
      return (
        this.active && (this.parent === null || this.parent.effectiveActive)
      );
    }
    get ending() {
      return { parent: this };
    }
  }
  class Tag extends Node {
    static Status = states;
    static forecastTag = null;
    static byIdentifier = (id) => records.tag.get(id) ?? null;
    constructor(name, parent) {
      super("tag", name, parent);
    }
  }
  class Folder extends Node {
    static Status = states;
    static byIdentifier = (id) => records.folder.get(id) ?? null;
    constructor(name, parent) {
      super("folder", name, parent);
    }
  }
  function move(values, position) {
    for (const value of values) {
      if (value.parent) {
        const siblings =
          value.parent[value.entity === "tag" ? "tags" : "folders"];
        siblings.splice(siblings.indexOf(value), 1);
      }
      value.parent = position.parent;
      if (value.parent)
        value.parent[value.entity === "tag" ? "tags" : "folders"].push(value);
      setters++;
    }
  }
  const native = {
    run: async (op, args) => {
      const r = JSON.parse(
        vm.runInNewContext(
          "(" +
            source +
            ")(" +
            JSON.stringify({ op, args, request_id: "x" }) +
            ")",
          {
            Tag,
            Folder,
            tags: { ending: { parent: null } },
            library: { ending: { parent: null } },
            moveTags: move,
            moveSections: move,
          },
        ),
      );
      if (r.error) throw Object.assign(Error(r.error.message), r.error);
      return r.result;
    },
  };
  const core = {
    get: async ({ entity, ids }) => ({
      results: await Promise.all(
        ids.map(async (id) => ({
          [entity]: (
            await native.run("taxonomy_write_facts", {
              reference: { entity, id },
            })
          ).facts,
        })),
      ),
    }),
  };
  return {
    Tag,
    Folder,
    native,
    core,
    records,
    get setters() {
      return setters;
    },
  };
}
