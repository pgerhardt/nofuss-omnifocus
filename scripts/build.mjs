import {
  cpSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
cpSync("src/native", "dist/native", { recursive: true });
const hash = createHash("sha256");
for (const f of readdirSync("src", { recursive: true })
  .filter((f) => /\.(ts|js)$/.test(f))
  .sort()) {
  hash.update(f).update(readFileSync("src/" + f));
}
hash.update(readFileSync("package-lock.json"));
let revision = null,
  dirty = true;
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
  dirty =
    execFileSync("git", ["status", "--porcelain"]).toString().trim() !== "";
} catch {
  /* Uncommitted bootstrap builds have no revision. */
}
writeFileSync(
  "dist/build.json",
  JSON.stringify(
    {
      name: "NoFuss for OmniFocus",
      version: JSON.parse(readFileSync("package.json")).version,
      source_revision: revision,
      dirty,
      source_sha256: hash.digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
chmodSync("dist/index.js", 0o755);
chmodSync("dist/cli.js", 0o755);
