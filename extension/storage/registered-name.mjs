import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sessionKey(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    removeFile(temporary);
  }
}

/**
 * Publish the registration result locally, independent of the active transport.
 * A separate lifetime marker lets an older runtime close without invalidating a
 * newer registration for the same session.
 */
export function createRegisteredNamePublisher({ dir, sessionId }) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("session id is required");
  const directory = join(dir, "registered-names");
  const key = sessionKey(sessionId);
  const owner = randomUUID();
  const path = join(directory, `${key}.json`);
  const marker = join(directory, `${key}.${owner}.active`);
  const record = { sessionId, owner, pid: process.pid, name: null };
  mkdirSync(directory, { recursive: true });
  writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  try {
    // Hide the previous run's name while this run is still connecting.
    writeAtomic(path, record);
  } catch (err) {
    removeFile(marker);
    throw err;
  }
  let closed = false;
  let publishedName = null;
  return {
    publish(name) {
      if (closed) throw new Error("registered-name publisher is closed");
      if (typeof name !== "string" || !name) throw new Error("registered name is required");
      if (name === publishedName) return;
      writeAtomic(path, { ...record, name });
      publishedName = name;
    },
    close() {
      removeFile(marker);
      closed = true;
    },
  };
}

/** One local snapshot read and a lifetime check; never contacts a transport. */
export function readRegisteredName(sessionId, { dir }) {
  const directory = join(dir, "registered-names");
  const key = sessionKey(sessionId);
  let record;
  try {
    record = JSON.parse(readFileSync(join(directory, `${key}.json`), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (
    record?.sessionId !== sessionId ||
    typeof record.name !== "string" || !record.name ||
    typeof record.owner !== "string" || !/^[a-f0-9-]{36}$/.test(record.owner) ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0
  ) return null;
  if (!existsSync(join(directory, `${key}.${record.owner}.active`))) return null;
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return null;
    if (err.code !== "EPERM") throw err;
  }
  return record.name;
}
