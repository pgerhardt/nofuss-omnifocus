import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { ReadError } from "./contract.js";
import { stateDirectory } from "./mutation-journal.js";
const Policy = z
  .object({
    schema_version: z.literal(1),
    read_roots: z.array(z.string()).max(20),
  })
  .strict();
// Filesystem authority is separate from object mutation authority. No default roots.
export async function readAttachmentFile(
  path: string,
  directory = stateDirectory(),
) {
  const deny = () =>
    new ReadError(
      "ATTACHMENT_PATH_DENIED",
      "Attachment file is outside explicit host filesystem authority.",
    );
  if (!isAbsolute(path)) throw deny();
  const dir = await lstat(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid?.() ||
    (dir.mode & 0o777) !== 0o700
  )
    throw deny();
  const policyFile = await open(
    join(directory, "attachment-authorization.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let policy;
  try {
    const stat = await policyFile.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    )
      throw deny();
    policy = Policy.parse(JSON.parse(await policyFile.readFile("utf8")));
  } finally {
    await policyFile.close();
  }
  const resolved = await realpath(path);
  let allowed = false;
  for (const root of policy.read_roots) {
    if (!isAbsolute(root)) throw deny();
    const actualRoot = await realpath(root);
    // Broad or private system/home roots are never accepted, even by configuration.
    if (
      [
        "/",
        "/Users",
        homedir(),
        "/System",
        "/Library",
        "/private",
        "/etc",
        "/var",
      ].includes(actualRoot) ||
      /\/(?:\.ssh|\.gnupg|Library)(?:\/|$)/.test(actualRoot)
    )
      throw deny();
    const rel = relative(actualRoot, resolved);
    if (rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))
      allowed = true;
  }
  if (!allowed) throw deny();
  const fd = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > 16384)
      throw new ReadError(
        "UNSUPPORTED_ATTACHMENT",
        "Only regular files up to 16384 bytes are supported.",
      );
    // Compare opened inode with freshly resolved approved path; never read a renamed escape.
    const current = await lstat(await realpath(path));
    if (
      (await realpath(path)) !== resolved ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw deny();
    const data = Buffer.alloc(16385);
    const { bytesRead } = await fd.read(data, 0, data.length, 0);
    const after = await fd.stat();
    if (
      bytesRead > 16384 ||
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new ReadError(
        "ATTACHMENT_FILE_CHANGED",
        "Attachment file changed during bounded read.",
      );
    return data.subarray(0, bytesRead).toString("base64");
  } finally {
    await fd.close();
  }
}
