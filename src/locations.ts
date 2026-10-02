import { z } from "zod";
import { MutationBoundary } from "./mutation.js";
import { MutationJournal, stateDirectory } from "./mutation-journal.js";
import {
  Fact,
  inputHash,
  canonical,
  MutationError,
  type MutationRequest,
  type MutationReader,
} from "./mutation-contract.js";
import { readWritePolicy, type WritePolicy } from "./write-authorization.js";
import { parseInput, parseNative } from "./errors.js";
import { ReadError } from "./contract.js";
import type { NativeWorker } from "./worker.js";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const Location = z
  .object({
    name: z
      .string()
      .min(1)
      .max(512)
      .refine((s) => !/[\u0000-\u001f]/.test(s)),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    radius_km: z.number().finite().min(0.1).max(10),
    trigger: z.enum(["arrival", "departure"]),
  })
  .strict();
export const LocationReadInput = z.object({ tag_id: id }).strict();
export const LocationWriteInput = z
  .object({
    entity: z.literal("tag"),
    tag_id: id,
    location: Location.nullable(),
    apply: z.boolean().default(false),
    request_key: z.string().min(1).max(256).optional(),
    preconditions: z.array(Fact).max(2).default([]),
  })
  .strict();
const Snapshot = z
  .object({
    id,
    exists: z.literal(true),
    location: Location.nullable(),
    native_unset: z.enum(["arrival", "departure"]).nullable(),
  })
  .strict();
const Receipt = z
  .object({
    request_key: z.string(),
    input_hash: z.string(),
    finished: z.literal(true),
    setter_count: z.number().int().min(0).max(1),
    resource_id: id,
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .strict();
export class Locations {
  constructor(
    private native: Pick<NativeWorker, "run">,
    private directory = stateDirectory(),
  ) {}
  private async snapshot(tag_id: string) {
    const r = (await this.native.run("location_facts", {
      reference: { entity: "tag", id: tag_id },
    })) as { reference: unknown; facts: unknown };
    if (canonical(r.reference) !== canonical({ entity: "tag", id: tag_id }))
      throw new ReadError(
        "INVALID_NATIVE_OUTPUT",
        "Location target association failed",
      );
    const s = r.facts === null ? null : parseNative(Snapshot, r.facts);
    if (s && s.id !== tag_id)
      throw new ReadError("INVALID_NATIVE_OUTPUT", "Location tag ID mismatch");
    return s;
  }
  async read(input: unknown) {
    const a = parseInput(LocationReadInput, input),
      s = await this.snapshot(a.tag_id);
    if (!s) throw new ReadError("NOT_FOUND", "Exact tag absent");
    if (s.id !== a.tag_id)
      throw new ReadError("INVALID_NATIVE_OUTPUT", "Location tag ID mismatch");
    return {
      tag_id: s.id,
      location: s.location,
      location_services: "unavailable",
      permission_state: "unavailable",
      geofence_delivery: "unavailable",
      observed_at: new Date().toISOString(),
    };
  }
  async write(input: unknown) {
    const p = LocationWriteInput.safeParse(input);
    if (!p.success)
      throw new MutationError("INVALID_MUTATION", "Invalid location fields");
    const a = p.data,
      ref = { entity: "tag", id: a.tag_id };
    if (a.apply && !a.request_key)
      throw new MutationError("INVALID_MUTATION", "Apply requires request_key");
    if (
      a.preconditions.some(
        (f) =>
          canonical(f.reference) !== canonical(ref) || f.field !== "snapshot",
      )
    )
      throw new MutationError(
        "INVALID_MUTATION",
        "Exact location precondition required",
      );
    const location = a.location
      ? { ...a.location, radius_km: Math.fround(a.location.radius_km) }
      : null;
    const req: MutationRequest = {
      operation: { kind: "tag.set_location", version: 1 },
      ...(a.request_key ? { request_key: a.request_key } : {}),
      items: [
        {
          item_key: "location",
          targets: [ref],
          references: [],
          changes: { location },
          preconditions: a.preconditions,
          payload: null,
        },
      ],
    };
    const authorized = (p: WritePolicy | null) =>
        !!p?.scopes.includes("tag.set_location") && p.tag_ids.includes(ref.id),
      policy = await readWritePolicy(this.directory);
    const reader: MutationReader = {
      resolve: async (r) => {
        const s = await this.snapshot(r.id);
        return s ? { reference: r, facts: { snapshot: s } } : null;
      },
      readFact: async (f) => {
        const s = await this.snapshot(f.reference.id);
        if (!s) throw Error("Exact tag missing");
        return s;
      },
      readback: async (request, plan, raw) => {
        const receipt = Receipt.parse(raw),
          s = await this.snapshot(ref.id);
        if (
          !s ||
          s.id !== ref.id ||
          receipt.resource_id !== ref.id ||
          receipt.request_key !== request.request_key ||
          receipt.input_hash !== inputHash(request)
        )
          throw Error("Location receipt/target unavailable");
        return {
          settled: true,
          ...(receipt.setter_count === 0 && receipt.error
            ? {
                not_attempted:
                  receipt.error.code === "PRECONDITION_CONFLICT"
                    ? ("conflict" as const)
                    : ("rejected" as const),
                error: receipt.error,
              }
            : {}),
          items: [
            {
              item_key: "location",
              resource: ref,
              all_postconditions: canonical(s.location) === canonical(location),
              some_effects: canonical(s) !== canonical(plan.items[0]!.payload),
              evidence: [
                "Independent JXA exact-tag readback verifies SXA location metadata; Location Services permission/delivery not inferred",
              ],
            },
          ],
        };
      },
    };
    const b = new MutationBoundary(
      {
        operation: req.operation,
        validate: (item, resolved) => ({
          item_key: item.item_key,
          predicted_changes: { location },
          preconditions: [
            {
              reference: ref,
              field: "snapshot",
              expected: resolved[0]!.facts.snapshot!,
            },
          ],
          payload: resolved[0]!.facts.snapshot!,
        }),
      },
      reader,
      {
        apply: async (request, plan, record) => {
          const current = await readWritePolicy(this.directory);
          if (!authorized(current)) {
            await record({
              request_key: request.request_key!,
              input_hash: inputHash(request),
              finished: true,
              setter_count: 0,
              resource_id: ref.id,
              error: {
                code: "WRITE_NOT_AUTHORIZED",
                message: "Host location authority revoked",
              },
            });
            return;
          }
          await record(
            Receipt.parse(
              await this.native.run("location_apply", {
                request,
                plan,
                input_hash: inputHash(request),
                authorized_tag_ids: current!.tag_ids,
              }),
            ),
          );
        },
      },
      new MutationJournal(this.directory),
      {
        mode: a.apply
          ? authorized(policy)
            ? "apply-authorized"
            : "read-only"
          : "preview-authorized",
      },
    );
    if (a.apply) return b.apply(req);
    const preview = await b.preview(req);
    return {
      mode: "preview" as const,
      operation: "tag.set_location",
      ...preview,
      apply_input: {
        ...a,
        preconditions: preview.plan.items[0]!.preconditions,
      },
    };
  }
}
