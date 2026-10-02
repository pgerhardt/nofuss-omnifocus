// Test-only adapter preload; never a production executor switch.
import { NativeWorker } from "../dist/worker.js";
export const reader = {
  run: async (op, a) => {
    const now = "2026-10-01T12:00:00.000Z";
    if (op === "attachment_facts")
      return {
        reference: a.reference,
        facts: {
          id: a.reference.id,
          exists: true,
          project_id: null,
          items: [],
        },
      };
    if (op === "sync_facts")
      return {
        document_id: "doc",
        syncing: false,
        last_sync_date: null,
        last_sync_error: null,
        unavailable: [],
        observed_at: now,
        sync_completion: "unavailable",
        last_attempted_sync: "unavailable",
        last_successful_sync: "unavailable",
        pending_local_changes: "unavailable",
        remote_acknowledgement: "unavailable",
      };
    if (op === "location_facts")
      return {
        reference: a.reference,
        facts: {
          id: a.reference.id,
          exists: true,
          location: null,
          native_unset: null,
        },
      };
    if (op === "plugin_list")
      return {
        plugins: [
          {
            identifier: "plugin",
            name: "Plugin",
            version: "1",
            actions: [{ identifier: "action", label: "Action" }],
          },
        ],
        invocation: "intentionally_excluded",
        observed_at: now,
      };
    if (op === "outline_export")
      return {
        project_id: a.project_id,
        root_id: a.project_id,
        data: "- exported\n",
        rows: [
          {
            id: a.project_id,
            parent_id: null,
            name: "exported",
            note: "",
            flagged: false,
            due_at: null,
            defer_at: null,
            attachments: 0,
          },
        ],
      };
    if (op === "import_facts")
      return {
        reference: a.reference,
        facts: {
          id: a.reference.id,
          exists: true,
          active: true,
          repeat: false,
          tentative: false,
          child_ids: [],
          root_id: a.reference.id,
        },
      };
    throw Error("Unexpected operation " + op);
  },
};
NativeWorker.prototype.run = reader.run;
