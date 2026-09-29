// Frozen v1 selection weight. Retain the historical packing thresholds across
// transports: raw JSON bytes plus JSON-string escaping cost, with a fixed reserve.
// This is a domain packing policy, not an adapter's actual encoded response size.
// Do not enlarge native pages when changing transport presentation. Adapters must
// independently check their complete encoding against RESPONSE_BYTES.
export function packingCost(
  data: Record<string, unknown>,
  failed = false,
): number {
  const json = JSON.stringify(data);
  const reserve = failed ? 73 : 58;
  return (
    Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(json)) + reserve
  );
}
