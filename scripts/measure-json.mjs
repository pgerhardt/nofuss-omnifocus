// Estimates serialized artifacts only; never claims provider or workflow usage.
import { readFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";
const encoding = getEncoding("o200k_base");
for (const path of process.argv.slice(2)) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const measure = (data) => {
    const json = JSON.stringify(data);
    return {
      bytes: Buffer.byteLength(json),
      estimated_tokens: encoding.encode(json, [], []).length,
    };
  };
  const result = {
    file: path,
    tokenizer: "js-tiktoken 1.0.21 / o200k_base",
    serialized_result: measure(value),
  };
  if (value.structuredContent)
    result.single_payload = measure(value.structuredContent);
  process.stdout.write(JSON.stringify(result) + "\n");
}
