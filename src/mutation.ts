import {
  MutationError,
  DENY_WRITES,
  normalize,
  inputHash,
  canonical,
  digest,
  frozen,
  mutationErrorInfo,
  Readback,
  type MutationRequest,
  type MutationResult,
  type Authorization,
  type Planner,
  type MutationReader,
  type MutationWriter,
  type Plan,
  type Resolved,
} from "./mutation-contract.js";
import {
  MutationJournal,
  type JournalRecord,
  type Lease,
} from "./mutation-journal.js";

// Deterministic interruption seams for OFFLINE / PROCESS DOUBLE tests only.
export type Checkpoint =
  | "before-prepare"
  | "after-prepared"
  | "after-lock"
  | "after-marker"
  | "after-setter"
  | "after-readback"
  | "after-finalized";
export class MutationBoundary {
  constructor(
    private planner: Planner,
    private reader: MutationReader,
    private writer: MutationWriter,
    private journal = new MutationJournal(),
    private authorization: Readonly<Authorization> = DENY_WRITES,
    private checkpoint: (point: Checkpoint) => Promise<void> = async () => {},
  ) {}
  private authorize(apply: boolean) {
    if (
      this.authorization.mode !== "apply-authorized" &&
      (apply || this.authorization.mode !== "preview-authorized")
    )
      throw new MutationError(
        "WRITE_NOT_AUTHORIZED",
        "Host policy denies this internal mutation operation.",
      );
  }
  private request(input: unknown, apply: boolean) {
    const request = frozen(normalize(input, apply));
    if (canonical(request.operation) !== canonical(this.planner.operation))
      throw new MutationError(
        "INVALID_MUTATION",
        "Unsupported operation kind/version.",
      );
    return request;
  }
  private async preconditions(plan: Plan) {
    for (const item of plan.items)
      for (const fact of item.preconditions) {
        if (
          canonical(await this.reader.readFact(fact)) !==
          canonical(fact.expected)
        )
          throw new MutationError(
            "PRECONDITION_CONFLICT",
            "An exact native precondition no longer matches.",
          );
      }
  }
  private async plan(request: MutationRequest): Promise<Plan> {
    const resolved: Resolved[] = [];
    // Resolve ALL references first; no native objects cross this port.
    for (const item of request.items)
      for (const reference of [...item.targets, ...item.references]) {
        if (
          resolved.some((r) => canonical(r.reference) === canonical(reference))
        )
          continue;
        const value = await this.reader.resolve(reference);
        if (!value || canonical(value.reference) !== canonical(reference))
          throw new MutationError(
            "INVALID_MUTATION",
            "Exact referenced ID is absent or has the wrong entity type.",
          );
        resolved.push(frozen(JSON.parse(canonical(value)) as Resolved));
      }
    const items = request.items.map((item) => {
      const planned = this.planner.validate(item, frozen(resolved));
      if (planned.item_key !== item.item_key)
        throw new MutationError(
          "INVALID_MUTATION",
          "Planner item association failed.",
        );
      // Caller preconditions cannot be weakened by an operation planner.
      planned.preconditions = [...item.preconditions, ...planned.preconditions];
      for (const fact of planned.preconditions)
        if (
          ![...item.targets, ...item.references].some(
            (ref) => canonical(ref) === canonical(fact.reference),
          )
        )
          throw new MutationError(
            "INVALID_MUTATION",
            "Planner added an undeclared reference.",
          );
      return planned;
    });
    const plan = frozen(JSON.parse(canonical({ items })) as Plan);
    await this.preconditions(plan);
    return plan;
  }
  async preview(input: unknown): Promise<{ input_hash: string; plan: Plan }> {
    this.authorize(false);
    const request = this.request(input, false);
    return { input_hash: inputHash(request), plan: await this.plan(request) };
  }
  private checkHash(record: JournalRecord, request: MutationRequest) {
    if (record.input_hash !== inputHash(request))
      throw new MutationError(
        "REQUEST_KEY_REUSE_MISMATCH",
        "request_key already identifies different normalized mutation meaning.",
      );
  }
  private result(
    request: MutationRequest,
    outcome: "rejected" | "conflict" | "unknown",
    error: unknown,
  ): MutationResult {
    return {
      request_key: request.request_key!,
      input_hash: inputHash(request),
      items: request.items.map((i) => ({
        item_key: i.item_key,
        outcome,
        evidence: [],
      })),
      error: mutationErrorInfo(error),
      reconciliation_required: outcome === "unknown",
    };
  }
  private async observe(record: JournalRecord): Promise<MutationResult> {
    try {
      const readback = Readback.parse(
        await this.reader.readback(
          frozen(record.request),
          frozen(record.plan as Plan),
          record.native_receipt,
        ),
      );
      if (
        canonical(readback.items.map((i) => i.item_key)) !==
        canonical(record.request.items.map((i) => i.item_key))
      )
        throw new Error("Readback association failed");
      const items = readback.items.map((item) => ({
        item_key: item.item_key,
        ...(item.resource ? { resource: item.resource } : {}),
        outcome:
          readback.settled && readback.not_attempted
            ? readback.not_attempted
            : readback.settled && item.all_postconditions
              ? ("applied" as const)
              : item.some_effects
                ? ("partial" as const)
                : ("unknown" as const),
        evidence: item.evidence,
      }));
      return {
        request_key: record.request_key,
        input_hash: record.input_hash,
        ...(readback.error ? { error: readback.error } : {}),
        items,
        reconciliation_required:
          !readback.settled || items.some((i) => i.outcome === "unknown"),
      };
    } catch {
      return this.result(
        record.request,
        "unknown",
        new MutationError(
          "MUTATION_RECONCILIATION_REQUIRED",
          "Independent readback unavailable/invalid; mutation may still execute. Never replay.",
        ),
      );
    }
  }
  // Read-only operator inspection works even with a crashed holder's lock.
  // It never deletes a lock, updates a record, or replays a setter.
  async reconcile(input: unknown): Promise<{
    record: JournalRecord;
    observed: MutationResult;
    lock: Lease | null;
  }> {
    this.authorize(false);
    const request = this.request(input, true);
    const record = await this.journal.read(request.request_key!);
    if (!record)
      throw new MutationError(
        "MUTATION_RECONCILIATION_REQUIRED",
        "No durable request exists.",
      );
    this.checkHash(record, request);
    return {
      record,
      observed:
        record.lifecycle === "finalized"
          ? record.result!
          : record.mutation_may_have_begun
            ? await this.observe(record)
            : this.result(
                request,
                "rejected",
                new MutationError(
                  "MUTATION_RECONCILIATION_REQUIRED",
                  "Prepared only; no setter attempt recorded. Revalidation and lock inspection are required.",
                ),
              ),
      lock: await this.journal.inspectLock(),
    };
  }
  async apply(input: unknown): Promise<MutationResult> {
    const request = this.request(input, true);
    try {
      this.authorize(true);
    } catch (error) {
      return this.result(request, "rejected", error);
    }
    let record: JournalRecord | null = null;
    let lease: Lease | undefined;
    let mayBegin = false;
    let durable = false;
    let finishing = false;
    let finalDurable = false;
    const finish = (r: JournalRecord, result: MutationResult, lock: Lease) => {
      finishing = true;
      return this.finish(r, result, lock, () => {
        finalDurable = true;
      });
    };
    try {
      record = await this.journal.read(request.request_key!);
      if (record) {
        this.checkHash(record, request);
        if (record.lifecycle === "finalized") return record.result!;
      }
      const unresolved = record?.mutation_may_have_begun === true;
      // Reconciliation is read-only, including when the global lock is retained.
      if (unresolved) {
        mayBegin = true;
        const observed = await this.observe(record!);
        try {
          lease = await this.journal.acquire(request.request_key!);
        } catch (error) {
          return {
            ...observed,
            reconciliation_required: true,
            error: mutationErrorInfo(error),
          };
        }
        const current = await this.journal.read(request.request_key!);
        if (!current)
          throw new MutationError(
            "MUTATION_STATE_UNAVAILABLE",
            "Unresolved record disappeared.",
          );
        this.checkHash(current, request);
        if (current.lifecycle === "finalized") {
          await this.journal.release(lease);
          return current.result!;
        }
        return await finish(current, await this.observe(current), lease);
      }
      const plan = await this.plan(request);
      await this.checkpoint("before-prepare");
      record = await this.journal.prepare(request, plan);
      this.checkHash(record, request);
      await this.checkpoint("after-prepared");
      lease = await this.journal.acquire(request.request_key!);
      await this.checkpoint("after-lock");
      // Another process may have finalized/attempted this key since first read.
      record = await this.journal.read(request.request_key!);
      if (!record)
        throw new MutationError(
          "MUTATION_STATE_UNAVAILABLE",
          "Prepared record disappeared.",
        );
      this.checkHash(record, request);
      if (record.lifecycle === "finalized") {
        await this.journal.release(lease);
        lease = undefined;
        return record.result!;
      }
      if (record.mutation_may_have_begun) {
        mayBegin = true;
        return await finish(record, await this.observe(record), lease);
      }
      await this.journal.assertNoOtherUnresolved(request.request_key!);
      if (canonical(record.plan) !== canonical(plan))
        throw new MutationError(
          "PRECONDITION_CONFLICT",
          "Previously prepared plan or captured facts changed; never silently rebase a durable request.",
        );
      await this.preconditions(plan);
      record = {
        ...record,
        plan,
        precondition_hash: digest(plan.items.map((i) => i.preconditions)),
        lifecycle: "mutation-may-have-started",
        mutation_may_have_begun: true,
        updated_at: new Date().toISOString(),
      };
      // Even a failed fsync can have published this marker. From now on fail
      // conservatively and retain the lock, including if no setter was reached.
      mayBegin = true;
      await this.journal.write(record, lease);
      await this.checkpoint("after-marker");
      let setterError: unknown;
      try {
        await this.writer.apply(request, frozen(plan), async (receipt) => {
          const next = {
            ...record!,
            native_receipt: JSON.parse(canonical(receipt)),
            updated_at: new Date().toISOString(),
          };
          await this.journal.write(next, lease!);
          record = next;
        });
      } catch (error) {
        setterError = error;
      }
      await this.checkpoint("after-setter");
      const observed = await this.observe(record);
      if (setterError && observed.reconciliation_required)
        observed.error = {
          code: "MUTATION_RECONCILIATION_REQUIRED",
          message:
            "Setter response lost/failed; independent evidence is incomplete. Never replay.",
        };
      await this.checkpoint("after-readback");
      return await finish(record, observed, lease);
    } catch (error) {
      // Re-read after races, including errors before this process obtained a
      // lease. A same-key attempt may already have begun in another process.
      let latest: JournalRecord | null = null;
      try {
        latest = await this.journal.read(request.request_key!);
      } catch {
        /* fail closed */
      }
      if (latest?.input_hash === inputHash(request)) {
        if (latest.lifecycle === "finalized") {
          if (finishing && !finalDurable)
            return this.result(request, "unknown", error);
          return lease
            ? {
                ...latest.result!,
                reconciliation_required: true,
                error: mutationErrorInfo(error),
              }
            : latest.result!;
        }
        if (latest.mutation_may_have_begun) {
          mayBegin = true;
          record = latest;
          if (!lease)
            return {
              ...(await this.observe(latest)),
              reconciliation_required: true,
              error: mutationErrorInfo(error),
            };
        }
      }
      const result = this.result(
        request,
        mayBegin
          ? "unknown"
          : error instanceof MutationError &&
              error.code === "PRECONDITION_CONFLICT"
            ? "conflict"
            : "rejected",
        error,
      );
      if (lease && record) {
        try {
          // A key/hash mismatch must never replace the prior request's record.
          if (record.input_hash === inputHash(request)) {
            await this.journal.write(
              {
                ...record,
                lifecycle: mayBegin
                  ? "unresolved-needs-reconciliation"
                  : "finalized",
                mutation_may_have_begun: mayBegin,
                result,
                updated_at: new Date().toISOString(),
              },
              lease,
            );
            durable = true;
          }
          if (!mayBegin && durable) await this.journal.release(lease);
        } catch {
          /* Leave any lock and prior marker intact. */
        }
      }
      return result;
    }
  }
  private async finish(
    record: JournalRecord,
    result: MutationResult,
    lease: Lease,
    recorded: () => void,
  ): Promise<MutationResult> {
    await this.journal.write(
      {
        ...record,
        lifecycle: result.reconciliation_required
          ? "unresolved-needs-reconciliation"
          : "finalized",
        result,
        updated_at: new Date().toISOString(),
      },
      lease,
    );
    recorded();
    if (!result.reconciliation_required) {
      await this.checkpoint("after-finalized");
      await this.journal.release(lease);
    }
    return result;
  }
}
