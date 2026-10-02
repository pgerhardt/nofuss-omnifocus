import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  link,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MutationError,
  MutationRequest,
  MutationResult,
  Fact,
  digest,
  inputHash,
  canonical,
  type Plan,
} from "./mutation-contract.js";

const PlanSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            item_key: z.string(),
            preconditions: z.array(Fact),
            predicted_changes: z.json(),
            payload: z.json(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const JournalRecord = z
  .object({
    schema_version: z.literal(1),
    request_key: z.string(),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    request: MutationRequest,
    plan: PlanSchema,
    precondition_hash: z.string(),
    lifecycle: z.enum([
      "prepared",
      "mutation-may-have-started",
      "finalized",
      "unresolved-needs-reconciliation",
    ]),
    mutation_may_have_begun: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    result: MutationResult.optional(),
    native_receipt: z.json().optional(),
  })
  .strict();
export type JournalRecord = z.infer<typeof JournalRecord>;
export type Lease = {
  schema_version: 1;
  pid: number;
  request_key: string;
  timestamp: string;
  token: string;
};
const LockSchema = z
  .object({
    schema_version: z.literal(1),
    pid: z.number().int().positive(),
    request_key: z.string(),
    timestamp: z.string().datetime(),
    token: z.string().uuid(),
  })
  .strict();
const MAX_RECORD_BYTES = 1_048_576;
export function stateDirectory(): string {
  const override = process.env.NOFUSS_STATE_DIR;
  if (override !== undefined && (!override || !override.startsWith("/")))
    throw new MutationError(
      "MUTATION_STATE_UNAVAILABLE",
      "NOFUSS_STATE_DIR must be an absolute path.",
    );
  return (
    override ??
    join(
      homedir(),
      "Library",
      "Application Support",
      "NoFuss OmniFocus",
      "mutation-state",
    )
  );
}
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const collision = (e: unknown) =>
  (e as NodeJS.ErrnoException).code === "EEXIST";
function unavailable(): never {
  throw new MutationError(
    "MUTATION_STATE_UNAVAILABLE",
    "Private durable mutation state unavailable or invalid; fail closed.",
  );
}

// One local per-user directory, shared by every cooperating CLI/MCP process.
// No stale-lock expiration. All replacements require the global lease.
export class MutationJournal {
  readonly directory: string;
  constructor(directory = stateDirectory()) {
    this.directory = resolve(directory);
  }
  private async directoryReady() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const st = await lstat(this.directory);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o700
    )
      unavailable();
  }
  private async syncDirectory() {
    const fd = await open(
      this.directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
  path(key: string) {
    return join(this.directory, `${digest(key)}.json`);
  }
  get lockPath() {
    return join(this.directory, "mutation.lock");
  }
  private async readJson(path: string): Promise<unknown | null> {
    let fd;
    try {
      fd = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if (absent(e)) return undefined;
      throw e;
    }
    try {
      const st = await fd.stat();
      if (
        !st.isFile() ||
        st.uid !== process.getuid?.() ||
        (st.mode & 0o777) !== 0o600 ||
        st.size > MAX_RECORD_BYTES
      )
        unavailable();
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await fd.readFile()),
      );
    } finally {
      await fd.close();
    }
  }
  private validate(value: unknown): JournalRecord {
    const r = JournalRecord.parse(value);
    if (
      r.request_key !== r.request.request_key ||
      r.input_hash !== inputHash(r.request) ||
      r.precondition_hash !==
        digest(r.plan.items.map((i) => i.preconditions)) ||
      canonical(r.plan.items.map((i) => i.item_key)) !==
        canonical(r.request.items.map((i) => i.item_key)) ||
      (r.lifecycle === "prepared" && (r.mutation_may_have_begun || r.result)) ||
      ([
        "mutation-may-have-started",
        "unresolved-needs-reconciliation",
      ].includes(r.lifecycle) &&
        !r.mutation_may_have_begun) ||
      (r.lifecycle === "finalized" &&
        (!r.result ||
          r.result.reconciliation_required ||
          r.result.items.some((i) => i.outcome === "unknown"))) ||
      (r.result &&
        (r.result.request_key !== r.request_key ||
          r.result.input_hash !== r.input_hash ||
          canonical(r.result.items.map((i) => i.item_key)) !==
            canonical(r.request.items.map((i) => i.item_key))))
    )
      unavailable();
    return r;
  }
  async read(key: string): Promise<JournalRecord | null> {
    try {
      await this.directoryReady();
      const value = await this.readJson(this.path(key));
      if (value === undefined) return null;
      const r = this.validate(value);
      if (r.request_key !== key) unavailable();
      return r;
    } catch {
      return unavailable();
    }
  }
  async inspectLock(): Promise<Lease | null> {
    try {
      await this.directoryReady();
      const value = await this.readJson(this.lockPath);
      return value === undefined ? null : LockSchema.parse(value);
    } catch {
      return unavailable();
    }
  }
  // Write/fsync a private temporary inode, then publish without replacement (link)
  // or atomically replace (rename). fsync the directory before acknowledging.
  private async publish(
    path: string,
    value: unknown,
    replace: boolean,
  ): Promise<boolean> {
    const encoded = canonical(value);
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) unavailable();
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const fd = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(encoded + "\n");
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      if (replace) await rename(temporary, path);
      else {
        try {
          await link(temporary, path);
        } catch (e) {
          if (collision(e)) return false;
          throw e;
        }
        await unlink(temporary);
      }
      await this.syncDirectory();
      return true;
    } finally {
      await unlink(temporary).catch((e) => {
        if (!absent(e)) throw e;
      });
    }
  }
  async prepare(request: MutationRequest, plan: Plan): Promise<JournalRecord> {
    try {
      await this.directoryReady();
      const now = new Date().toISOString();
      const record = this.validate({
        schema_version: 1,
        request_key: request.request_key!,
        input_hash: inputHash(request),
        request,
        plan,
        precondition_hash: digest(plan.items.map((i) => i.preconditions)),
        lifecycle: "prepared",
        mutation_may_have_begun: false,
        created_at: now,
        updated_at: now,
      });
      await this.publish(this.path(record.request_key), record, false);
      const saved = await this.read(record.request_key);
      if (!saved) unavailable();
      return saved;
    } catch {
      return unavailable();
    }
  }
  async acquire(key: string): Promise<Lease> {
    try {
      await this.directoryReady();
      const lease: Lease = {
        schema_version: 1,
        pid: process.pid,
        request_key: key,
        timestamp: new Date().toISOString(),
        token: randomUUID(),
      };
      if (!(await this.publish(this.lockPath, lease, false)))
        throw new MutationError(
          "MUTATION_BUSY",
          "Global mutation lock exists; inspect/reconcile it. Age never permits lock removal.",
        );
      return lease;
    } catch (e) {
      if (e instanceof MutationError) throw e;
      return unavailable();
    }
  }
  private async owns(lease: Lease) {
    if (canonical(await this.inspectLock()) !== canonical(lease)) unavailable();
  }
  async write(record: JournalRecord, lease: Lease): Promise<void> {
    try {
      await this.owns(lease);
      if (lease.request_key !== record.request_key) unavailable();
      this.validate(record);
      const previous = await this.read(record.request_key);
      if (
        !previous ||
        previous.input_hash !== record.input_hash ||
        previous.created_at !== record.created_at ||
        previous.lifecycle === "finalized" ||
        (previous.mutation_may_have_begun &&
          (!record.mutation_may_have_begun || record.lifecycle === "prepared"))
      )
        unavailable();
      await this.publish(this.path(record.request_key), record, true);
    } catch {
      unavailable();
    }
  }
  async assertNoOtherUnresolved(key: string): Promise<void> {
    try {
      await this.directoryReady();
      for (const name of await readdir(this.directory)) {
        if (
          !name.endsWith(".json") ||
          [
            "mutation-authorization.json",
            "attachment-authorization.json",
          ].includes(name)
        )
          continue;
        const record = this.validate(
          await this.readJson(join(this.directory, name)),
        );
        if (this.path(record.request_key) !== join(this.directory, name))
          unavailable();
        if (
          record.request_key !== key &&
          record.mutation_may_have_begun &&
          record.lifecycle !== "finalized"
        )
          throw new MutationError(
            "MUTATION_RECONCILIATION_REQUIRED",
            "Another request remains unresolved; no new mutation may begin.",
          );
      }
    } catch (e) {
      if (e instanceof MutationError) throw e;
      unavailable();
    }
  }
  async release(lease: Lease): Promise<void> {
    try {
      await this.owns(lease);
      await unlink(this.lockPath);
      await this.syncDirectory();
    } catch {
      unavailable();
    }
  }
}
