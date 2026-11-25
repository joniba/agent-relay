import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const defaultFs = { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync };
const LEASE_MS = 15_000;
const REFRESH_MS = 5_000;

function sessionKey(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex");
}

function removeFile(fs, path) {
  try {
    fs.unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function writeAtomic(fs, path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path);
  } finally {
    removeFile(fs, temporary);
  }
}

/**
 * Publish the registration result locally, independent of the active transport.
 * The current-owner pointer changes only at startup. Each runtime updates and
 * removes only its own snapshot, so delayed callbacks cannot overwrite a newer
 * runtime's identity. A refreshed lease bounds stale state after a crash or an
 * invalidation failure, without relying on process-id uniqueness.
 */
export function createRegisteredNamePublisher({ dir, sessionId, log = () => {}, deps = {} }) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("session id is required");
  const fs = deps.fs ?? defaultFs;
  const now = deps.now ?? Date.now;
  const schedule = deps.setInterval ?? setInterval;
  const cancel = deps.clearInterval ?? clearInterval;
  const directory = join(dir, "registered-names");
  const key = sessionKey(sessionId);
  const owner = randomUUID();
  const path = join(directory, `${key}.${owner}.json`);
  const pointer = join(directory, `${key}.current`);
  const record = { sessionId, owner, pid: process.pid };
  fs.mkdirSync(directory, { recursive: true });
  try {
    // Hide the previous run's name while this run is still connecting.
    writeAtomic(fs, path, { ...record, name: null, expiresAt: now() + LEASE_MS });
    writeAtomic(fs, pointer, owner);
  } catch (err) {
    removeFile(fs, path);
    throw err;
  }
  let closed = false;
  let desiredName = null;

  function writeName() {
    try {
      writeAtomic(fs, path, { ...record, name: desiredName, expiresAt: now() + LEASE_MS });
    } catch (err) {
      // Do not leave a previous alias displayable after registration changed it.
      try {
        removeFile(fs, path);
      } catch (invalidationError) {
        throw new AggregateError([err, invalidationError], "statusline name write and invalidation failed");
      }
      throw err;
    }
  }

  const timer = schedule(() => {
    if (closed || desiredName === null) return;
    try {
      writeName();
    } catch (err) {
      try {
        log(`agent-relay: could not refresh registered statusline name: ${(err && err.message) || String(err)}`, {
          level: "warning",
        });
      } catch {
        // A failed status display or diagnostic must never take down messaging.
      }
    }
  }, REFRESH_MS);
  timer.unref?.();

  return {
    publish(name) {
      if (closed) throw new Error("registered-name publisher is closed");
      if (typeof name !== "string" || !name) throw new Error("registered name is required");
      if (name === desiredName) return;
      desiredName = name;
      writeName();
    },
    close() {
      closed = true;
      cancel(timer);
      removeFile(fs, path);
    },
  };
}

/** Two small local reads and lifetime checks; never contacts a transport. */
export function readRegisteredName(sessionId, { dir, now = Date.now }) {
  const directory = join(dir, "registered-names");
  const key = sessionKey(sessionId);
  let record;
  try {
    const owner = JSON.parse(readFileSync(join(directory, `${key}.current`), "utf8"));
    if (typeof owner !== "string" || !/^[a-f0-9-]{36}$/.test(owner)) return null;
    record = JSON.parse(readFileSync(join(directory, `${key}.${owner}.json`), "utf8"));
    if (record?.owner !== owner) return null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (
    record?.sessionId !== sessionId ||
    typeof record.name !== "string" || !record.name ||
    !Number.isFinite(record.expiresAt) || record.expiresAt <= now() ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0
  ) return null;
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return null;
    if (err.code !== "EPERM") throw err;
  }
  return record.name;
}
